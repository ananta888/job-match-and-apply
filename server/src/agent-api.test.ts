import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp, createDefaultAgentApiDependencies } from './app.js';
import { AgentLocalObservability } from './agents/local-observability.js';
import { AGENT_CONTRACT_VERSION, type RuntimeTarget } from './ports/agent-runner.js';
import { MemoryConfigStore } from './services/config-store.js';
import { MemoryAuditLogger } from './services/audit-logger.js';
import { MemoryWorkspaceStore } from './services/workspace-store.js';

function fixture() {
  const dependencies = createDefaultAgentApiDependencies(true);
  const audit = new MemoryAuditLogger();
  const app = createApp(new MemoryConfigStore(), audit, new MemoryWorkspaceStore(), undefined, dependencies);
  return { app, dependencies, audit };
}

async function waitForTerminal(app: ReturnType<typeof createApp>, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(app).get(`/api/agent-runs/${runId}`);
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(response.body.status as string)) return response;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('synthetic run did not complete');
}

async function waitForState(app: ReturnType<typeof createApp>, runId: string, state: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(app).get(`/api/agent-runs/${runId}`);
    if (response.body.status === state) return response;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`synthetic run did not reach ${state}`);
}

describe('agent control API', () => {
  it('identifies an unexpected failure by class without leaking its message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unexpected-observability-'));
    const dependencies = createDefaultAgentApiDependencies(true);
    dependencies.observability = new AgentLocalObservability(join(root, 'events.jsonl'), root);
    const audit = new MemoryAuditLogger();
    const app = createApp(new MemoryConfigStore(), audit, new MemoryWorkspaceStore(), undefined, dependencies);

    const original = dependencies.center.get.bind(dependencies.center);
    dependencies.center.get = async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'PRIVATE-VALUE-CANARY')");
    };
    const printedLines: string[] = [];
    const stderr = vi.spyOn(console, 'error')
      .mockImplementation((...parts: unknown[]) => { printedLines.push(parts.join(' ')); });
    let failed;
    try {
      failed = await request(app).get('/api/agent-runs/11111111-1111-4111-8111-111111111111');
    } finally {
      dependencies.center.get = original;
      stderr.mockRestore();
    }

    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain('PRIVATE-VALUE-CANARY');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The concrete class replaces the constant that every 500 used to share.
    const recorded = await dependencies.observability.readLocal();
    expect(recorded.at(-1)).toMatchObject({ level: 'error', errorClass: 'typeerror' });
    expect(audit.events.at(-1)).toMatchObject({ status: 500, category: 'typeerror' });
    expect(JSON.stringify(recorded)).not.toContain('PRIVATE-VALUE-CANARY');
    expect(JSON.stringify(audit.events)).not.toContain('PRIVATE-VALUE-CANARY');

    // stderr names the route and class, but not the message, unless asked.
    const printed = printedLines.join('\n');
    expect(printed).toContain('[unexpected-error]');
    expect(printed).toContain('class=typeerror');
    expect(printed).not.toContain('PRIVATE-VALUE-CANARY');
    await rm(root, { recursive: true, force: true });
  });

  it('prints the full stack only when the diagnostic switch is set', async () => {
    const dependencies = createDefaultAgentApiDependencies(true);
    const app = createApp(new MemoryConfigStore(), new MemoryAuditLogger(), new MemoryWorkspaceStore(), undefined, dependencies);
    const original = dependencies.center.get.bind(dependencies.center);
    dependencies.center.get = async () => { throw new TypeError('STACK-CANARY'); };
    const printedLines: string[] = [];
    const stderr = vi.spyOn(console, 'error')
      .mockImplementation((...parts: unknown[]) => { printedLines.push(parts.join(' ')); });
    const previous = process.env.JOB_MATCH_ERROR_STACKS;
    process.env.JOB_MATCH_ERROR_STACKS = '1';
    try {
      await request(app).get('/api/agent-runs/11111111-1111-4111-8111-111111111111');
    } finally {
      if (previous === undefined) delete process.env.JOB_MATCH_ERROR_STACKS;
      else process.env.JOB_MATCH_ERROR_STACKS = previous;
      dependencies.center.get = original;
      stderr.mockRestore();
    }
    const printed = printedLines.join('\n');
    expect(printed).toContain('class=typeerror');
    expect(printed).toContain('STACK-CANARY');
    expect(printed).toMatch(/at .*app\.(ts|js)/);
  });

  it('keeps a streaming response truthful when it fails after its headers were sent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stream-observability-'));
    const dependencies = createDefaultAgentApiDependencies(true);
    dependencies.observability = new AgentLocalObservability(join(root, 'events.jsonl'), root);
    const audit = new MemoryAuditLogger();
    const app = createApp(new MemoryConfigStore(), audit, new MemoryWorkspaceStore(), undefined, dependencies);
    const created = await request(app).post('/api/agent-runs')
      .send({ providerId: 'fake', prompt: 'synthetic', workspaceMode: 'read_only', network: false });
    const runId = created.body.id as string;
    await waitForTerminal(app, runId);

    // The stream sends its 200 headers before it polls, so this fails mid-body.
    const events = dependencies.center.events.bind(dependencies.center);
    dependencies.center.events = async () => {
      throw Object.assign(new Error('PRIVATE-STREAM-FAILURE-CANARY'), { code: 'ERR_SYNTHETIC_POLL' });
    };
    let stream;
    try {
      stream = await request(app).get(`/api/agent-runs/${runId}/stream`).set('Last-Event-ID', '0');
    } finally {
      dependencies.center.events = events;
    }

    // The client already received a 200; reporting 500 afterwards is a lie.
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.text).not.toContain('PRIVATE-STREAM-FAILURE-CANARY');
    expect(stream.text).not.toContain('urn:job-match-and-apply:error');

    await new Promise((resolve) => setTimeout(resolve, 50));
    const streamAudit = audit.events.filter((event) => event.operation.includes('/stream'));
    expect(streamAudit).toEqual([expect.objectContaining({ status: 200, category: 'stream_aborted' })]);

    // The failure stays visible by class, without its message.
    const recorded = await dependencies.observability.readLocal();
    const aborted = recorded.filter((entry) => entry.code === 'stream_aborted');
    expect(aborted).toEqual([expect.objectContaining({
      level: 'error', component: 'http', errorClass: 'error:err_synthetic_poll',
    })]);
    expect(JSON.stringify(recorded)).not.toContain('PRIVATE-STREAM-FAILURE-CANARY');
    await rm(root, { recursive: true, force: true });
  });

  it('still reports a normal failure with its real status and body', async () => {
    const { app, audit } = fixture();
    // Fails before any headers are sent, so the JSON contract must be intact.
    const rejected = await request(app).post('/api/agent-runs').send({ providerId: 'fake' });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({ category: 'validation', status: 400 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(audit.events.some((event) => event.status === 400)).toBe(true);
    expect(audit.events.every((event) => event.category !== 'stream_aborted')).toBe(true);
  });


  it('preflights exact data, tools, network and limits without starting the trusted-host MCP or an agent', async () => {
    const dependencies = createDefaultAgentApiDependencies(true);
    const workspace = new MemoryWorkspaceStore();
    const app = createApp(new MemoryConfigStore(), new MemoryAuditLogger(), workspace, undefined, dependencies);
    const canary = 'PREFLIGHT-PROMPT-MUST-NOT-ECHO-7e9f';
    const result = await request(app).post('/api/agent-runs/preflight').send({
      providerId: 'fake', prompt: canary, workspaceMode: 'read_only', network: false,
      workflowId: 'guided-job-analysis', budget: { wallTimeMinutes: 7, maxOutputMiB: 3 }
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toMatchObject({
      contract: 'agent-run-preflight', contractVersion: '1.0', ready: true,
      workspace: { ownership: 'server', mode: 'read_only', supported: true, pathDisclosed: false },
      data: {
        declaredScope: 'search_profile', exactSourceCount: null, actualManifestAvailableAfterStart: true,
        categories: expect.arrayContaining([
          { kind: 'search_preference', availability: 'included', trust: 'local', maxItems: 1 },
          { kind: 'job', availability: 'unknown_until_start', trust: 'untrusted', maxItems: 20 }
        ])
      },
      tools: { policy: 'deny_by_default', allowedRootMcpTools: [], allowlistComplete: true, providerToolNamesExposed: false },
      network: {
        requested: false, effective: 'disabled', enforced: true,
        trustedHostServices: [{ id: 'job-search-mcp', executionIsolation: 'trusted-host', agentAccessible: false, invocation: 'root_before_agent' }]
      },
      limits: { requested: { wallTimeMinutes: 7, maxOutputMiB: 3 }, effective: { wallTimeMs: 420_000, totalOutputBytes: 3 * 1024 * 1024 } }
    });
    expect(JSON.stringify(result.body)).not.toContain(canary);
    expect(JSON.stringify(result.body)).not.toContain(dependencies.workspaceRoot);
    expect(await dependencies.center.list()).toHaveLength(0);
    expect(await workspace.listSearchRuns()).toHaveLength(0);

    const blocked = await request(app).post('/api/agent-runs/preflight').send({
      providerId: 'fake', prompt: 'network request', workspaceMode: 'read_only', network: true
    });
    expect(blocked.status).toBe(200);
    expect(blocked.body).toMatchObject({ ready: false, network: { requested: true, effective: 'disabled', enforced: true } });
    expect(blocked.body.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'network_not_enforceable' })]));
  });

  it('prefetches guided job data on the trusted host before the offline agent starts', async () => {
    const dependencies = createDefaultAgentApiDependencies(true);
    const workspace = new MemoryWorkspaceStore();
    const app = createApp(new MemoryConfigStore(), new MemoryAuditLogger(), workspace, undefined, dependencies);
    const created = await request(app).post('/api/agent-runs').send({
      providerId: 'fake', prompt: 'Vergleiche die bereitgestellten Stellen.', workspaceMode: 'read_only',
      network: false, workflowId: 'guided-job-analysis'
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await waitForTerminal(app, created.body.id as string)).body.status).toBe('succeeded');
    const run = await dependencies.center.get(created.body.id as string);
    expect(run?.request).toMatchObject({ network: 'disabled', metadata: { hostJobSourceIsolation: 'trusted-host' } });
    expect(run?.request.metadata?.guidedSearchRunId).toMatch(/^[0-9a-f-]{36}$/);
    const searches = await workspace.listSearchRuns();
    expect(searches).toHaveLength(1);
    expect(searches[0]?.matches.length).toBeGreaterThan(0);
  });

  it('discovers the offline provider and reports missing CLIs without installing anything', async () => {
    const { app } = fixture();
    const response = await request(app).get('/api/agents/providers');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'fake', available: true, installations: expect.arrayContaining([expect.objectContaining({ support: 'supported' })]) }),
      expect.objectContaining({ id: 'codex-exec' }),
      expect.objectContaining({ id: 'opencode' }),
      expect.objectContaining({ id: 'claude-cli' }),
      expect.objectContaining({ id: 'acp', experimental: true, available: false }),
    ]));
    expect(response.text).not.toMatch(/api[_-]?key|password|secret/i);
  });

  it('exposes the complete synthetic approval and input loop', async () => {
    const { app, dependencies, audit } = fixture();
    const created = await request(app).post('/api/agent-runs').send({ providerId: 'fake-interactive', prompt: 'interactive test', workspaceMode: 'read_only', network: false });
    expect(created.status).toBe(201);
    const approvalState = await waitForState(app, created.body.id as string, 'waiting_for_approval');
    const approval = approvalState.body.pendingApprovals[0] as { id: string };
    expect(approval.id).toBe('approval-local-write');
    const inputCannotApprove = await request(app).post(`/api/agent-runs/${created.body.id}/input`).send({ input: 'approve', confirmed: true });
    expect(inputCannotApprove.status).toBe(409);
    expect((await request(app).get(`/api/agent-runs/${created.body.id}`)).body).toMatchObject({ status: 'waiting_for_approval' });
    expect((await request(app).post(`/api/agent-runs/${created.body.id}/approvals/${approval.id}`).send({ decision: 'approve', confirmed: true })).status).toBe(200);
    const inputState = await waitForState(app, created.body.id as string, 'waiting_for_input');
    expect(inputState.body.pendingInputRequest).toMatchObject({
      id: 'input-confirmation', kind: 'text', sensitive: true,
      requestedAt: expect.any(String), expiresAt: expect.any(String), requestedSequence: expect.any(Number),
    });
    const clientChosenActor = await request(app).post(`/api/agent-runs/${created.body.id}/input`).send({
      input: 'synthetic confirmation', confirmed: true, actor: { id: 'forged-admin', type: 'authenticated' }
    });
    expect(clientChosenActor.status).toBe(400);
    const canary = 'AGENT023-SENSITIVE-CANARY-7f87d933';
    expect((await request(app).post(`/api/agent-runs/${created.body.id}/input`).send({ input: canary, confirmed: true })).status).toBe(200);
    expect((await waitForTerminal(app, created.body.id as string)).body.status).toBe('succeeded');
    const events = await request(app).get(`/api/agent-runs/${created.body.id}/events?after=0`).expect(200);
    const receipt = events.body.events.find((event: { type: string }) => event.type === 'user_input_received') as {
      sequence: number; timestamp: string; data: Record<string, unknown>;
    };
    expect(receipt.data).toMatchObject({
      received: true, sensitive: true, requestId: 'input-confirmation',
      actor: { id: 'local-user', type: 'local' }, occurredAt: receipt.timestamp, runSequence: receipt.sequence,
    });
    expect(receipt.data.requestedSequence).toBeLessThan(receipt.sequence);
    expect(JSON.stringify(events.body)).not.toContain(canary);
    expect(JSON.stringify(await dependencies.store.export(created.body.id as string, { includeSensitive: true }))).not.toContain(canary);
    const stream = await request(app).get(`/api/agent-runs/${created.body.id}/stream`).set('Last-Event-ID', '0');
    expect(stream.status).toBe(200);
    expect(stream.text).not.toContain(canary);
    expect(stream.text).toContain('"id":"local-user"');
    const exported = await request(app).get(`/api/agent-runs/${created.body.id}/export`).expect(200);
    expect(exported.text).not.toContain(canary);
    await Promise.resolve();
    expect(JSON.stringify(audit.events)).not.toContain(canary);
  });

  it('runs the synthetic provider, exposes ordered replay and a redacted export', async () => {
    const { app } = fixture();
    const created = await request(app).post('/api/agent-runs').send({ providerId: 'fake', prompt: 'private synthetic prompt', workspaceMode: 'read_only', network: false });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ providerId: 'fake', request: { prompt: 'private synthetic prompt', workspaceMode: 'read_only', network: false } });
    const terminal = await waitForTerminal(app, created.body.id as string);
    expect(terminal.body).toMatchObject({ status: 'succeeded', output: 'synthetic result' });
    const replay = await request(app).get(`/api/agent-runs/${created.body.id}/events?after=0`);
    expect(replay.status).toBe(200);
    expect(replay.body.events.map((event: { sequence: number }, index: number) => event.sequence === index + 1).every(Boolean)).toBe(true);
    expect(replay.body.events.at(-1)).toMatchObject({ type: 'run_completed' });
    expect(new Set(replay.body.events.map((event: { correlationId: string }) => event.correlationId))).toEqual(new Set([created.headers['x-correlation-id']]));
    const stream = await request(app).get(`/api/agent-runs/${created.body.id}/stream`).set('Last-Event-ID', '0');
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.text).toContain('event: agent-event');
    expect(stream.text).toContain('id: 5');
    const exportResult = await request(app).get(`/api/agent-runs/${created.body.id}/export`);
    expect(exportResult.status).toBe(200);
    expect(exportResult.body).toMatchObject({ contract: 'agent-run-export', redacted: true, run: { request: { task: '[REDACTED]' } } });
    expect(exportResult.text).not.toContain('private synthetic prompt');
  });

  it('deduplicates retries and rejects reuse of an idempotency key for changed input', async () => {
    const { app } = fixture();
    const payload = { providerId: 'fake', prompt: 'same request', workspaceMode: 'read_only', network: false };
    const first = await request(app).post('/api/agent-runs').set('Idempotency-Key', 'test-run-0001').send(payload);
    const retry = await request(app).post('/api/agent-runs').set('Idempotency-Key', 'test-run-0001').send(payload);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    const conflict = await request(app).post('/api/agent-runs').set('Idempotency-Key', 'test-run-0001').send({ ...payload, prompt: 'changed' });
    expect(conflict.status).toBe(409);
    expect((await request(app).get('/api/agent-runs')).body).toHaveLength(1);
  });

  it('atomically coalesces concurrent requests with the same idempotency key', async () => {
    const { app } = fixture();
    const payload = { providerId: 'fake', prompt: 'one concurrent run', workspaceMode: 'read_only', network: false };
    const [first, second] = await Promise.all([
      request(app).post('/api/agent-runs').set('Idempotency-Key', 'test-run-concurrent-0001').send(payload),
      request(app).post('/api/agent-runs').set('Idempotency-Key', 'test-run-concurrent-0001').send(payload)
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(first.body.id).toBe(second.body.id);
    expect((await request(app).get('/api/agent-runs')).body).toHaveLength(1);
  });

  it('forgets the bounded in-process idempotency entry when retention removes its run', async () => {
    const { app } = fixture();
    const payload = { providerId: 'fake', prompt: 'retention-safe idempotency', workspaceMode: 'read_only', network: false };
    const first = await request(app).post('/api/agent-runs').set('Idempotency-Key', 'test-run-retention-0001').send(payload);
    await waitForTerminal(app, first.body.id as string);
    const before = new Date(Date.now() + 60_000).toISOString();
    const removed = await request(app).post('/api/agent-runs/retention/apply').send({ before, confirmation: `DELETE agent-runs before ${before}` });
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toContain(first.body.id);
    const recreated = await request(app).post('/api/agent-runs').set('Idempotency-Key', 'test-run-retention-0001').send(payload);
    expect(recreated.status).toBe(201);
    expect(recreated.body.id).not.toBe(first.body.id);
  });

  it('blocks browser-controlled command fields, network escalation and invalid control state', async () => {
    const { app } = fixture();
    const injected = await request(app).post('/api/agent-runs').send({ providerId: 'fake', prompt: 'x', workspaceMode: 'read_only', network: false, executable: 'powershell.exe', args: ['-c', 'evil'] });
    expect(injected.status).toBe(400);
    const network = await request(app).post('/api/agent-runs').send({ providerId: 'fake', prompt: 'x', workspaceMode: 'read_only', network: true });
    expect(network.status).toBe(409);
    const unavailableRuntime = await request(app).post('/api/agent-runs').send({ providerId: 'fake', prompt: 'x', workspaceMode: 'read_only', network: false, runtimeTarget: 'wsl', wslDistribution: 'Ubuntu' });
    expect(unavailableRuntime.status).toBe(409);
    const created = await request(app).post('/api/agent-runs').send({ providerId: 'fake', prompt: 'x', workspaceMode: 'read_only', network: false });
    await waitForTerminal(app, created.body.id as string);
    const input = await request(app).post(`/api/agent-runs/${created.body.id}/input`).send({ input: 'late', confirmed: true });
    expect(input.status).toBe(409);
    const resume = await request(app).post(`/api/agent-runs/${created.body.id}/resume`).send({ confirmed: true });
    expect(resume.status).toBe(409);
  });

  it('applies and releases an emergency stop explicitly', async () => {
    const { app, dependencies } = fixture();
    const openApproval = dependencies.approvalQueue.request({
      runId: 'pending-run', toolName: 'provider.interactive-action', target: 'synthetic-target',
      parameters: { id: 'synthetic' }, parameterPreview: { id: 'synthetic' }, risk: 'external_write'
    });
    expect((await request(app).post('/api/agents/emergency-stop').send({ enabled: true, confirmed: true })).body.enabled).toBe(true);
    expect(dependencies.approvalQueue.get(openApproval.id)?.status).toBe('revoked');
    expect((await request(app).post('/api/agent-runs').send({ providerId: 'fake', prompt: 'blocked', workspaceMode: 'read_only', network: false })).status).toBe(409);
    expect((await request(app).post('/api/agents/emergency-stop').send({ enabled: false, confirmed: true })).body.enabled).toBe(false);
    expect((await request(app).post('/api/agent-runs').send({ providerId: 'fake', prompt: 'allowed', workspaceMode: 'read_only', network: false })).status).toBe(201);
  });

  it('exports only a hashed, redacted support bundle and records the trusted-host MCP boundary', async () => {
    const { app } = fixture();
    const result = await request(app).get('/api/agents/support-bundle');
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toMatchObject({
      contract: 'agent-support-bundle', contractVersion: '1.0', redacted: true,
      payload: { jobSearchMcp: { mode: 'demo', executionIsolation: 'trusted-host', runtimeStatus: 'demo' } }
    });
    expect(result.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result.body)).not.toMatch(/prompt|private task|userPrompt/i);
  });

  it('exposes bounded queue diagnostics and revision-bound orphan cleanup', async () => {
    const { app, dependencies } = fixture();
    const queue = await request(app).get('/api/agents/queue');
    expect(queue.status).toBe(200);
    expect(queue.body).toMatchObject({ depth: 0, active: 0, limits: { global: 2, perProvider: 1 }, queue: [] });

    const timestamp = '2026-08-14T00:00:00.000Z';
    await dependencies.store.create({
      schemaVersion: AGENT_CONTRACT_VERSION, id: 'orphan-for-api', provider: 'fake', state: 'orphaned',
      requestedAt: timestamp, startedAt: timestamp, updatedAt: timestamp, currentSequence: 0,
      request: {
        provider: 'fake', task: 'synthetic recovery task', workspaceRoot: dependencies.workspaceRoot,
        runtimeTarget: (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux') as RuntimeTarget,
        sandbox: 'read-only', network: 'disabled', approvalMode: 'deny'
      }
    });
    const diagnostics = await request(app).get('/api/agents/recovery');
    expect(diagnostics.body.runs).toEqual(expect.arrayContaining([expect.objectContaining({ runId: 'orphan-for-api', processAdoptionAllowed: false })]));
    const staleLease = await request(app).post('/api/agent-runs/orphan-for-api/recovery/lease').send({ confirmed: true, expectedRevision: 1 });
    expect(staleLease.status).toBe(409);
    const lease = await request(app).post('/api/agent-runs/orphan-for-api/recovery/lease').send({ confirmed: true, expectedRevision: 0 });
    expect(lease.status).toBe(200);
    expect(lease.headers['cache-control']).toBe('no-store');
    const cleanup = await request(app).post('/api/agent-runs/orphan-for-api/recovery/resolve').send({
      confirmed: true, expectedRevision: 0, leaseId: lease.body.leaseId, decision: 'cleanup'
    });
    expect(cleanup.status).toBe(200);
    expect(cleanup.body.resolved).toMatchObject({ id: 'orphan-for-api', status: 'cancelled' });
  });
});
