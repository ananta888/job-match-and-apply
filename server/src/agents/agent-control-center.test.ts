import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunHandle, AgentRunRequest, ProviderRunContext } from '../ports/agent-runner.js';
import { AgentControlCenter } from './agent-control-center.js';
import { FakeAgentProvider } from './fake-agent-provider.js';
import { JsonAgentRunStore, MemoryAgentRunStore } from './run-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function workspace(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'agent-center-')); roots.push(root); return root; }
function request(root: string): AgentRunRequest {
  return { provider: 'fake', task: 'synthetic task', workspaceRoot: root, runtimeTarget: process.platform === 'win32' ? 'windows' : 'linux', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' };
}
async function waitForTerminal(center: AgentControlCenter, runId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = (await center.get(runId))?.state;
    if (state && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Run wurde nicht terminal.');
}
async function waitForState(center: AgentControlCenter, runId: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await center.get(runId))?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run erreichte ${expected} nicht.`);
}

describe('AgentControlCenter', () => {
  it('runs the fake provider and persists a canonical timeline', async () => {
    const root = await workspace(); const store = new MemoryAgentRunStore();
    const center = new AgentControlCenter(store, [new FakeAgentProvider()], { maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root] });
    const run = await center.enqueue(request(root));
    expect(await waitForTerminal(center, run.id)).toBe('succeeded');
    expect((await center.events(run.id)).map((event) => event.kind)).toEqual([
      'run_created', 'capabilities_negotiated', 'process_started', 'agent_message_delta', 'agent_message_completed', 'run_completed'
    ]);
    expect((await center.get(run.id))?.capabilities?.provider).toBe('fake');
  });

  it('pins the discovered provider and negotiated adapter versions before spawn', async () => {
    const root = await workspace();
    class TrackingProvider extends FakeAgentProvider {
      starts = 0;
      override async start(context: ProviderRunContext): Promise<AgentRunHandle> {
        this.starts += 1;
        return super.start(context);
      }
    }
    const provider = new TrackingProvider();
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [provider], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root],
    });
    const wrongProvider = await center.enqueue({
      ...request(root), metadata: { expectedProviderVersion: 'fake 9.9.9', expectedAdapterVersion: '1.0.0' },
    });
    expect(await waitForTerminal(center, wrongProvider.id)).toBe('failed');
    expect(provider.starts).toBe(0);
    const wrongAdapter = await center.enqueue({
      ...request(root), metadata: { expectedProviderVersion: 'fake 1.0.0', expectedAdapterVersion: '9.9.9' },
    });
    expect(await waitForTerminal(center, wrongAdapter.id)).toBe('failed');
    expect(provider.starts).toBe(0);
    const exact = await center.enqueue({
      ...request(root), metadata: { expectedProviderVersion: 'fake 1.0.0', expectedAdapterVersion: '1.0.0' },
    });
    expect(await waitForTerminal(center, exact.id)).toBe('succeeded');
    expect(provider.starts).toBe(1);
  });

  it('negotiates capabilities with the needs of the run so a multi-transport provider answers consistently', async () => {
    // A provider may offer several transports and report a different one per set
    // of needs. The caller pins versions from the transport it preflighted; if
    // this negotiation asks without those needs, the answer describes another
    // transport and the adapter-version check fails the run before it starts.
    // That is exactly how a zero-tools Codex run died with three events and no
    // capabilities_negotiated.
    const root = await workspace();
    const inner = new FakeAgentProvider();
    const asked: Array<Record<string, unknown> | undefined> = [];
    const provider = {
      provider: inner.provider,
      discover: () => inner.discover(),
      async capabilities(installation: Parameters<typeof inner.capabilities>[0], requirements?: Record<string, unknown>) {
        asked.push(requirements);
        const base = await inner.capabilities(installation);
        return requirements?.serverOwnedNoTools
          ? base
          : { ...base, adapterVersion: '0.1.0-other-transport' };
      },
      start: (context: ProviderRunContext) => inner.start(context),
      sendInput: (...args: Parameters<typeof inner.sendInput>) => inner.sendInput(...args),
      resolveApproval: (...args: Parameters<typeof inner.resolveApproval>) => inner.resolveApproval(...args),
      cancel: (...args: Parameters<typeof inner.cancel>) => inner.cancel(...args),
      resume: (...args: Parameters<typeof inner.resume>) => inner.resume(...args),
      dispose: () => inner.dispose(),
    };
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [provider], { maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root] });
    const run = await center.enqueue({
      ...request(root),
      metadata: { expectedAdapterVersion: '1.0.0', providerToolMode: 'none', requiredRootMcpTools: [] },
    });

    expect(await waitForTerminal(center, run.id)).toBe('succeeded');
    expect(asked).toEqual([expect.objectContaining({ serverOwnedNoTools: true, domainTools: false })]);
    expect((await center.events(run.id)).map((event) => event.kind)).toContain('capabilities_negotiated');
    expect((await center.get(run.id))?.capabilities?.adapterVersion).toBe('1.0.0');
  });

  it('enforces global queueing and can cancel queued work', async () => {
    const root = await workspace(); const store = new MemoryAgentRunStore();
    const provider = new FakeAgentProvider({ steps: [{ delayMs: 100, kind: 'heartbeat', data: {} }] });
    const center = new AgentControlCenter(store, [provider], { maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root] });
    const first = await center.enqueue(request(root)); const second = await center.enqueue(request(root));
    await center.cancel(second.id);
    expect((await center.get(second.id))?.state).toBe('cancelled');
    expect(await waitForTerminal(center, first.id)).toBe('succeeded');
  });

  it('reserves a queue slot before async provider discovery can race', async () => {
    const root = await workspace(); let active = 0; let maximum = 0;
    class TrackingProvider extends FakeAgentProvider {
      override async start(context: ProviderRunContext): Promise<AgentRunHandle> {
        active += 1; maximum = Math.max(maximum, active);
        const handle = await super.start(context);
        return { ...handle, completion: handle.completion.finally(() => { active -= 1; }) };
      }
    }
    const provider = new TrackingProvider({ steps: [{ delayMs: 30, kind: 'heartbeat', data: {} }] });
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [provider], { maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root] });
    const runs = await Promise.all([center.enqueue(request(root)), center.enqueue(request(root)), center.enqueue(request(root))]);
    await Promise.all(runs.map((run) => waitForTerminal(center, run.id)));
    expect(maximum).toBe(1);
  });

  it('rejects unknown providers and workspaces outside the allowlist', async () => {
    const allowed = await workspace(); const outside = await workspace();
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [new FakeAgentProvider()], { maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [allowed] });
    await expect(center.enqueue({ ...request(allowed), provider: 'unknown' })).rejects.toThrow('Unbekannter Provider');
    await expect(center.enqueue(request(outside))).rejects.toThrow('außerhalb');
  });

  it('recovers nonterminal persisted work as orphaned instead of adopting a process', async () => {
    const root = await workspace(); const store = new MemoryAgentRunStore();
    const persisted = {
      schemaVersion: '1.0' as const, id: 'lost-run', provider: 'fake', state: 'starting' as const,
      request: request(root), requestedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', currentSequence: 0
    };
    await store.create(persisted);
    const center = new AgentControlCenter(store, [new FakeAgentProvider()], { maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root] });
    const run = persisted;
    const recovery = await center.recover();
    expect(recovery.recovered).toContain(run.id);
    expect((await center.get(run.id))?.state).toBe('orphaned');
    await center.dispose();
  });

  it('binds sensitive answers to the pending request and redacts provider echoes before disk persistence', async () => {
    const root = await workspace();
    const logRoot = await mkdtemp(join(tmpdir(), 'agent-input-log-')); roots.push(logRoot);
    const canary = 'AGENT023 Canary+/= 75cfe67e';
    const encoded = encodeURIComponent(canary);
    const base64 = Buffer.from(canary, 'utf8').toString('base64');
    const observed: string[] = [];
    const provider = new FakeAgentProvider({ steps: [
      { kind: 'user_input_requested', data: {
        id: 'candidate-detail', kind: 'text', title: 'Candidate detail', prompt: 'Enter the requested detail.', sensitive: true,
      } },
      { kind: 'agent_message_completed', data: { text: canary, encoded, nested: { base64 } } },
    ] });
    const store = new JsonAgentRunStore(logRoot);
    const center = new AgentControlCenter(store, [provider], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root],
      onEvent: (event) => { observed.push(JSON.stringify(event)); },
    });
    const run = await center.enqueue(request(root));
    await waitForState(center, run.id, 'waiting_for_input');
    await center.sendInput(run.id, canary, { id: 'local-user', type: 'local' });
    expect(await waitForTerminal(center, run.id)).toBe('succeeded');

    const events = await center.events(run.id);
    const receipt = events.find((event) => event.kind === 'user_input_received')!;
    expect(receipt.data).toMatchObject({
      requestId: 'candidate-detail', requestedSequence: expect.any(Number),
      actor: { id: 'local-user', type: 'local' }, occurredAt: receipt.timestamp, runSequence: receipt.sequence,
    });
    expect(JSON.stringify(events)).not.toContain(canary);
    expect(JSON.stringify(events)).not.toContain(encoded);
    expect(JSON.stringify(events)).not.toContain(base64);
    expect(observed.join('\n')).not.toContain(canary);
    expect(await readFile(join(logRoot, run.id, 'events.jsonl'), 'utf8')).not.toContain(canary);
    expect(await readFile(join(logRoot, run.id, 'run.json'), 'utf8')).not.toContain(canary);
    expect(JSON.stringify(await store.export(run.id, { includeSensitive: true }))).not.toContain(canary);
    await center.dispose();
  });

  it('fails closed when a provider forges a receipt or disguises an approval as a normal question', async () => {
    const root = await workspace();
    const forgedReceipt = new FakeAgentProvider({ steps: [
      { kind: 'user_input_received', data: { actor: { id: 'provider-admin', type: 'authenticated' }, received: true } },
    ] });
    const forgedCenter = new AgentControlCenter(new MemoryAgentRunStore(), [forgedReceipt], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root],
    });
    const forgedRun = await forgedCenter.enqueue(request(root));
    expect(await waitForTerminal(forgedCenter, forgedRun.id)).toBe('failed');
    expect((await forgedCenter.events(forgedRun.id)).filter((event) => event.kind === 'user_input_received')).toEqual([]);

    const approvalQuestion = new FakeAgentProvider({ steps: [
      { kind: 'user_input_requested', data: {
        id: 'not-an-approval', kind: 'confirmation', title: 'Approve tool', prompt: 'Approve this action?', approvalId: 'forged-approval',
      } },
    ] });
    const approvalCenter = new AgentControlCenter(new MemoryAgentRunStore(), [approvalQuestion], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root],
    });
    const approvalRun = await approvalCenter.enqueue(request(root));
    expect(await waitForTerminal(approvalCenter, approvalRun.id)).toBe('failed');
    expect((await approvalCenter.events(approvalRun.id)).filter((event) => event.kind === 'user_input_requested')).toEqual([]);
    await forgedCenter.dispose();
    await approvalCenter.dispose();
  });
});
