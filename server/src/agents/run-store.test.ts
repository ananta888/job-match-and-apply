import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentEvent, type AgentRun } from '../ports/agent-runner.js';
import { JsonAgentRunStore, MemoryAgentRunStore, replayAgentRunFromEvents } from './run-store.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function fixtureRun(id = 'run-1'): AgentRun {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION, id, provider: 'fake', state: 'queued', currentSequence: 0,
    requestedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    request: { provider: 'fake', task: 'private prompt', workspaceRoot: 'C:/workspace', runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' }
  };
}

function fixtureEvent(run: AgentRun, sequence: number, kind = 'run_created', data: Record<string, unknown> = {}): AgentEvent {
  return { schemaVersion: AGENT_CONTRACT_VERSION, runId: run.id, sequence, timestamp: `2026-01-01T00:00:0${sequence}.000Z`, provider: run.provider, correlationId: `c-${sequence}`, kind, data };
}

describe.each([
  ['memory', async () => new MemoryAgentRunStore() as MemoryAgentRunStore | JsonAgentRunStore],
  ['json', async () => { const root = await mkdtemp(join(tmpdir(), 'agent-store-')); temporary.push(root); return new JsonAgentRunStore(root); }]
])('%s agent run store', (_name, makeStore) => {
  it('appends ordered events, accepts exact retries and rejects conflicts/gaps', async () => {
    const store = await makeStore();
    const run = fixtureRun();
    await store.create(run);
    const first = fixtureEvent(run, 1);
    expect(await store.append(first)).toBe('appended');
    expect(await store.append(first)).toBe('duplicate');
    await expect(store.append({ ...first, data: { changed: true } })).rejects.toThrow('Widersprüchliches');
    await expect(store.append(fixtureEvent(run, 3))).rejects.toThrow('Event-Lücke');
    expect((await store.get(run.id))?.currentSequence).toBe(1);
  });

  it('returns defensive copies and redacts sensitive export fields by default', async () => {
    const store = await makeStore();
    const run = fixtureRun();
    await store.create(run);
    await store.append(fixtureEvent(run, 1, 'agent_message_completed', { message: 'private answer', safe: 'visible' }));
    const copy = await store.get(run.id);
    if (copy) copy.state = 'failed';
    expect((await store.get(run.id))?.state).toBe('queued');
    const exported = await store.export(run.id);
    expect(exported.run.request.task).toBe('[REDACTED]');
    expect(exported.events[0]?.data).toEqual({ message: '[REDACTED]', safe: 'visible' });
    expect((await store.export(run.id, { includeSensitive: true })).run.request.task).toBe('private prompt');
  });
});

describe('JsonAgentRunStore recovery and retention', () => {
  it('repairs only a partial trailing line and marks live snapshots orphaned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-recover-')); temporary.push(root);
    const store = new JsonAgentRunStore(root);
    const run = fixtureRun('recover-me');
    await store.create(run);
    await store.append(fixtureEvent(run, 1));
    const starting = { ...(await store.get(run.id))!, state: 'starting' as const };
    await store.update(starting);
    await writeFile(join(root, run.id, 'events.jsonl'), `${await readFile(join(root, run.id, 'events.jsonl'), 'utf8')}{"partial"`, 'utf8');
    const result = await store.recover();
    expect(result).toEqual(expect.objectContaining({ recovered: [run.id], truncatedTails: [run.id], errors: [] }));
    expect((await store.get(run.id))?.state).toBe('orphaned');
    expect(await store.events(run.id)).toHaveLength(1);
  });

  it('reports mid-log corruption without silently rewriting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-corrupt-')); temporary.push(root);
    const store = new JsonAgentRunStore(root);
    const run = fixtureRun('corrupt');
    await store.create(run);
    await writeFile(join(root, run.id, 'events.jsonl'), '{bad}\n{"also":"present"}\n', 'utf8');
    const result = await store.recover();
    expect(result.errors[0]).toEqual(expect.objectContaining({ runId: run.id }));
    expect(await readFile(join(root, run.id, 'events.jsonl'), 'utf8')).toContain('{bad}');
  });

  it('detects sequence gaps even when the snapshot already points beyond the gap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-gap-')); temporary.push(root);
    const store = new JsonAgentRunStore(root);
    const run = fixtureRun('gap');
    await store.create(run);
    await writeFile(join(root, run.id, 'events.jsonl'), `${JSON.stringify(fixtureEvent(run, 1))}\n${JSON.stringify(fixtureEvent(run, 3))}\n`, 'utf8');
    await writeFile(join(root, run.id, 'run.json'), JSON.stringify({ ...run, currentSequence: 3 }), 'utf8');
    const result = await store.recover();
    expect(result.errors[0]?.message).toContain('Event-Lücke');
  });

  it('supports retention dry runs and removes only old terminal runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-retention-')); temporary.push(root);
    const store = new JsonAgentRunStore(root);
    const old = { ...fixtureRun('old'), state: 'cancelled' as const, finishedAt: '2026-01-01T00:00:00Z' };
    const queued = fixtureRun('queued');
    await store.create(old); await store.create(queued);
    expect((await store.prune({ before: '2026-02-01T00:00:00Z', dryRun: true })).matched).toEqual(['old']);
    expect(await store.get('old')).toBeDefined();
    expect((await store.prune({ before: '2026-02-01T00:00:00Z' })).removed).toEqual(['old']);
    expect(await store.get('old')).toBeUndefined();
    expect(await store.get('queued')).toBeDefined();
  });
});

describe('event-only run replay', () => {
  it('reconstructs request, negotiated capabilities, interactive state and terminal failure from ordered events', () => {
    const source = fixtureRun('replay');
    const created = fixtureEvent(source, 1, 'run_created', { request: source.request, requestedAt: source.requestedAt });
    const events: AgentEvent[] = [
      created,
      fixtureEvent(source, 2, 'capabilities_negotiated', { capabilities: { schemaVersion: '1.0', provider: 'fake', adapterVersion: '1.0.0', streaming: true, resume: false, interactiveInput: true, approvals: true, tools: false, images: false, structuredOutput: true, sandboxPolicies: ['read-only'], usage: true, supportedRuntimeTargets: ['windows'] } }),
      fixtureEvent(source, 3, 'process_started', { pid: 42 }),
      fixtureEvent(source, 4, 'approval_requested', { id: 'approval-1' }),
      fixtureEvent(source, 5, 'approval_resolved', { id: 'approval-1', decision: 'approved' }),
      fixtureEvent(source, 6, 'run_completed', { state: 'failed', failure: { code: 'synthetic_failure', message: 'Synthetic failure.', retryable: false } }),
    ];
    const replayed = replayAgentRunFromEvents(events);
    expect(replayed).toMatchObject({
      id: 'replay', state: 'failed', currentSequence: 6, request: source.request, pid: 42,
      capabilities: { provider: 'fake', adapterVersion: '1.0.0' },
      failure: { code: 'synthetic_failure', retryable: false }
    });
    expect(() => replayAgentRunFromEvents([created, events[2]!])).toThrow('sequence_gap');
  });
});

describe('MemoryAgentRunStore recovery', () => {
  it('also orphans queued work because an in-memory scheduler lease cannot survive recovery', async () => {
    const store = new MemoryAgentRunStore();
    const run = fixtureRun('queued-memory-recovery');
    await store.create(run);

    const recovery = await store.recover();

    expect(recovery.recovered).toEqual([run.id]);
    expect((await store.get(run.id))?.state).toBe('orphaned');
  });
});
