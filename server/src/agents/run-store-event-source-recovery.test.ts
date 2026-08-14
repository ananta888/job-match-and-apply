import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentEvent, type AgentRun } from '../ports/agent-runner.js';
import { JsonAgentRunStore } from './run-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function run(id: string): AgentRun {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION, id, provider: 'fake', state: 'queued', currentSequence: 0,
    requestedAt: '2026-08-14T10:00:00.000Z', updatedAt: '2026-08-14T10:00:00.000Z',
    request: {
      provider: 'fake', task: 'event-sourced recovery fixture', workspaceRoot: 'C:/temporary-workspace',
      runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny',
    },
  };
}

function event(fixture: AgentRun, sequence: number, kind: string, data: Record<string, unknown>): AgentEvent {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION, runId: fixture.id, provider: fixture.provider, sequence,
    timestamp: `2026-08-14T10:00:0${sequence}.000Z`, correlationId: 'recovery-correlation', kind, data,
  };
}

async function storeWithTimeline(id: string, terminal = false): Promise<{ root: string; store: JsonAgentRunStore; fixture: AgentRun }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-event-recovery-'));
  roots.push(root);
  const store = new JsonAgentRunStore(root);
  const fixture = run(id);
  await store.create(fixture);
  await store.append(event(fixture, 1, 'run_created', { request: fixture.request, requestedAt: fixture.requestedAt }));
  await store.update({ ...(await store.get(fixture.id))!, state: 'starting' });
  await store.append(event(fixture, 2, 'process_started', { pid: 42 }));
  if (terminal) await store.append(event(fixture, 3, 'run_completed', { state: 'succeeded' }));
  return { root, store, fixture };
}

describe('JsonAgentRunStore event-source recovery', () => {
  it('rebuilds a missing snapshot from the complete event stream and orphans live work', async () => {
    const { root, fixture } = await storeWithTimeline('missing-snapshot');
    await unlink(join(root, fixture.id, 'run.json'));

    const restarted = new JsonAgentRunStore(root);
    await expect(restarted.recover()).resolves.toEqual({
      recovered: [fixture.id], truncatedTails: [], errors: [],
    });
    await expect(restarted.get(fixture.id)).resolves.toMatchObject({
      id: fixture.id, request: fixture.request, currentSequence: 2, state: 'orphaned', pid: 42,
    });
  });

  it('rebuilds a corrupt snapshot but preserves the immutable terminal event result', async () => {
    const { root, fixture } = await storeWithTimeline('corrupt-snapshot', true);
    await writeFile(join(root, fixture.id, 'run.json'), '{corrupt', 'utf8');

    const restarted = new JsonAgentRunStore(root);
    await expect(restarted.recover()).resolves.toEqual({
      recovered: [fixture.id], truncatedTails: [], errors: [],
    });
    await expect(restarted.get(fixture.id)).resolves.toMatchObject({
      id: fixture.id, request: fixture.request, currentSequence: 3, state: 'succeeded',
      finishedAt: '2026-08-14T10:00:03.000Z',
    });
  });
});
