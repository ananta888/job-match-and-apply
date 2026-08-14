import type { AgentEvent, AgentRun, AgentRunState } from '../ports/agent-runner.js';

export const TERMINAL_AGENT_STATES = new Set<AgentRunState>([
  'cancelled', 'succeeded', 'failed', 'timed_out'
]);

const ALLOWED_TRANSITIONS: Readonly<Record<AgentRunState, readonly AgentRunState[]>> = {
  queued: ['starting', 'cancelling', 'cancelled'],
  starting: ['running', 'cancelling', 'failed', 'timed_out', 'orphaned'],
  running: ['waiting_for_input', 'waiting_for_approval', 'cancelling', 'succeeded', 'failed', 'timed_out', 'orphaned'],
  waiting_for_input: ['running', 'cancelling', 'failed', 'timed_out', 'orphaned'],
  waiting_for_approval: ['running', 'cancelling', 'failed', 'timed_out', 'orphaned'],
  cancelling: ['cancelled', 'failed', 'orphaned'],
  cancelled: [],
  succeeded: [],
  failed: [],
  timed_out: [],
  orphaned: ['recovering', 'cancelled'],
  recovering: ['queued', 'starting', 'running', 'failed', 'cancelled', 'orphaned']
};

export interface InvalidTransitionAudit {
  runId: string;
  from: AgentRunState;
  to: AgentRunState;
  reason: string;
  timestamp: string;
}

export class AgentTransitionError extends Error {
  constructor(readonly audit: InvalidTransitionAudit) {
    super(`Unzulässiger Agent-Statuswechsel ${audit.from} -> ${audit.to} (${audit.reason}).`);
    this.name = 'AgentTransitionError';
  }
}

export function canTransition(from: AgentRunState, to: AgentRunState): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionRun(
  run: AgentRun,
  to: AgentRunState,
  reason: string,
  now = new Date(),
  onInvalid?: (audit: InvalidTransitionAudit) => void
): AgentRun {
  if (run.state === to) return structuredClone(run);
  if (!canTransition(run.state, to)) {
    const audit = { runId: run.id, from: run.state, to, reason, timestamp: now.toISOString() };
    onInvalid?.(audit);
    throw new AgentTransitionError(audit);
  }

  const updated: AgentRun = { ...structuredClone(run), state: to, updatedAt: now.toISOString() };
  if (to === 'starting' && !updated.startedAt) updated.startedAt = now.toISOString();
  if (TERMINAL_AGENT_STATES.has(to)) updated.finishedAt = now.toISOString();
  return updated;
}

/** Persists a rejected transition before propagating the typed error. */
export async function transitionRunWithAudit(
  run: AgentRun,
  to: AgentRunState,
  reason: string,
  persistInvalid: (audit: InvalidTransitionAudit) => Promise<void>,
  now = new Date()
): Promise<AgentRun> {
  let rejected: InvalidTransitionAudit | undefined;
  try {
    return transitionRun(run, to, reason, now, (audit) => { rejected = audit; });
  } catch (error) {
    if (rejected) await persistInvalid(rejected);
    throw error;
  }
}

/**
 * Replays only events which carry canonical state meaning. Diagnostic/error events do not
 * implicitly terminate a run; the authoritative terminal marker is run_completed.
 */
export function stateAfterEvent(current: AgentRunState, event: AgentEvent): AgentRunState {
  // Late or replayed provider events must never mutate a terminal snapshot.
  if (TERMINAL_AGENT_STATES.has(current)) return current;
  switch (event.kind) {
    case 'process_started': return current === 'starting' ? 'running' : current;
    case 'approval_requested': return current === 'running' ? 'waiting_for_approval' : current;
    case 'approval_resolved': return current === 'waiting_for_approval' ? 'running' : current;
    case 'user_input_requested': return current === 'running' ? 'waiting_for_input' : current;
    case 'user_input_received': return current === 'waiting_for_input' ? 'running' : current;
    case 'run_completed': {
      const state = (event.data as Record<string, unknown>).state;
      return state === 'cancelled' || state === 'succeeded' || state === 'failed' || state === 'timed_out'
        ? state
        : current;
    }
    default: return current;
  }
}

export function allowedTransitions(state: AgentRunState): readonly AgentRunState[] {
  return [...ALLOWED_TRANSITIONS[state]];
}
