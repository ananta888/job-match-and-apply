import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunHandle, AgentRunRequest, ProviderRunContext } from '../ports/agent-runner.js';
import { AgentControlCenter } from './agent-control-center.js';
import { FakeAgentProvider } from './fake-agent-provider.js';
import { MemoryAgentRunStore } from './run-store.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-load-'));
  temporaryRoots.push(root);
  return root;
}

function makeRequest(root: string, index: number, priority = 0): AgentRunRequest {
  return {
    provider: 'fake',
    task: `deterministic load item ${index}`,
    workspaceRoot: root,
    runtimeTarget: process.platform === 'win32' ? 'windows' : 'linux',
    sandbox: 'read-only',
    network: 'disabled',
    approvalMode: 'deny',
    priority,
    metadata: { index },
  };
}

async function waitForTerminal(center: AgentControlCenter, runIds: readonly string[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(runIds.map(async (id) => (await center.get(id))?.state));
    if (states.every((state) => state && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(state))) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Runs did not settle: ${runIds.join(', ')}`);
}

describe('Agent Control Center deterministic load acceptance', () => {
  it('drains 64 fake runs without exceeding either concurrency limit', async () => {
    const root = await makeWorkspace();
    let active = 0;
    let maximumActive = 0;

    class TrackingProvider extends FakeAgentProvider {
      override async start(context: ProviderRunContext): Promise<AgentRunHandle> {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const handle = await super.start(context);
        return {
          ...handle,
          completion: handle.completion.finally(() => { active -= 1; }),
        };
      }
    }

    const provider = new TrackingProvider({
      steps: [{ delayMs: 2, kind: 'heartbeat', data: { source: 'load-test' } }],
      outcome: { state: 'succeeded' },
    });
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [provider], {
      maxParallel: 4,
      maxParallelPerProvider: 3,
      allowedWorkspaceRoots: [root],
    });

    const runs = await Promise.all(Array.from({ length: 64 }, (_, index) => center.enqueue(makeRequest(root, index))));
    await waitForTerminal(center, runs.map((run) => run.id));

    expect(maximumActive).toBe(3);
    expect(active).toBe(0);
    expect((await center.list()).filter((run) => run.state === 'succeeded')).toHaveLength(64);
    for (const run of runs) {
      const events = await center.events(run.id);
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(events.map((event) => event.kind)).toEqual([
        'run_created', 'capabilities_negotiated', 'process_started', 'heartbeat', 'run_completed'
      ]);
      expect(events.at(-1)?.data).toEqual({ state: 'succeeded' });
    }
    await center.dispose();
  });

  it('cancels a deterministic queued subset without starting it or starving survivors', async () => {
    const root = await makeWorkspace();
    const startedTasks: number[] = [];

    class TrackingProvider extends FakeAgentProvider {
      override async start(context: ProviderRunContext): Promise<AgentRunHandle> {
        startedTasks.push(context.request.metadata?.index as number);
        return super.start(context);
      }
    }

    const center = new AgentControlCenter(
      new MemoryAgentRunStore(),
      [new TrackingProvider({ steps: [{ delayMs: 25, kind: 'heartbeat', data: {} }] })],
      { maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root] },
    );
    const runs = await Promise.all(Array.from({ length: 20 }, (_, index) => center.enqueue(makeRequest(root, index))));
    const cancelled = runs.filter((_run, index) => index > 0 && index % 2 === 0);
    await Promise.all(cancelled.map((run) => center.cancel(run.id, 'load-test queued cancellation')));
    await waitForTerminal(center, runs.map((run) => run.id));

    const cancelledIds = new Set(cancelled.map((run) => run.id));
    for (const run of runs) {
      expect((await center.get(run.id))?.state).toBe(cancelledIds.has(run.id) ? 'cancelled' : 'succeeded');
      const kinds = (await center.events(run.id)).map((event) => event.kind);
      if (cancelledIds.has(run.id)) expect(kinds).not.toContain('process_started');
    }
    expect(startedTasks.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => index).filter((index) => index === 0 || index % 2 !== 0),
    );
    await center.dispose();
  });

  it('serializes a concurrent 400-event burst and supports lossless replay cursors', async () => {
    const root = await makeWorkspace();

    class BurstProvider extends FakeAgentProvider {
      override async start(context: ProviderRunContext): Promise<AgentRunHandle> {
        const completion = (async () => {
          await context.emit({ kind: 'process_started', data: { synthetic: true } });
          await Promise.all(Array.from({ length: 400 }, (_, index) => context.emit({
            kind: 'agent_message_delta',
            data: { index, text: `chunk-${index}` },
          })));
          await context.emit({ kind: 'run_completed', data: { state: 'succeeded' } });
          return { state: 'succeeded' as const };
        })();
        return { runId: context.runId, completion };
      }
    }

    const center = new AgentControlCenter(new MemoryAgentRunStore(), [new BurstProvider()], {
      maxParallel: 1,
      maxParallelPerProvider: 1,
      allowedWorkspaceRoots: [root],
    });
    const run = await center.enqueue(makeRequest(root, 1));
    await waitForTerminal(center, [run.id]);

    const all = await center.events(run.id);
    expect(all).toHaveLength(404);
    expect(all.map((event) => event.sequence)).toEqual(Array.from({ length: 404 }, (_, index) => index + 1));

    const replayA = await center.events(run.id, 0);
    const replayB = await center.events(run.id, 137);
    const replayC = await center.events(run.id, replayB.at(-1)?.sequence ?? 0);
    expect(replayA).toEqual(all);
    expect(replayB[0]?.sequence).toBe(138);
    expect(replayB.at(-1)?.sequence).toBe(404);
    expect(replayC).toEqual([]);
    expect(new Set(all.map((event) => `${event.runId}:${event.sequence}`)).size).toBe(404);
    await center.dispose();
  });
});
