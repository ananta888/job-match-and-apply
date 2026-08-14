import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentEvent, type AgentRun } from '../ports/agent-runner.js';
import { JsonAgentRunStore } from './run-store.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function run(id: string): AgentRun {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION,
    id,
    provider: 'fake',
    state: 'queued',
    currentSequence: 0,
    requestedAt: '2026-08-13T12:00:00.000Z',
    updatedAt: '2026-08-13T12:00:00.000Z',
    request: {
      provider: 'fake',
      task: `recovery ${id}`,
      workspaceRoot: '/portable/workspace',
      runtimeTarget: 'linux',
      sandbox: 'read-only',
      network: 'disabled',
      approvalMode: 'deny',
    },
  };
}

function event(fixture: AgentRun, sequence: number, kind: string, data: Record<string, unknown>): AgentEvent {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION,
    runId: fixture.id,
    sequence,
    timestamp: `2026-08-13T12:00:${String(sequence).padStart(2, '0')}.000Z`,
    provider: fixture.provider,
    correlationId: `${fixture.id}-${sequence}`,
    kind,
    data,
  };
}

describe('JsonAgentRunStore multi-run recovery acceptance', () => {
  it('repairs only incomplete tails while isolating an independently corrupt run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-recovery-matrix-'));
    temporaryRoots.push(root);
    const store = new JsonAgentRunStore(root);
    const tail = run('partial-tail');
    const corrupt = run('mid-log-corrupt');
    const healthy = run('healthy-terminal');
    await store.create(tail);
    await store.create(corrupt);
    await store.create(healthy);

    await store.append(event(tail, 1, 'run_created', {}));
    await store.update({ ...(await store.get(tail.id))!, state: 'starting' });
    await store.append(event(tail, 2, 'process_started', { pid: 123 }));
    await writeFile(
      join(root, tail.id, 'events.jsonl'),
      `${await readFile(join(root, tail.id, 'events.jsonl'), 'utf8')}{"sequence":3`,
      'utf8',
    );

    const corruptFirst = event(corrupt, 1, 'run_created', {});
    const corruptThird = event(corrupt, 3, 'heartbeat', {});
    await writeFile(
      join(root, corrupt.id, 'events.jsonl'),
      `${JSON.stringify(corruptFirst)}\n{not-json}\n${JSON.stringify(corruptThird)}\n`,
      'utf8',
    );

    await store.append(event(healthy, 1, 'run_created', {}));
    await store.update({ ...(await store.get(healthy.id))!, state: 'starting' });
    await store.append(event(healthy, 2, 'process_started', { pid: 456 }));
    await store.append(event(healthy, 3, 'run_completed', { state: 'succeeded' }));

    const result = await store.recover();

    expect(result.truncatedTails).toEqual(['partial-tail']);
    expect(result.recovered).toEqual(['partial-tail']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual(expect.objectContaining({ runId: 'mid-log-corrupt' }));
    expect(result.errors[0]?.message).toContain('Zeile 2');
    expect((await store.get(tail.id))?.state).toBe('orphaned');
    expect((await store.get(healthy.id))?.state).toBe('succeeded');
    expect(await store.events(tail.id)).toHaveLength(2);
    expect(await readFile(join(root, tail.id, 'events.jsonl'), 'utf8')).not.toContain('{"sequence":3');
    expect(await readFile(join(root, corrupt.id, 'events.jsonl'), 'utf8')).toContain('{not-json}');
  });

  it('reports a complete-but-malformed final line instead of treating it as a crash tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-recovery-newline-'));
    temporaryRoots.push(root);
    const store = new JsonAgentRunStore(root);
    const fixture = run('malformed-final-line');
    await store.create(fixture);
    await writeFile(join(root, fixture.id, 'events.jsonl'), '{broken-but-complete}\n', 'utf8');

    const result = await store.recover();

    expect(result.truncatedTails).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.runId).toBe(fixture.id);
    expect(await readFile(join(root, fixture.id, 'events.jsonl'), 'utf8')).toBe('{broken-but-complete}\n');
  });

  it('does not silently execute a queued request after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-recovery-queued-'));
    temporaryRoots.push(root);
    const store = new JsonAgentRunStore(root);
    const queued = run('queued-before-restart');
    await store.create(queued);
    await store.append(event(queued, 1, 'run_created', {}));

    const result = await store.recover();

    expect(result.recovered).toContain(queued.id);
    expect((await store.get(queued.id))?.state).toBe('orphaned');
  });
});
