import { createHash } from 'node:crypto';
import { get, type Server } from 'node:http';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApp, createDefaultAgentApiDependencies, restorePrivateAgentRunClassifications,
} from './app.js';
import { AgentControlCenter } from './agents/agent-control-center.js';
import { MemoryAgentRunStore } from './agents/run-store.js';
import type {
  AgentCapabilities, AgentProviderInstallation, AgentRun, AgentRunHandle, AgentRunnerPort,
  AgentRunRequest, ApprovalDecision, ProviderRunContext, RuntimeTarget,
} from './ports/agent-runner.js';
import { MemoryAuditLogger } from './services/audit-logger.js';
import { MemoryConfigStore } from './services/config-store.js';
import { MemoryWorkspaceStore } from './services/workspace-store.js';

const PRIVATE_CV_CANARY = 'PRIVATE-CV-CANARY-8f26d9e4';
const centers: AgentControlCenter[] = [];

class BlockingPrivateProvider implements AgentRunnerPort {
  readonly provider = 'fake';
  private readonly completions = new Map<string, (result: Awaited<AgentRunHandle['completion']>) => void>();

  async discover(): Promise<AgentProviderInstallation[]> {
    const installation: AgentProviderInstallation = {
      provider: this.provider, runtimeTarget: localRuntimeTarget(), executable: process.execPath,
      version: 'fake 1.0.0', support: 'supported', authStatus: 'not_required',
    };
    installation.capabilities = await this.capabilities(installation);
    return [installation];
  }

  async capabilities(installation: AgentProviderInstallation): Promise<AgentCapabilities> {
    return {
      schemaVersion: '1.0', provider: this.provider, providerVersion: installation.version,
      adapterVersion: '1.0.0', protocolVersion: '1.0', streaming: true, resume: false,
      interactiveInput: false, approvals: false, tools: false, images: false, structuredOutput: true,
      sandboxPolicies: ['read-only'], usage: true, supportedRuntimeTargets: [localRuntimeTarget()],
    };
  }

  async start(context: ProviderRunContext): Promise<AgentRunHandle> {
    await context.emit({ kind: 'process_started', data: { pid: 0, synthetic: true } });
    const completion = new Promise<Awaited<AgentRunHandle['completion']>>((resolve) => {
      this.completions.set(context.runId, resolve);
    });
    return { runId: context.runId, completion };
  }

  async cancel(runId: string): Promise<void> {
    this.completions.get(runId)?.({ state: 'cancelled' });
    this.completions.delete(runId);
  }
  async sendInput(): Promise<void> { throw new Error('not supported'); }
  async resolveApproval(_runId: string, _approvalId: string, _decision: ApprovalDecision): Promise<void> { throw new Error('not supported'); }
  async resume(): Promise<AgentRunHandle> { throw new Error('not supported'); }
  async dispose(): Promise<void> {
    for (const resolve of this.completions.values()) resolve({ state: 'cancelled' });
    this.completions.clear();
  }
}

afterEach(async () => {
  await Promise.allSettled(centers.splice(0).map((center) => center.dispose()));
});

