import { createHash } from 'node:crypto';
import { z } from 'zod';
import { textDiff, type AgentArtifactProvenance } from '../../agents/artifact-store.js';
import { assertAllowedRealtimeOrigin } from '../../agents/agent-realtime-gateway.js';
import { safeDefaultAgentConfigProfile } from '../../agents/config-profile-store.js';
import type { Express } from 'express';
import {
  asyncRoute, adoptApprovedAgentArtifact, agentEventMessage, agentEventLevel, agentEventDataView,
  approvalView, approvalRisk, providerApprovalPolicy, isCvAiStructuringRun, agentRunView,
} from '../app-support.js';
import type { AppContext } from '../app-context.js';

export function registerAgentRunDetailRoutes(app: Express, ctx: AppContext): void {
  const {
    workspace, agentApi, loadAgentConfigProfile, artifactRun, artifactForRun,
  } = ctx;

  app.use('/api/agent-runs/:runId', (request, response, next) => {
    const runId = String(request.params.runId ?? '');
    void agentApi.center.get(runId).then((run) => {
      if (run && isCvAiStructuringRun(run)) {
        response.setHeader('cache-control', 'no-store');
        response.status(404).json({ error: 'Agentenlauf nicht gefunden.' });
        return;
      }
      next();
    }, next);
  });

  app.get('/api/agent-runs/:runId/usage', asyncRoute(async (request, response) => {
    const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.runId);
    if (!(await agentApi.center.get(runId))) { response.status(404).json({ error: 'Agentenlauf nicht gefunden.' }); return; }
    const profile = agentApi.configProfiles ? (await loadAgentConfigProfile()).profile : safeDefaultAgentConfigProfile();
    response.setHeader('cache-control', 'no-store');
    response.json({
      contract: 'agent-run-usage', contractVersion: '1.0', capturedAt: new Date().toISOString(), runId,
      measurement: agentApi.telemetry.usageFor(runId) ?? null,
      points: agentApi.telemetry.metricPointsFor(runId),
      budget: agentApi.telemetry.evaluateBudget(runId, profile.budgets),
    });
  }));

  app.get('/api/agent-runs/:runId', asyncRoute(async (request, response) => {
    const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.runId);
    const run = await agentApi.center.get(runId);
    if (!run) { response.status(404).json({ error: 'Agentenlauf nicht gefunden.' }); return; }
    response.json(await agentRunView(agentApi.center, run));
  }));

  app.get('/api/agent-runs/:runId/events', asyncRoute(async (request, response) => {
    const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.runId);
    const after = z.coerce.number().int().min(0).default(0).parse(request.query.after);
    if (!(await agentApi.center.get(runId))) { response.status(404).json({ error: 'Agentenlauf nicht gefunden.' }); return; }
    const events = await agentApi.center.events(runId, after);
    response.json({ events: events.map((event) => ({ sequence: event.sequence, type: event.kind, timestamp: event.timestamp, correlationId: event.correlationId, message: agentEventMessage(event), level: agentEventLevel(event), data: agentEventDataView(event) })), nextAfter: events.at(-1)?.sequence ?? after });
  }));

  app.get('/api/agent-runs/:runId/artifacts', asyncRoute(async (request, response) => {
    const run = await artifactRun(request.params.runId);
    response.setHeader('cache-control', 'no-store');
    response.json({ artifacts: await agentApi.artifacts.list({ runId: run.id }) });
  }));

  app.post('/api/agent-runs/:runId/artifacts', asyncRoute(async (request, response) => {
    const run = await artifactRun(request.params.runId);
    const payload = z.object({
      kind: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/),
      content: z.string().max(400_000),
      mediaType: z.enum(['text/plain', 'text/markdown', 'application/json']),
      relativePath: z.string().min(1).max(1_024).optional(),
    }).strict().parse(request.body);
    const caseId = run.request.applicationCaseId;
    if (!caseId) throw Object.assign(new Error('Agentenartefakte benötigen einen expliziten Bewerbungsfall.'), { statusCode: 409 });
    const application = await workspace!.getApplicationCase(caseId);
    if (!application) throw Object.assign(new Error('Bewerbungsfall nicht gefunden.'), { statusCode: 404 });
    const witness = run.request.metadata?.promptWitness;
    const promptWitness = witness && typeof witness === 'object' && !Array.isArray(witness) ? witness as Record<string, unknown> : {};
    const stringMetadata = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
    const artifactContextValue = run.request.metadata?.artifactContext;
    const artifactContext = artifactContextValue && typeof artifactContextValue === 'object' && !Array.isArray(artifactContextValue)
      ? artifactContextValue as Record<string, unknown> : {};
    const providerVersion = run.capabilities?.providerVersion ?? stringMetadata(run.request.metadata?.providerVersion);
    const adapterVersion = run.capabilities?.adapterVersion ?? stringMetadata(run.request.metadata?.adapterVersion);
    if (!providerVersion || !adapterVersion) {
      throw Object.assign(new Error('Provider- und Adapterversion des Agentenlaufs sind noch nicht belegt.'), { statusCode: 409 });
    }
    const contextCaseId = stringMetadata(artifactContext.applicationCaseId);
    const contextCaseRevision = artifactContext.applicationCaseRevision;
    const contextJobId = stringMetadata(artifactContext.jobId);
    const contextCompanyKey = stringMetadata(artifactContext.companyKey);
    const contextIdentityMode = artifactContext.identityMode;
    if (contextCaseId !== application.id || !Number.isSafeInteger(contextCaseRevision) || (contextCaseRevision as number) < 0
      || !contextJobId || !contextCompanyKey || !['real', 'incognito'].includes(String(contextIdentityMode))) {
      throw Object.assign(new Error('Der serverseitige Fachkontext des Agentenlaufs ist unvollständig.'), { statusCode: 409 });
    }
    const provenance: AgentArtifactProvenance = {
      runId: run.id,
      provider: run.provider,
      providerVersion,
      adapterVersion,
      templateId: stringMetadata(promptWitness.templateId) ?? 'workspace-task',
      templateVersion: stringMetadata(promptWitness.templateVersion) ?? '1.0.0',
      workflowId: stringMetadata(run.request.metadata?.workflowId),
      workflowVersion: stringMetadata(run.request.metadata?.workflowVersion),
      applicationCaseId: contextCaseId,
      applicationCaseRevision: contextCaseRevision as number,
      jobId: contextJobId,
      companyKey: contextCompanyKey,
      identityMode: contextIdentityMode as 'real' | 'incognito',
    };
    const artifact = await agentApi.artifacts.create({ ...payload, provenance });
    response.setHeader('cache-control', 'no-store');
    response.status(201).json(artifact);
  }));

  app.get('/api/agent-runs/:runId/artifacts/diff', asyncRoute(async (request, response) => {
    const run = await artifactRun(request.params.runId);
    const query = z.object({ left: z.string().uuid(), right: z.string().uuid() }).parse(request.query);
    await artifactForRun(run.id, query.left); await artifactForRun(run.id, query.right);
    const [left, right] = await Promise.all([agentApi.artifacts.read(query.left), agentApi.artifacts.read(query.right)]);
    const textual = (mediaType: string) => /^(?:text\/(?:plain|markdown)|application\/json)/i.test(mediaType);
    if (!textual(left.record.mediaType) || !textual(right.record.mediaType)) throw Object.assign(new Error('Nur Textartefakte können verglichen werden.'), { statusCode: 409 });
    let before: string; let after: string;
    try {
      before = new TextDecoder('utf-8', { fatal: true }).decode(left.content);
      after = new TextDecoder('utf-8', { fatal: true }).decode(right.content);
    } catch { throw Object.assign(new Error('Artefaktinhalt ist kein gültiger UTF-8-Text.'), { statusCode: 409 }); }
    response.setHeader('cache-control', 'no-store');
    response.json({ left: { id: left.record.id, sha256: left.record.sha256 }, right: { id: right.record.id, sha256: right.record.sha256 }, changes: textDiff(before, after) });
  }));

  app.get('/api/agent-runs/:runId/artifacts/:artifactId/content', asyncRoute(async (request, response) => {
    const run = await artifactRun(request.params.runId);
    const artifact = await artifactForRun(run.id, request.params.artifactId);
    const { content } = await agentApi.artifacts.read(artifact.id);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch { throw Object.assign(new Error('Artefaktinhalt ist kein gültiger UTF-8-Text.'), { statusCode: 409 }); }
    response.setHeader('cache-control', 'no-store');
    response.json({ id: artifact.id, sha256: artifact.sha256, mediaType: artifact.mediaType, content: text });
  }));

  app.get('/api/agent-runs/:runId/artifacts/:artifactId', asyncRoute(async (request, response) => {
    const run = await artifactRun(request.params.runId);
    response.setHeader('cache-control', 'no-store');
    response.json(await artifactForRun(run.id, request.params.artifactId));
  }));

  app.post('/api/agent-runs/:runId/artifacts/:artifactId/review', asyncRoute(async (request, response) => {
    const run = await artifactRun(request.params.runId);
    const artifact = await artifactForRun(run.id, request.params.artifactId);
    const payload = z.object({
      decision: z.enum(['approved', 'rejected']), expectedRevision: z.number().int().min(0), confirmed: z.literal(true),
    }).strict().parse(request.body);
    response.setHeader('cache-control', 'no-store');
    response.json(await agentApi.artifacts.review(artifact.id, payload.decision, payload.expectedRevision, 'local-user'));
  }));

  app.post('/api/agent-runs/:runId/artifacts/:artifactId/adopt', asyncRoute(async (request, response) => {
    const run = await artifactRun(request.params.runId);
    const artifact = await artifactForRun(run.id, request.params.artifactId);
    const payload = z.object({ expectedRevision: z.number().int().min(0), confirmed: z.literal(true) }).strict().parse(request.body);
    const used = await adoptApprovedAgentArtifact(agentApi, artifact.id, payload.expectedRevision);
    const sourceReference = used.adoption?.sourceReference;
    if (!sourceReference?.startsWith('application-revision:')) throw new Error('artifact_adoption_result_mismatch');
    response.setHeader('cache-control', 'no-store');
    response.json({ artifact: used, documentRevisionId: sourceReference.slice('application-revision:'.length) });
  }));

  app.post('/api/agent-runs/:runId/realtime-ticket', asyncRoute(async (request, response) => {
    if (!agentApi.realtimeTickets) throw Object.assign(new Error('Der optionale bidirektionale Kanal ist nicht aktiviert; SSE plus REST bleibt verfuegbar.'), { statusCode: 503 });
    const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.runId);
    const payload = z.object({ afterSequence: z.number().int().min(0).default(0) }).strict().parse(request.body);
    const run = await agentApi.center.get(runId);
    if (!run) { response.status(404).json({ error: 'Agentenlauf nicht gefunden.' }); return; }
    if (payload.afterSequence > run.currentSequence) throw Object.assign(new Error('Die angeforderte Event-Sequenz liegt vor dem Serverzustand.'), { statusCode: 409 });
    let origin: string;
    try { origin = assertAllowedRealtimeOrigin(request.header('origin'), request.header('host')); }
    catch (error) { throw Object.assign(error as Error, { statusCode: 403 }); }
    const remoteAddress = request.socket.remoteAddress ?? '';
    const ticket = agentApi.realtimeTickets.issue({ runId, afterSequence: payload.afterSequence, origin, remoteAddress });
    response.setHeader('cache-control', 'no-store');
    response.json({
      protocolVersion: '1.0', sessionId: ticket.sessionId, expiresAt: ticket.expiresAt,
      path: `/api/agent-runs/${encodeURIComponent(runId)}/channel`, protocols: ['agent.v1', `agent.ticket.${ticket.token}`],
      controls: 'revision-checked-rest-only'
    });
  }));

  app.get('/api/agent-runs/:runId/stream', (request, response, next) => {
    const runId = request.params.runId;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) { response.status(400).json({ error: 'Ungültige Run-ID.' }); return; }
    const headerAfter = request.header('last-event-id');
    const queryAfter = typeof request.query.after === 'string' ? request.query.after : undefined;
    const parsedAfter = Number(headerAfter ?? queryAfter ?? 0);
    if (!Number.isSafeInteger(parsedAfter) || parsedAfter < 0) { response.status(400).json({ error: 'Ungültige Event-Sequenz.' }); return; }
    void agentApi.center.get(runId).then((run) => {
      if (!run) { response.status(404).json({ error: 'Agentenlauf nicht gefunden.' }); return; }
      response.status(200);
      response.setHeader('content-type', 'text/event-stream; charset=utf-8');
      response.setHeader('cache-control', 'no-cache, no-transform');
      response.setHeader('connection', 'keep-alive');
      response.flushHeaders();
      let cursor = parsedAfter;
      let closed = false;
      let polling = false;
      let lastWrite = Date.now();
      if (parsedAfter > 0) agentApi.telemetry.streamReconnected();
      const close = () => { closed = true; clearInterval(timer); };
      const poll = async () => {
        if (closed || polling) return;
        polling = true;
        try {
          if (response.writableLength > 256 * 1024) { response.end(); close(); return; }
          const events = await agentApi.center.events(runId, cursor);
          for (const event of events) {
            const occurredAt = Date.parse(event.timestamp);
            if (Number.isFinite(occurredAt)) agentApi.telemetry.observeStreamLag(Math.max(0, Date.now() - occurredAt));
            response.write(`id: ${event.sequence}\nevent: agent-event\ndata: ${JSON.stringify({ sequence: event.sequence, type: event.kind, timestamp: event.timestamp, correlationId: event.correlationId, message: agentEventMessage(event), level: agentEventLevel(event), data: agentEventDataView(event) })}\n\n`);
            cursor = event.sequence; lastWrite = Date.now();
          }
          const current = await agentApi.center.get(runId);
          if (current && ['cancelled', 'succeeded', 'failed', 'timed_out'].includes(current.state) && cursor >= current.currentSequence) { response.end(); close(); return; }
          if (Date.now() - lastWrite >= 15_000) { response.write(': heartbeat\n\n'); lastWrite = Date.now(); }
        // The error handler ends the response. Ending it here first would let
        // the finish listener run before the error class is recorded.
        } catch (error) { close(); next(error); }
        finally { polling = false; }
      };
      const timer = setInterval(() => { void poll(); }, 500);
      timer.unref();
      request.on('close', close);
      void poll();
    }).catch(next);
  });

  app.post('/api/agent-runs/:runId/cancel', asyncRoute(async (request, response) => {
    const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.runId);
    const payload = z.object({ confirmed: z.literal(true), expectedRevision: z.number().int().min(0).optional() }).strict().parse(request.body);
    const current = await agentApi.center.get(runId);
    if (!current) { response.status(404).json({ error: 'Agentenlauf nicht gefunden.' }); return; }
    if (payload.expectedRevision !== undefined && current.currentSequence !== payload.expectedRevision) throw Object.assign(new Error('Der Agentenlauf wurde zwischenzeitlich verändert.'), { statusCode: 409 });
    await agentApi.center.cancel(runId);
    response.json(await agentRunView(agentApi.center, (await agentApi.center.get(runId))!));
  }));

  app.post('/api/agent-runs/:runId/input', asyncRoute(async (request, response) => {
    const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.runId);
    const payload = z.object({ input: z.string().min(1).max(256 * 1024), confirmed: z.literal(true), expectedRevision: z.number().int().min(0).optional() }).strict().parse(request.body);
    const current = await agentApi.center.get(runId);
    if (!current) { response.status(404).json({ error: 'Agentenlauf nicht gefunden.' }); return; }
    if (payload.expectedRevision !== undefined && current.currentSequence !== payload.expectedRevision) throw Object.assign(new Error('Der Agentenlauf wurde zwischenzeitlich verändert.'), { statusCode: 409 });
    if (current.state !== 'waiting_for_input') throw Object.assign(new Error('Der Agentenlauf wartet nicht auf eine Eingabe.'), { statusCode: 409 });
    try {
      // This actor is bound by the loopback-only server boundary. It is
      // intentionally absent from the strict request body and cannot be chosen
      // by a browser client.
      await agentApi.center.sendInput(runId, payload.input, { id: 'local-user', type: 'local' });
    } catch (error) {
      if (/^(?:user_input_request_(?:expired|not_pending)|user_input_cannot_resolve_approval)/.test((error as Error).message)) {
        throw Object.assign(error as Error, { statusCode: 409 });
      }
      if (/^user_input_(?:invalid|selection_invalid|confirmation_invalid|file_reference_invalid)/.test((error as Error).message)) {
        throw Object.assign(error as Error, { statusCode: 400 });
      }
      throw error;
    }
    response.json(await agentRunView(agentApi.center, (await agentApi.center.get(runId))!));
  }));

  app.post('/api/agent-runs/:runId/approvals/:approvalId', asyncRoute(async (request, response) => {
    const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.runId);
    const approvalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.approvalId);
    const payload = z.object({ decision: z.enum(['approve', 'deny']), confirmed: z.literal(true), expectedRevision: z.number().int().min(0).optional() }).strict().parse(request.body);
    const current = await agentApi.center.get(runId);
    if (!current) { response.status(404).json({ error: 'Agentenlauf nicht gefunden.' }); return; }
    if (payload.expectedRevision !== undefined && current.currentSequence !== payload.expectedRevision) throw Object.assign(new Error('Der Agentenlauf wurde zwischenzeitlich verändert.'), { statusCode: 409 });
    if (current.state !== 'waiting_for_approval') throw Object.assign(new Error('Der Agentenlauf wartet nicht auf diese Freigabe.'), { statusCode: 409 });
    const events = await agentApi.center.events(runId);
    const unresolved = approvalView(events).find((candidate) => candidate.id === approvalId);
    if (!unresolved) throw Object.assign(new Error('Die Freigabe ist nicht mehr offen oder stimmt nicht mit dem Lauf ueberein.'), { statusCode: 409 });
    const parameters = { approvalId, sequence: current.currentSequence };
    const risk = approvalRisk(unresolved.risk);
    const policy = providerApprovalPolicy(current.provider, risk);
    const policyInput = {
      runId, providerId: current.provider, toolName: 'provider.interactive-action', actionClass: 'confirm' as const, requestedRisk: risk,
      runProfile: current.request.sandbox === 'read-only' ? 'read_only_offline' as const : 'workspace_write_offline' as const,
      identityMode: current.request.metadata?.identityMode === 'incognito' ? 'incognito' as const : 'real' as const,
      allowedTools: ['provider.interactive-action'], allowedApplicationCaseIds: current.request.applicationCaseId ? [current.request.applicationCaseId] : [],
      applicationCaseId: current.request.applicationCaseId, emergencyStop: agentApi.emergencyStop.enabled
    };
    const preliminary = policy.evaluate({ ...policyInput, hasValidApproval: false });
    if (preliminary.outcome === 'deny') throw Object.assign(new Error(preliminary.explanation), { statusCode: 409 });
    const approvalRequest = agentApi.approvalQueue.request({
      runId, toolName: 'provider.interactive-action', target: `provider-approval:${approvalId}`,
      parameters, parameterPreview: { approvalId, title: unresolved.title ?? 'Freigabe' }, risk, expiresInMs: 5 * 60_000
    });
    if (payload.decision === 'deny') {
      agentApi.approvalQueue.deny(approvalRequest.id, 'local-user');
      await agentApi.center.resolveApproval(runId, approvalId, 'denied');
    } else {
      const token = agentApi.approvalQueue.approve(approvalRequest.id, 'local-user');
      agentApi.approvalQueue.consume(token, { runId, toolName: 'provider.interactive-action', target: `provider-approval:${approvalId}`, parameters });
      const allowed = policy.evaluate({ ...policyInput, hasValidApproval: true });
      if (allowed.outcome !== 'allow') throw Object.assign(new Error(allowed.explanation), { statusCode: 409 });
      await agentApi.center.resolveApproval(runId, approvalId, 'approved');
    }
    response.json(await agentRunView(agentApi.center, (await agentApi.center.get(runId))!));
  }));

  app.post('/api/agent-runs/:runId/recovery/lease', asyncRoute(async (request, response) => {
    const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.runId);
    const payload = z.object({ confirmed: z.literal(true), expectedRevision: z.number().int().min(0) }).strict().parse(request.body);
    const run = await agentApi.center.get(runId);
    if (!run) { response.status(404).json({ error: 'Agentenlauf nicht gefunden.' }); return; }
    if (run.currentSequence !== payload.expectedRevision) throw Object.assign(new Error('Der Recovery-Zustand wurde zwischenzeitlich verändert.'), { statusCode: 409 });
    if (run.state !== 'orphaned') throw Object.assign(new Error('Nur ein verwaister Lauf kann reserviert werden.'), { statusCode: 409 });
    response.setHeader('cache-control', 'no-store');
    response.json(await agentApi.center.acquireRecoveryLease(runId, 'local-user'));
  }));

  app.post('/api/agent-runs/:runId/recovery/resolve', asyncRoute(async (request, response) => {
    const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.runId);
    const payload = z.object({
      confirmed: z.literal(true), expectedRevision: z.number().int().min(0),
      leaseId: z.string().uuid(), decision: z.enum(['cleanup', 'resume']), input: z.string().min(1).max(256 * 1024).optional()
    }).strict().parse(request.body);
    const run = await agentApi.center.get(runId);
    if (!run) { response.status(404).json({ error: 'Agentenlauf nicht gefunden.' }); return; }
    if (run.currentSequence !== payload.expectedRevision) throw Object.assign(new Error('Der Recovery-Zustand wurde zwischenzeitlich verändert.'), { statusCode: 409 });
    const result = await agentApi.center.resolveRecovery(runId, payload.leaseId, 'local-user', payload.decision, payload.input);
    agentApi.telemetry.recovered();
    response.json({
      resolved: await agentRunView(agentApi.center, result.resolved),
      ...(result.replacement ? { replacement: await agentRunView(agentApi.center, result.replacement) } : {})
    });
  }));

  app.post('/api/agent-runs/:runId/resume', asyncRoute(async (request, response) => {
    const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.runId);
    z.object({ confirmed: z.literal(true), input: z.string().max(256 * 1024).optional() }).strict().parse(request.body);
    const run = await agentApi.center.get(runId);
    if (!run) { response.status(404).json({ error: 'Agentenlauf nicht gefunden.' }); return; }
    throw Object.assign(new Error(run.capabilities?.resume ? 'Die sichere Resume-Brücke ist für diese Sitzung nicht verfügbar.' : 'Der Provider unterstützt keine sichere Wiederaufnahme.'), { statusCode: 409 });
  }));

  app.post('/api/agent-runs/:runId/pause', asyncRoute(async (request, response) => {
    const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.runId);
    z.object({ confirmed: z.literal(true) }).strict().parse(request.body);
    if (!(await agentApi.center.get(runId))) { response.status(404).json({ error: 'Agentenlauf nicht gefunden.' }); return; }
    throw Object.assign(new Error('Kein aktivierter Provider bietet eine nachweisbar sichere Pause-Semantik; Cancel bleibt verfügbar.'), { statusCode: 409 });
  }));

  app.get('/api/agent-runs/:runId/export', asyncRoute(async (request, response) => {
    const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.runId);
    if (!(await agentApi.center.get(runId))) { response.status(404).json({ error: 'Agentenlauf nicht gefunden.' }); return; }
    const bundle = { contract: 'agent-run-export', contractVersion: '1.0', exportedAt: new Date().toISOString(), redacted: true, ...(await agentApi.store.export(runId)) };
    await agentApi.retention?.auditExport({
      actor: 'local-user', manifestSha256: createHash('sha256').update(JSON.stringify(bundle)).digest('hex'), runIds: [runId],
    });
    response.setHeader('cache-control', 'no-store');
    response.json(bundle);
  }));
}
