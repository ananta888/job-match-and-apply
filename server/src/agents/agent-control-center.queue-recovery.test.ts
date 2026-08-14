import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRun, AgentRunHandle, AgentRunRequest, ProviderRunContext } from '../ports/agent-runner.js';
import { AgentControlCenter } from './agent-control-center.js';
import { FakeAgentProvider } from './fake-agent-provider.js';
import { MemoryAgentRunStore } from './run-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-queue-policy-'));
  roots.push(root);
  return root;
}

function request(root: string, ownerId = 'owner-a', priority = 0): AgentRunRequest {
  return {
    provider: 'fake', task: `synthetic ${ownerId}`, workspaceRoot: root,
    runtimeTarget: process.platform === 'win32' ? 'windows' : 'linux',
    sandbox: 'read-only', network: 'disabled', approvalMode: 'deny', priority,
    metadata: { ownerId },
  };
}

async function waitFor(center: AgentControlCenter, runId: string, state: AgentRun['state']): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await center.get(runId))?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`${runId} erreichte ${state} nicht.`);
}

async function cancelAll(center: AgentControlCenter, runIds: readonly string[]): Promise<void> {
  await Promise.all(runIds.map((runId) => center.cancel(runId, 'synthetic test cleanup')));
  await Promise.all(runIds.map((runId) => waitFor(center, runId, 'cancelled')));
  await center.dispose();
}

describe('AgentControlCenter queue policies', () => {
  it('enforces atomic workspace and owner queue admission with explicit diagnostics', async () => {
    const root = await workspace();
    const center = new AgentControlCenter(
      new MemoryAgentRunStore(),
      [new FakeAgentProvider({ steps: [{ delayMs: 200, kind: 'heartbeat', data: {} }] })],
      {
        maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root],
        maxQueuedPerWorkspace: 1, maxQueuedPerOwner: 1,
      },
    );
    const active = await center.enqueue(request(root, 'active'));
    await waitFor(center, active.id, 'running');
    const queued = await center.enqueue(request(root, 'queued'));
    await expect(center.enqueue(request(root, 'third-owner'))).rejects.toMatchObject({
      code: 'queue_workspace_limit', limit: 1, current: 1,
    });
    const diagnostic = await center.getQueueDiagnostics();
    expect(diagnostic).toEqual(expect.objectContaining({ depth: 1, active: 1 }));
    expect(diagnostic.queue[0]).toEqual(expect.objectContaining({
      runId: queued.id, ownerId: 'queued', blockedBy: expect.arrayContaining(['global_limit', 'provider_limit']),
    }));
    await cancelAll(center, [active.id, queued.id]);
  });

  it('applies bounded aging so old low-priority work cannot starve', async () => {
    const root = await workspace();
    let nowMs = Date.parse('2026-08-13T12:00:00.000Z');
    const center = new AgentControlCenter(
      new MemoryAgentRunStore(),
      [new FakeAgentProvider({ steps: [{ delayMs: 200, kind: 'heartbeat', data: {} }] })],
      {
        maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root], now: () => new Date(nowMs),
        queueAgingIntervalMs: 1_000, queueAgingPriorityStep: 10, queueAgingMaxBoost: 100,
      },
    );
    const active = await center.enqueue(request(root, 'active'));
    await waitFor(center, active.id, 'running');
    const old = await center.enqueue(request(root, 'old', -20));
    nowMs += 12_000;
    const recent = await center.enqueue(request(root, 'recent', 50));
    const diagnostic = await center.getQueueDiagnostics();
    expect(diagnostic.queue.map((item) => item.runId)).toEqual([old.id, recent.id]);
    expect(diagnostic.queue[0]?.effectivePriority).toBe(80);
    expect(diagnostic.queue[1]?.effectivePriority).toBe(50);
    await cancelAll(center, [active.id, old.id, recent.id]);
  });

  it('skips saturated workspace and owner scopes while scheduling eligible work fairly', async () => {
    const firstRoot = await workspace();
    const secondRoot = await workspace();
    const center = new AgentControlCenter(
      new MemoryAgentRunStore(),
      [new FakeAgentProvider({ steps: [{ delayMs: 200, kind: 'heartbeat', data: {} }] })],
      {
        maxParallel: 3, maxParallelPerProvider: 3, maxParallelPerWorkspace: 1, maxParallelPerOwner: 1,
        allowedWorkspaceRoots: [firstRoot, secondRoot],
      },
    );
    const first = await center.enqueue(request(firstRoot, 'owner-a'));
    await waitFor(center, first.id, 'running');
    const workspaceBlocked = await center.enqueue(request(firstRoot, 'owner-b'));
    const ownerBlocked = await center.enqueue(request(secondRoot, 'owner-a'));
    const eligible = await center.enqueue(request(secondRoot, 'owner-b'));
    await waitFor(center, eligible.id, 'running');

    const diagnostic = await center.getQueueDiagnostics();
    expect(diagnostic.active).toBe(2);
    expect(diagnostic.queue.find((item) => item.runId === workspaceBlocked.id)?.blockedBy).toContain('workspace_limit');
    expect(diagnostic.queue.find((item) => item.runId === ownerBlocked.id)?.blockedBy).toContain('owner_limit');
    await cancelAll(center, [first.id, workspaceBlocked.id, ownerBlocked.id, eligible.id]);
  });

  it('requires owner metadata whenever an owner-scoped limit is configured', async () => {
    const root = await workspace();
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [new FakeAgentProvider()], {
      maxParallel: 1, maxParallelPerProvider: 1, maxParallelPerOwner: 1, allowedWorkspaceRoots: [root],
    });
    await expect(center.enqueue({ ...request(root), metadata: undefined })).rejects.toMatchObject({ code: 'owner_metadata_required' });
  });
});

