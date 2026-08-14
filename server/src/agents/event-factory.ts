import { randomUUID } from 'node:crypto';
import {
  AGENT_CONTRACT_VERSION,
  type AgentEvent,
  type AgentEventDraft,
  type AgentRun
} from '../ports/agent-runner.js';

export function nextAgentEvent(run: AgentRun, draft: AgentEventDraft, now = new Date()): AgentEvent {
  const runCorrelationId = typeof run.request.metadata?.correlationId === 'string'
    && /^[a-zA-Z0-9_-]{8,80}$/.test(run.request.metadata.correlationId)
    ? run.request.metadata.correlationId : undefined;
  const sequence = run.currentSequence + 1;
  const timestamp = draft.timestamp ?? now.toISOString();
  const data = structuredClone(draft.data) as Record<string, unknown>;
  if (draft.kind === 'user_input_received') {
    // These audit coordinates are generated alongside the canonical envelope;
    // neither the browser nor a provider process can choose them.
    data.occurredAt = timestamp;
    data.runSequence = sequence;
  }
  return {
    schemaVersion: AGENT_CONTRACT_VERSION,
    runId: run.id,
    sequence,
    timestamp,
    provider: run.provider,
    correlationId: draft.correlationId ?? runCorrelationId ?? randomUUID(),
    kind: draft.kind,
    data
  };
}
