import { z } from 'zod';
import {
  VersionApprovalConflictError, VersionApprovalNotFoundError, type VersionApprovalKey,
  type VersionApprovalStore,
} from '../../agents/version-approvals.js';
import {
  ProviderCredentialValidationError, type ProviderCredentialStorePort,
} from '../../agents/provider-credentials.js';
import { APPLICATION_AGENT_WORKFLOWS } from '../../agents/application-workflows.js';
import { createAgentSupportBundle } from '../../agents/support-bundle.js';
import { safeDefaultAgentConfigProfile } from '../../agents/config-profile-store.js';
import { discoverProviderModelCatalog } from '../../agents/agent-model-catalog.js';
import type { Express } from 'express';
import {
  asyncRoute, isCvAiStructuringRun, publicAgentQueueDiagnostics,
} from '../app-support.js';
import type { AppContext } from '../app-context.js';

export function registerAgentSetupRoutes(app: Express, ctx: AppContext): void {
  const {
    store, audit, agentApi, loadAgentConfigProfile, discoverAgentProviders, invalidateProviderDiscovery,
  } = ctx;

  app.get('/api/agents/config-profile', asyncRoute(async (_request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.json(await loadAgentConfigProfile());
  }));

  app.put('/api/agents/config-profile', asyncRoute(async (request, response) => {
    if (!agentApi.configProfiles) throw Object.assign(new Error('Agenten-Konfigurationsprofile sind nicht persistent konfiguriert.'), { statusCode: 503 });
    const payload = z.object({
      expectedUpdatedAt: z.string().datetime(), confirmed: z.literal(true), profile: z.record(z.string(), z.unknown()),
    }).strict().parse(request.body);
    let saved;
    try {
      saved = await agentApi.configProfiles.compareAndSave(payload.expectedUpdatedAt, payload.profile);
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_config_revision_conflict') {
        throw Object.assign(new Error('Das Agentenprofil wurde zwischenzeitlich geändert.'), { statusCode: 409 });
      }
      if (error instanceof Error && error.message.startsWith('agent_config_')) {
        throw Object.assign(new Error('Das Agentenprofil verletzt den versionierten Sicherheitsvertrag.'), { statusCode: 400 });
      }
      throw error;
    }
    invalidateProviderDiscovery();
    await audit!.write({
      correlationId: response.locals.correlationId, operation: 'agent.config-profile.update',
      status: 200, category: 'agent_policy_profile', occurredAt: new Date().toISOString(),
    });
    await agentApi.observability?.record({
      level: 'info', component: 'policy', operation: 'profile_update', code: 'profile_updated',
      correlationId: response.locals.correlationId,
    });
    response.setHeader('cache-control', 'no-store');
    response.json({ profile: saved, source: 'primary' });
  }));

  app.post('/api/agents/config-profile/reset', asyncRoute(async (request, response) => {
    if (!agentApi.configProfiles) throw Object.assign(new Error('Agenten-Konfigurationsprofile sind nicht persistent konfiguriert.'), { statusCode: 503 });
    z.object({ confirmed: z.literal(true) }).strict().parse(request.body);
    const profile = await agentApi.configProfiles.save(safeDefaultAgentConfigProfile());
    invalidateProviderDiscovery();
    await audit!.write({
      correlationId: response.locals.correlationId, operation: 'agent.config-profile.reset',
      status: 200, category: 'agent_policy_profile', occurredAt: new Date().toISOString(),
    });
    await agentApi.observability?.record({
      level: 'warn', component: 'policy', operation: 'profile_reset', code: 'profile_reset',
      correlationId: response.locals.correlationId,
    });
    response.setHeader('cache-control', 'no-store');
    response.json({ profile, source: 'primary' });
  }));

  app.get('/api/agents/providers', asyncRoute(async (request, response) => {
    response.json(await discoverAgentProviders(request.query.refresh === 'true'));
  }));

  const versionApprovalKeySchema = z.object({
    provider: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/),
    executable: z.string().min(1).max(1024).refine((value) => !/[\r\n\0]/.test(value)),
    runtimeTarget: z.enum(['windows', 'wsl', 'linux', 'darwin']),
    distribution: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
    version: z.string().min(1).max(120).refine((value) => Boolean(value.trim()) && !/[\r\n\0]/.test(value)),
  }).strict();

  const requireVersionApprovals = (): VersionApprovalStore => {
    if (!agentApi.versionApprovals) {
      throw Object.assign(new Error('Lokale Versionsfreigaben sind nicht konfiguriert.'), { statusCode: 503 });
    }
    return agentApi.versionApprovals;
  };
  const requireProviderCredentials = (): ProviderCredentialStorePort => {
    if (!agentApi.providerCredentials) {
      throw Object.assign(new Error('Lokaler Provider-Zugangsspeicher ist nicht konfiguriert.'), { statusCode: 503 });
    }
    return agentApi.providerCredentials;
  };
  const rethrowVersionApprovalError = (error: unknown): never => {
    if (error instanceof VersionApprovalConflictError) {
      throw Object.assign(new Error('Die Freigabeliste wurde zwischenzeitlich geändert.'), { statusCode: 409 });
    }
    if (error instanceof VersionApprovalNotFoundError) {
      throw Object.assign(new Error('Diese Freigabe existiert nicht mehr.'), { statusCode: 404 });
    }
    throw error;
  };
  const rethrowCredentialError = (error: unknown): never => {
    if (error instanceof ProviderCredentialValidationError) {
      throw Object.assign(new Error(error.message), { statusCode: 400 });
    }
    throw error;
  };

  app.get('/api/agents/version-approvals', asyncRoute(async (_request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.json(await requireVersionApprovals().load());
  }));

  app.put('/api/agents/version-approvals', asyncRoute(async (request, response) => {
    const payload = z.object({
      expectedUpdatedAt: z.string().nullable(),
      confirmed: z.literal(true),
      approval: versionApprovalKeySchema,
    }).strict().parse(request.body);
    let snapshot;
    try {
      snapshot = await requireVersionApprovals().approve(payload.approval as VersionApprovalKey, payload.expectedUpdatedAt);
    } catch (error) { rethrowVersionApprovalError(error); }
    invalidateProviderDiscovery();
    await audit!.write({
      correlationId: response.locals.correlationId, operation: 'agent.version-approval.update',
      status: 200, category: 'agent_provider_setup', occurredAt: new Date().toISOString(),
    });
    await agentApi.observability?.record({
      level: 'info', component: 'policy', operation: 'version_approval_update', code: 'version_approved',
      correlationId: response.locals.correlationId,
    });
    response.setHeader('cache-control', 'no-store');
    response.json(snapshot);
  }));

  app.post('/api/agents/version-approvals/revoke', asyncRoute(async (request, response) => {
    const payload = z.object({
      expectedUpdatedAt: z.string().nullable(),
      confirmed: z.literal(true),
      approval: versionApprovalKeySchema,
    }).strict().parse(request.body);
    let snapshot;
    try {
      snapshot = await requireVersionApprovals().revoke(payload.approval as VersionApprovalKey, payload.expectedUpdatedAt);
    } catch (error) { rethrowVersionApprovalError(error); }
    invalidateProviderDiscovery();
    await audit!.write({
      correlationId: response.locals.correlationId, operation: 'agent.version-approval.revoke',
      status: 200, category: 'agent_provider_setup', occurredAt: new Date().toISOString(),
    });
    await agentApi.observability?.record({
      level: 'info', component: 'policy', operation: 'version_approval_revoke', code: 'version_revoked',
      correlationId: response.locals.correlationId,
    });
    response.setHeader('cache-control', 'no-store');
    response.json(snapshot);
  }));

  app.get('/api/agents/wsl-distributions', asyncRoute(async (_request, response) => {
    let names: string[] = [];
    let available = false;
    let note = 'Kein WSL-Discovery-Hook konfiguriert.';
    if (agentApi.runtimeDiscovery) {
      try {
        names = await agentApi.runtimeDiscovery.listWslDistributions();
        available = true;
        note = names.length ? 'Distributionen wurden lokal über wsl --list aufgezählt.' : 'Keine WSL-Distribution gefunden.';
      } catch (error) {
        note = `WSL-Aufzählung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const providers = await discoverAgentProviders(false);
    const byName = new Map<string, { name: string; enumerated: boolean; installations: number; supported: number }>();
    for (const name of names) byName.set(name, { name, enumerated: true, installations: 0, supported: 0 });
    for (const provider of providers) {
      for (const installation of provider.installations ?? []) {
        if (installation.runtimeTarget !== 'wsl' || !installation.distribution) continue;
        const entry = byName.get(installation.distribution)
          ?? { name: installation.distribution, enumerated: false, installations: 0, supported: 0 };
        entry.installations += 1;
        if (installation.support === 'supported') entry.supported += 1;
        byName.set(installation.distribution, entry);
      }
    }
    response.setHeader('cache-control', 'no-store');
    response.json({
      contract: 'agent-wsl-distributions', contractVersion: '1.0', available,
      distributions: [...byName.values()], note
    });
  }));

  app.get('/api/agents/providers/credentials', asyncRoute(async (_request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.json(await requireProviderCredentials().list());
  }));

  app.put('/api/agents/providers/:providerId/credentials', asyncRoute(async (request, response) => {
    const providerId = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/).parse(request.params.providerId);
    const payload = z.object({
      confirmed: z.literal(true),
      env: z.record(z.string(), z.string()),
    }).strict().parse(request.body);
    if (providerId === 'openrouter' && !payload.env.OPENROUTER_API_KEY?.trim()) {
      throw Object.assign(new Error('Für OpenRouter muss der Schlüssel unter OPENROUTER_API_KEY gespeichert werden.'), { statusCode: 400 });
    }
    invalidateProviderDiscovery();
    let summary;
    try {
      summary = await requireProviderCredentials().put(providerId, payload.env);
    } catch (error) { rethrowCredentialError(error); }
    await audit!.write({
      correlationId: response.locals.correlationId, operation: 'agent.credentials.update',
      status: 200, category: 'agent_provider_setup', occurredAt: new Date().toISOString(),
    });
    await agentApi.observability?.record({
      level: 'info', component: 'policy', operation: 'credentials_update', code: 'provider_credentials_updated',
      correlationId: response.locals.correlationId, provider: providerId,
    });
    response.setHeader('cache-control', 'no-store');
    response.json(summary);
  }));

  app.delete('/api/agents/providers/:providerId/credentials', asyncRoute(async (request, response) => {
    const providerId = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/).parse(request.params.providerId);
    z.object({ confirmed: z.literal(true) }).strict().parse(request.body);
    const summary = await requireProviderCredentials().remove(providerId);
    await audit!.write({
      correlationId: response.locals.correlationId, operation: 'agent.credentials.delete',
      status: 200, category: 'agent_provider_setup', occurredAt: new Date().toISOString(),
    });
    await agentApi.observability?.record({
      level: 'info', component: 'policy', operation: 'credentials_delete', code: 'provider_credentials_deleted',
      correlationId: response.locals.correlationId, provider: providerId,
    });
    response.setHeader('cache-control', 'no-store');
    response.json(summary);
  }));

  app.get('/api/agents/providers/:providerId/models', asyncRoute(async (request, response) => {
    const providerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).parse(request.params.providerId);
    const query = z.object({
      runtimeTarget: z.enum(['windows', 'wsl', 'linux', 'darwin']),
      wslDistribution: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
    }).strict().refine(
      (value) => (value.runtimeTarget === 'wsl') === Boolean(value.wslDistribution),
      'WSL-Distribution ist genau für WSL erforderlich.',
    ).parse(request.query);
    if (!agentApi.providers.some((provider) => provider.provider === providerId)) {
      throw Object.assign(new Error('Unbekannter Provider.'), { statusCode: 404 });
    }
    const view = (await discoverAgentProviders()).find((provider) => provider.id === providerId);
    const installation = view?.installations?.find((item) => item.runtimeTarget === query.runtimeTarget
      && (query.wslDistribution ? item.distribution === query.wslDistribution : true));
    response.setHeader('cache-control', 'no-store');
    response.json(await discoverProviderModelCatalog({
      providerId, runtimeTarget: query.runtimeTarget,
      ...(query.wslDistribution ? { wslDistribution: query.wslDistribution } : {}),
      ...(installation?.executable ? { executable: installation.executable } : {}),
    }));
  }));

  app.get('/api/agents/health', asyncRoute(async (_request, response) => {
    const providers = await discoverAgentProviders();
    const allRuns = await agentApi.center.list();
    const hidden = new Set(allRuns.filter(isCvAiStructuringRun).map((run) => run.id));
    const runs = allRuns.filter((run) => !hidden.has(run.id));
    const queue = await agentApi.center.getQueueDiagnostics();
    const publicQueue = publicAgentQueueDiagnostics(queue, runs);
    response.json({
      status: agentApi.emergencyStop.enabled ? 'emergency_stopped' : 'ok', providers,
      queueDepth: publicQueue.depth, queue: publicQueue,
      activeRuns: runs.filter((run) => ['starting', 'running', 'waiting_for_input', 'waiting_for_approval', 'cancelling'].includes(run.state)).length,
      recoveryRequired: runs.filter((run) => run.state === 'orphaned').map((run) => run.id),
      stream: { transport: 'sse', resume: true, bidirectionalWebSocket: Boolean(agentApi.realtimeTickets) },
      telemetry: { ...agentApi.telemetry.snapshot(), queueDepth: publicQueue.depth },
    });
  }));

  app.get('/api/agents/queue', asyncRoute(async (_request, response) => {
    const runs = (await agentApi.center.list()).filter((run) => !isCvAiStructuringRun(run));
    const queue = await agentApi.center.getQueueDiagnostics();
    response.json(publicAgentQueueDiagnostics(queue, runs));
  }));

  app.get('/api/agents/recovery', asyncRoute(async (_request, response) => {
    const hidden = new Set((await agentApi.center.list()).filter(isCvAiStructuringRun).map((run) => run.id));
    response.json({ runs: (await agentApi.center.getRecoveryDiagnostics()).filter((entry) => !hidden.has(entry.runId)) });
  }));

  app.get('/api/agents/support-bundle', asyncRoute(async (_request, response) => {
    const [providers, allRuns, queue, allRecovery, config] = await Promise.all([
      discoverAgentProviders(), agentApi.center.list(), agentApi.center.getQueueDiagnostics(),
      agentApi.center.getRecoveryDiagnostics(), store.load()
    ]);
    const hidden = new Set(allRuns.filter(isCvAiStructuringRun).map((run) => run.id));
    const runs = allRuns.filter((run) => !hidden.has(run.id));
    const recovery = allRecovery.filter((entry) => !hidden.has(entry.runId));
    const publicQueue = publicAgentQueueDiagnostics(queue, runs);
    const providerInstallations = providers.map((provider) => ({
      id: provider.id,
      available: provider.available,
      installations: (provider.installations ?? []).map((installation) => ({
        provider: provider.id,
        runtimeTarget: installation.runtimeTarget,
        executable: installation.executable,
        distribution: installation.distribution,
        version: installation.version,
        support: installation.support as 'supported' | 'untested' | 'unsupported' | 'unavailable',
        authStatus: installation.authStatus as 'authenticated' | 'unauthenticated' | 'unknown' | 'not_required' | undefined,
        reason: installation.note
      }))
    }));
    response.setHeader('cache-control', 'no-store');
    response.json(createAgentSupportBundle({
      appVersion: '0.1.0', providers: providerInstallations, runs, queue: publicQueue, recovery,
      telemetry: { ...agentApi.telemetry.snapshot(), queueDepth: publicQueue.depth },
      features: { realtimeWebSocket: Boolean(agentApi.realtimeTickets) },
      jobSearchMcp: {
        mode: config.mcp.mode, executionIsolation: 'trusted-host',
        runtimeStatus: config.mcp.mode === 'demo' ? 'demo' : 'configured_not_probed'
      }
    }));
  }));

  app.get('/api/agents/stream', (request, response, next) => {
    const parsedCursor = Number(request.header('last-event-id') ?? request.query.after ?? 0);
    if (!Number.isSafeInteger(parsedCursor) || parsedCursor < 0) { response.status(400).json({ error: 'Ungültiger globaler Event-Cursor.' }); return; }
    const parsed = z.object({
      runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
      provider: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/).optional(),
      type: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/).optional(),
      after: z.unknown().optional()
    }).strict().safeParse(request.query);
    if (!parsed.success) { response.status(400).json({ error: 'Ungültiger globaler Streamfilter.' }); return; }
    const filter = { runId: parsed.data.runId, provider: parsed.data.provider, type: parsed.data.type };
    response.status(200);
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-cache, no-transform');
    response.setHeader('connection', 'keep-alive');
    response.flushHeaders();
    let cursor = parsedCursor;
    let closed = false;
    let polling = false;
    let lastWrite = Date.now();
    const snapshot = async (eventName: 'snapshot' | 'reset') => {
      const runs = (await agentApi.center.list())
        .filter((run) => !isCvAiStructuringRun(run))
        .filter((run) => (!filter.runId || run.id === filter.runId) && (!filter.provider || run.provider === filter.provider))
        .map((run) => ({
          id: run.id, provider: run.provider, status: run.state, updatedAt: run.updatedAt,
          currentSequence: run.currentSequence, queuePosition: run.queuePosition
        }));
      cursor = agentApi.eventFeed.currentCursor();
      response.write(`id: ${cursor}\nevent: ${eventName}\ndata: ${JSON.stringify({ cursor, runs })}\n\n`);
      lastWrite = Date.now();
    };
    const close = () => { closed = true; clearInterval(timer); };
    const poll = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        if (response.writableLength > 256 * 1024) { response.end(); close(); return; }
        const authorizedRunIds = new Set((await agentApi.center.list())
          .filter((run) => !isCvAiStructuringRun(run)).map((run) => run.id));
        const page = agentApi.eventFeed.sinceAuthorized(cursor, (runId) => authorizedRunIds.has(runId), filter);
        if (page.resetRequired) await snapshot('reset');
        else {
          for (const event of page.events) {
            response.write(`id: ${event.cursor}\nevent: agent-run-event\ndata: ${JSON.stringify(event)}\n\n`);
            cursor = event.cursor; lastWrite = Date.now();
          }
          cursor = page.nextCursor;
        }
        if (Date.now() - lastWrite >= 15_000) { response.write(': heartbeat\n\n'); lastWrite = Date.now(); }
      } catch (error) { response.end(); close(); next(error); }
      finally { polling = false; }
    };
    const timer = setInterval(() => { void poll(); }, 500);
    timer.unref();
    request.on('close', close);
    void (parsedCursor === 0 ? snapshot('snapshot') : poll());
  });

  app.get('/api/agents/workflows', (_request, response) => response.json(APPLICATION_AGENT_WORKFLOWS.map((workflow) => ({
    id: workflow.id, version: workflow.version, title: workflow.title, description: workflow.description,
    requiredScope: workflow.requiredScope, producesSuggestionsOnly: workflow.producesSuggestionsOnly,
    prohibitedActions: workflow.prohibitedActions
  }))));
}