describe('AgentControlCenter operator recovery leases', () => {
  it('fails closed for missing/wrong/expired leases and cleans up only after an operator decision', async () => {
    const root = await workspace();
    const store = new MemoryAgentRunStore();
    const persisted: AgentRun = {
      schemaVersion: '1.0', id: 'orphan-cleanup', provider: 'fake', state: 'starting', currentSequence: 0,
      requestedAt: '2026-08-13T12:00:00.000Z', updatedAt: '2026-08-13T12:00:00.000Z', request: request(root),
    };
    await store.create(persisted);
    let nowMs = Date.parse('2026-08-13T12:01:00.000Z');
    const center = new AgentControlCenter(store, [new FakeAgentProvider()], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root],
      now: () => new Date(nowMs), recoveryLeaseMs: 1_000, leaseId: () => 'lease-cleanup',
    });
    await center.recover();
    expect((await center.getRecoveryDiagnostics())[0]).toEqual(expect.objectContaining({
      runId: persisted.id, processAdoptionAllowed: false, allowedDecisions: ['cleanup', 'resume'],
    }));
    const lease = await center.acquireRecoveryLease(persisted.id, 'operator-a');
    await expect(center.resolveRecovery(persisted.id, lease.leaseId, 'operator-b', 'cleanup')).rejects.toThrow('anderen Operator');
    nowMs += 1_001;
    await expect(center.resolveRecovery(persisted.id, lease.leaseId, 'operator-a', 'cleanup')).rejects.toThrow('abgelaufen');
    const renewed = await center.acquireRecoveryLease(persisted.id, 'operator-a');
    const result = await center.resolveRecovery(persisted.id, renewed.leaseId, 'operator-a', 'cleanup');
    expect(result.resolved.state).toBe('cancelled');
    expect(result.resolved.failure?.code).toBe('recovery_cleaned_up');
  });

  it('resumes as a newly queued process and never calls provider resume on foreign state', async () => {
    const root = await workspace();
    const store = new MemoryAgentRunStore();
    const persisted: AgentRun = {
      schemaVersion: '1.0', id: 'foreign-session', provider: 'fake', state: 'starting', currentSequence: 0,
      providerSessionId: 'must-not-be-adopted', requestedAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z', request: request(root),
    };
    await store.create(persisted);
    let resumeCalls = 0;
    class NoAdoptionProvider extends FakeAgentProvider {
      override async resume(runId: string, input?: string): Promise<AgentRunHandle> {
        resumeCalls += 1;
        void input;
        return super.resume(runId);
      }
      override async start(context: ProviderRunContext): Promise<AgentRunHandle> { return super.start(context); }
    }
    const center = new AgentControlCenter(store, [new NoAdoptionProvider()], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root], leaseId: () => 'lease-resume',
    });
    await center.recover();
    const lease = await center.acquireRecoveryLease(persisted.id, 'operator-a');
    const result = await center.resolveRecovery(persisted.id, lease.leaseId, 'operator-a', 'resume', 'new operator input');
    expect(result.replacement?.id).not.toBe(persisted.id);
    expect(result.replacement?.providerSessionId).toBeUndefined();
    expect(result.replacement?.request.metadata).toEqual(expect.objectContaining({
      recoveryOf: persisted.id, recoveryMode: 'new-process', recoveryOperator: 'operator-a',
    }));
    expect(resumeCalls).toBe(0);
    await waitFor(center, result.replacement!.id, 'succeeded');
    await center.dispose();
  });

  it('rolls a rejected replacement admission back to orphaned without adopting the old session', async () => {
    const root = await workspace();
    const store = new MemoryAgentRunStore();
    const persisted: AgentRun = {
      schemaVersion: '1.0', id: 'replacement-rejected', provider: 'fake', state: 'starting', currentSequence: 0,
      providerSessionId: 'foreign-session', requestedAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z', request: request(root, 'recovery-owner'),
    };
    await store.create(persisted);
    const center = new AgentControlCenter(
      store,
      [new FakeAgentProvider({ steps: [{ delayMs: 200, kind: 'heartbeat', data: {} }] })],
      {
        maxParallel: 1, maxParallelPerProvider: 1, maxQueued: 1, allowedWorkspaceRoots: [root],
        leaseId: () => 'lease-rejected',
      },
    );
    await center.recover();
    const active = await center.enqueue(request(root, 'active-owner'));
    await waitFor(center, active.id, 'running');
    const queued = await center.enqueue(request(root, 'queue-owner'));
    const lease = await center.acquireRecoveryLease(persisted.id, 'operator-a');
    await expect(center.resolveRecovery(persisted.id, lease.leaseId, 'operator-a', 'resume')).rejects.toMatchObject({
      code: 'queue_global_limit',
    });
    expect((await center.get(persisted.id))?.state).toBe('orphaned');
    expect((await center.get(persisted.id))?.providerSessionId).toBe('foreign-session');
    expect((await center.getRecoveryDiagnostics()).find((item) => item.runId === persisted.id)?.processAdoptionAllowed).toBe(false);
    await cancelAll(center, [active.id, queued.id]);
  });
});
