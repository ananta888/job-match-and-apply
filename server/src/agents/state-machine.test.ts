import { describe, expect, it, vi } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentEvent, type AgentRun } from '../ports/agent-runner.js';
import { AgentTransitionError, allowedTransitions, canTransition, stateAfterEvent, transitionRun, transitionRunWithAudit } from './state-machine.js';

const run: AgentRun = {
  schemaVersion: AGENT_CONTRACT_VERSION,
  id: 'run-1', provider: 'fake', state: 'queued', currentSequence: 0,
  requestedAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z',
  request: {
    provider: 'fake', task: 'synthetic task', workspaceRoot: 'C:/tmp/work', runtimeTarget: 'windows',
    sandbox: 'read-only', network: 'disabled', approvalMode: 'deny'
  }
};

function event(kind: string, data: Record<string, unknown> = {}): AgentEvent {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION, runId: run.id, sequence: 1,
    timestamp: '2026-08-13T00:00:00.000Z', provider: 'fake', correlationId: 'correlation', kind, data
  };
}

describe('agent run state machine', () => {
  it('covers every state and permits the intended lifecycle', () => {
    expect(allowedTransitions('queued')).toContain('starting');
    expect(canTransition('running', 'waiting_for_approval')).toBe(true);
    expect(canTransition('waiting_for_approval', 'running')).toBe(true);
    expect(canTransition('orphaned', 'recovering')).toBe(true);
    expect(canTransition('succeeded', 'running')).toBe(false);
  });

  it('sets timestamps and keeps terminal states immutable', () => {
    const starting = transitionRun(run, 'starting', 'scheduled', new Date('2026-08-13T01:00:00Z'));
    const running = transitionRun(starting, 'running', 'spawned', new Date('2026-08-13T01:00:01Z'));
    const completed = transitionRun(running, 'succeeded', 'exit-0', new Date('2026-08-13T01:00:02Z'));
    expect(starting.startedAt).toBe('2026-08-13T01:00:00.000Z');
    expect(completed.finishedAt).toBe('2026-08-13T01:00:02.000Z');
    expect(() => transitionRun(completed, 'running', 'late event')).toThrow(AgentTransitionError);
  });

  it('reports invalid transitions to the audit callback', () => {
    const audit = vi.fn();
    expect(() => transitionRun(run, 'succeeded', 'not started', new Date('2026-08-13T01:00:00Z'), audit)).toThrow();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ from: 'queued', to: 'succeeded', reason: 'not started' }));
  });

  it('awaits durable invalid-transition auditing before rejecting', async () => {
    const persisted: string[] = [];
    await expect(transitionRunWithAudit(run, 'succeeded', 'not started', async (audit) => {
      await Promise.resolve();
      persisted.push(`${audit.from}->${audit.to}`);
    }, new Date('2026-08-13T01:00:00Z'))).rejects.toThrow(AgentTransitionError);
    expect(persisted).toEqual(['queued->succeeded']);
  });

  it('derives waits and terminal outcomes only from authoritative events', () => {
    expect(stateAfterEvent('running', event('approval_requested'))).toBe('waiting_for_approval');
    expect(stateAfterEvent('waiting_for_approval', event('approval_resolved'))).toBe('running');
    expect(stateAfterEvent('running', event('error'))).toBe('running');
    expect(stateAfterEvent('running', event('run_completed', { state: 'timed_out' }))).toBe('timed_out');
    expect(stateAfterEvent('running', event('run_completed', { state: 'made_up' }))).toBe('running');
  });
});
