import { describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentEvent, type AgentRun, type AgentRunState } from '../ports/agent-runner.js';
import { allowedTransitions, canTransition, stateAfterEvent, TERMINAL_AGENT_STATES, transitionRun } from './state-machine.js';
import { MemoryAgentRunStore } from './run-store.js';

const states: readonly AgentRunState[] = [
  'queued', 'starting', 'running', 'waiting_for_input', 'waiting_for_approval', 'cancelling',
  'cancelled', 'succeeded', 'failed', 'timed_out', 'orphaned', 'recovering',
];

const expected: Readonly<Record<AgentRunState, readonly AgentRunState[]>> = {
  queued: ['starting', 'cancelling', 'cancelled'],
  starting: ['running', 'cancelling', 'failed', 'timed_out', 'orphaned'],
  running: ['waiting_for_input', 'waiting_for_approval', 'cancelling', 'succeeded', 'failed', 'timed_out', 'orphaned'],
  waiting_for_input: ['running', 'cancelling', 'failed', 'timed_out', 'orphaned'],
  waiting_for_approval: ['running', 'cancelling', 'failed', 'timed_out', 'orphaned'],
  cancelling: ['cancelled', 'failed', 'orphaned'],
  cancelled: [], succeeded: [], failed: [], timed_out: [],
  orphaned: ['recovering', 'cancelled'],
  recovering: ['queued', 'starting', 'running', 'failed', 'cancelled', 'orphaned'],
};

function run(state: AgentRunState, id = `property-${state}`): AgentRun {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION, id, provider: 'fake', state, currentSequence: 0,
    requestedAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
    request: {
      provider: 'fake', task: 'synthetic property task', workspaceRoot: 'C:/synthetic', runtimeTarget: 'windows',
      sandbox: 'read-only', network: 'disabled', approvalMode: 'deny',
    },
  };
}

function event(fixture: AgentRun, sequence: number, kind: string, data: Record<string, unknown> = {}): AgentEvent {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION, runId: fixture.id, provider: fixture.provider, sequence,
    timestamp: `2026-08-14T00:00:${String(sequence).padStart(2, '0')}.000Z`, correlationId: `property-${sequence}`, kind, data,
  };
}

describe('state-machine deterministic transition properties', () => {
  it('pins the complete transition matrix for every state pair', () => {
    expect(new Set(states)).toEqual(new Set(Object.keys(expected)));
    for (const from of states) {
      expect(new Set(allowedTransitions(from)), from).toEqual(new Set(expected[from]));
      for (const to of states) expect(canTransition(from, to), `${from}->${to}`).toBe(from === to || expected[from].includes(to));
    }
  });

  it('keeps every terminal state immutable under every transition and provider event mutation', () => {
    const lateEvents = [
      event(run('running'), 1, 'process_started'),
      event(run('running'), 1, 'approval_requested'),
      event(run('running'), 1, 'user_input_requested'),
      ...(['cancelled', 'succeeded', 'failed', 'timed_out'] as const).map((state) => event(run('running'), 1, 'run_completed', { state })),
    ];
    for (const terminal of TERMINAL_AGENT_STATES) {
      const fixture = run(terminal);
      for (const target of states) {
        if (target === terminal) expect(transitionRun(fixture, target, 'idempotent')).toEqual(fixture);
        else expect(() => transitionRun(fixture, target, 'terminal mutation'), `${terminal}->${target}`).toThrow();
      }
      for (const late of lateEvents) expect(stateAfterEvent(terminal, late), `${terminal}:${late.kind}`).toBe(terminal);
    }
  });

  it('rejects sequence gaps and conflicting replay while preserving a terminal snapshot after late events', async () => {
    const store = new MemoryAgentRunStore();
    const fixture = run('starting', 'sequence-mutation');
    await store.create(fixture);
    const first = event(fixture, 1, 'process_started');
    await expect(store.append(first)).resolves.toBe('appended');
    await expect(store.append(first)).resolves.toBe('duplicate');
    await expect(store.append({ ...first, data: { mutated: true } })).rejects.toThrow('Widerspr');
    await expect(store.append(event(fixture, 3, 'heartbeat'))).rejects.toThrow('Event-L');
    await store.append(event(fixture, 2, 'run_completed', { state: 'succeeded' }));
    await store.append(event(fixture, 3, 'run_completed', { state: 'failed' }));
    expect((await store.get(fixture.id))?.state).toBe('succeeded');
    expect((await store.events(fixture.id)).map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  });
});