function localRuntimeTarget(): RuntimeTarget {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

async function waitForTerminal(center: AgentControlCenter, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await center.get(runId);
    if (run && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Der synthetische private CV-Lauf wurde nicht terminal.');
}

async function waitForState(center: AgentControlCenter, runId: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await center.get(runId))?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Der synthetische private CV-Lauf erreichte ${expected} nicht.`);
}

async function readGlobalStreamSnapshot(app: ReturnType<typeof createApp>): Promise<string> {
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Kein lokaler Testport verfuegbar.');
    return await new Promise<string>((resolve, reject) => {
      let completed = false;
      const clientRequest = get({ hostname: '127.0.0.1', port: address.port, path: '/api/agents/stream' }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
          if (!completed && body.includes('\n\n')) {
            completed = true;
            resolve(body);
            response.destroy();
            clientRequest.destroy();
          }
        });
        response.on('end', () => {
          if (!completed) {
            completed = true;
            resolve(body);
          }
        });
        response.on('error', (error) => {
          if (!completed) reject(error);
        });
      });
      clientRequest.on('error', (error) => {
        if (!completed) reject(error);
      });
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('private CV AI run isolation from generic Agent HTTP APIs', () => {
  it('restores the private classification before cancelling a recovered orphan', async () => {
    const dependencies = createDefaultAgentApiDependencies(true);
    centers.push(dependencies.center);
    const runId = '99999999-9999-4999-8999-999999999999';
    const privateRun: AgentRun = {
      schemaVersion: '1.0', id: runId, provider: 'fake', state: 'running',
      request: {
        provider: 'fake', task: `Recovered private canary: ${PRIVATE_CV_CANARY}`,
        workspaceRoot: dependencies.workspaceRoot, runtimeTarget: localRuntimeTarget(),
        sandbox: 'read-only', network: 'disabled', approvalMode: 'deny',
        metadata: {
          workflowId: 'cv-ai-structuring', requiredRootMcpTools: [], providerToolMode: 'none',
          cvAiStructuringRunId: 'recovered-private-run',
        },
      },
      requestedAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:01.000Z',
      startedAt: '2026-08-15T00:00:01.000Z', currentSequence: 0,
    };
    await dependencies.store.create(privateRun);
    const recovery = await dependencies.center.recover();
    expect(recovery.errors).toEqual([]);
    expect(recovery.recovered).toContain(runId);
    expect((await dependencies.center.get(runId))?.state).toBe('orphaned');

    const cursorBefore = dependencies.eventFeed.currentCursor();
    const { generatedAt: _beforeCapturedAt, ...telemetryBefore } = dependencies.telemetry.snapshot();
    expect(dependencies.telemetry.isPrivateRun(runId)).toBe(false);
    expect(await restorePrivateAgentRunClassifications(dependencies)).toBe(1);
    expect(dependencies.telemetry.isPrivateRun(runId)).toBe(true);

    await dependencies.center.cancel(runId, 'Recovered private retention cleanup.');
    expect((await dependencies.center.get(runId))?.state).toBe('cancelled');
    expect(dependencies.eventFeed.currentCursor()).toBe(cursorBefore);
    expect(dependencies.eventFeed.since(cursorBefore).events).toEqual([]);
    const { generatedAt: _afterCapturedAt, ...telemetryAfter } = dependencies.telemetry.snapshot();
    expect(telemetryAfter).toEqual(telemetryBefore);
    expect((await dependencies.center.events(runId)).some((event) => event.kind === 'run_completed')).toBe(true);
  });

  it('never indexes private CV events in the generic process-wide feed', async () => {
    const dependencies = createDefaultAgentApiDependencies(true);
    centers.push(dependencies.center);
    const before = dependencies.eventFeed.currentCursor();
    const run = await dependencies.center.enqueue({
      provider: 'fake', task: `Private feed canary: ${PRIVATE_CV_CANARY}`,
      workspaceRoot: dependencies.workspaceRoot, runtimeTarget: localRuntimeTarget(),
      sandbox: 'read-only', network: 'disabled', approvalMode: 'deny',
      metadata: {
        workflowId: 'cv-ai-structuring', requiredRootMcpTools: [], providerToolMode: 'none',
        cvAiStructuringRunId: 'private-feed-run',
      },
    });
    await waitForTerminal(dependencies.center, run.id);
    expect((await dependencies.center.events(run.id)).length).toBeGreaterThan(0);
    expect(dependencies.eventFeed.currentCursor()).toBe(before);
    expect(dependencies.eventFeed.since(before).events).toEqual([]);
    expect(dependencies.telemetry.usageTrend('workflow').groups).toEqual([]);
  });

  it('keeps source text and the run hidden across every generic read and control surface', async () => {
    const dependencies = createDefaultAgentApiDependencies(true);
    const fakeProvider = new BlockingPrivateProvider();
    const runStore = new MemoryAgentRunStore();
    const center = new AgentControlCenter(runStore, [fakeProvider], {
      maxParallel: 1,
      maxParallelPerProvider: 1,
      allowedWorkspaceRoots: [dependencies.workspaceRoot],
      onQueueDepth: (depth) => dependencies.telemetry.setQueueDepth(depth),
      onEvent: (event) => { dependencies.eventFeed.append(event); },
    });
    centers.push(center);
    dependencies.center = center;
    dependencies.store = runStore;
    dependencies.providers = [fakeProvider];

    const app = createApp(
      new MemoryConfigStore(),
      new MemoryAuditLogger(),
      new MemoryWorkspaceStore(),
      undefined,
      dependencies,
    );
    const privateRequest: AgentRunRequest = {
      provider: 'fake',
      task: `Strukturiere diesen CV, ohne ihn offenzulegen: ${PRIVATE_CV_CANARY}`,
      workspaceRoot: dependencies.workspaceRoot,
      runtimeTarget: localRuntimeTarget(),
      sandbox: 'read-only',
      network: 'disabled',
      approvalMode: 'deny',
      metadata: {
        workflowId: 'cv-ai-structuring',
        requiredRootMcpTools: [],
        providerToolMode: 'none',
        cvAiStructuringRunId: 'private-cv-run',
      },
    };
    const privateRun = await dependencies.center.enqueue(privateRequest);
    await waitForState(dependencies.center, privateRun.id, 'running');

    const stored = await dependencies.center.get(privateRun.id);
    expect(stored?.request.task).toContain(PRIVATE_CV_CANARY);
    expect(stored?.request.metadata?.requiredRootMcpTools).toEqual([]);

    const list = await request(app).get('/api/agent-runs').expect(200);
    expect(list.body).toEqual([]);

    const hiddenResponses = await Promise.all([
      request(app).get(`/api/agent-runs/${privateRun.id}`),
      request(app).get(`/api/agent-runs/${privateRun.id}/events?after=0`),
      request(app).get(`/api/agent-runs/${privateRun.id}/export`),
      request(app).get(`/api/agent-runs/${privateRun.id}/stream`),
      request(app).get(`/api/agent-runs/${privateRun.id}/artifacts`),
      request(app).get(`/api/agent-runs/${privateRun.id}/usage`),
      request(app).post(`/api/agent-runs/${privateRun.id}/cancel`).send({ confirmed: true }),
      request(app).post(`/api/agent-runs/${privateRun.id}/input`).send({ input: 'do not accept', confirmed: true }),
      request(app).post(`/api/agent-runs/${privateRun.id}/approvals/private-approval`).send({ decision: 'deny', confirmed: true }),
      request(app).post(`/api/agent-runs/${privateRun.id}/realtime-ticket`).send({ afterSequence: 0 }),
    ]);
    for (const response of hiddenResponses) {
      expect(response.status, response.text).toBe(404);
      expect(response.text).not.toContain(PRIVATE_CV_CANARY);
      expect(response.text).not.toContain(privateRun.id);
    }

    const cutoff = new Date(Date.now() + 60_000).toISOString();
    const [health, queue, recovery, supportBundle, retentionPreview, preflight, globalSnapshot] = await Promise.all([
      request(app).get('/api/agents/health').expect(200),
      request(app).get('/api/agents/queue').expect(200),
      request(app).get('/api/agents/recovery').expect(200),
      request(app).get('/api/agents/support-bundle').expect(200),
      request(app).post('/api/agent-runs/retention/preview').send({ before: cutoff }).expect(200),
      request(app).post('/api/agent-runs/preflight').send({
        providerId: 'fake', prompt: 'public synthetic preflight', workspaceMode: 'read_only', network: false,
        budget: { wallTimeMinutes: 1, maxOutputMiB: 1 },
      }).expect(200),
      readGlobalStreamSnapshot(app),
    ]);

    expect(health.body).toMatchObject({ activeRuns: 0, recoveryRequired: [], queue: { depth: 0, queue: [] } });
    expect(queue.body).toMatchObject({ depth: 0, active: 0, queue: [] });
    expect(recovery.body).toEqual({ runs: [] });
    expect(supportBundle.body.payload.runs).toEqual([]);
    expect(supportBundle.body.payload.queue.entries).toEqual([]);
    expect(retentionPreview.body).toMatchObject({ matched: [], removed: [] });
    expect(preflight.body).toMatchObject({ scheduling: { queueDepth: 0, active: 0 } });
    expect(globalSnapshot).toContain('event: snapshot');
    expect(globalSnapshot).toContain('"runs":[]');

    const opaqueRunId = `sha256:${createHash('sha256').update(privateRun.id, 'utf8').digest('hex')}`;
    const everyGenericSurface = JSON.stringify({
      list: list.body,
      health: health.body,
      queue: queue.body,
      recovery: recovery.body,
      supportBundle: supportBundle.body,
      retentionPreview: retentionPreview.body,
      preflight: preflight.body,
      globalSnapshot,
    });
    expect(everyGenericSurface).not.toContain(PRIVATE_CV_CANARY);
    expect(everyGenericSurface).not.toContain(privateRun.id);
    expect(everyGenericSurface).not.toContain(opaqueRunId);

    await dependencies.center.cancel(privateRun.id, 'Privacy-Test abgeschlossen.');
    await waitForTerminal(dependencies.center, privateRun.id);
  });
});
