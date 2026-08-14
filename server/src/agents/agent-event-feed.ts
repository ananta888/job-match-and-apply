import type { AgentEvent } from '../ports/agent-runner.js';

export interface AgentEventFeedItem {
  cursor: number;
  runId: string;
  runSequence: number;
  provider: string;
  type: string;
  timestamp: string;
  correlationId: string;
}

export interface AgentEventFeedFilter { runId?: string; provider?: string; type?: string; }

export interface AgentEventFeedPage {
  events: AgentEventFeedItem[];
  nextCursor: number;
  resetRequired: boolean;
}

/**
 * Bounded process-local index for the global UI stream. Payload data is
 * intentionally absent; clients fetch authorized per-run details separately.
 */
export class AgentEventFeed {
  private cursor = 0;
  private readonly entries: AgentEventFeedItem[] = [];

  constructor(private readonly capacity = 4_096) {
    if (!Number.isSafeInteger(capacity) || capacity < 16 || capacity > 100_000) throw new Error('agent_event_feed_capacity_invalid');
  }

  append(event: AgentEvent): AgentEventFeedItem {
    const item: AgentEventFeedItem = Object.freeze({
      cursor: ++this.cursor, runId: event.runId, runSequence: event.sequence,
      provider: event.provider, type: event.kind, timestamp: event.timestamp,
      correlationId: event.correlationId
    });
    this.entries.push(item);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    return structuredClone(item);
  }

  currentCursor(): number { return this.cursor; }

  since(after: number, filter: AgentEventFeedFilter = {}, limit = 500): AgentEventFeedPage {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('agent_event_feed_cursor_invalid');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('agent_event_feed_limit_invalid');
    const oldest = this.entries[0]?.cursor ?? this.cursor + 1;
    if (after > this.cursor || (after > 0 && after < oldest - 1)) {
      return { events: [], nextCursor: this.cursor, resetRequired: true };
    }
    const events = this.entries
      .filter((entry) => entry.cursor > after
        && (!filter.runId || entry.runId === filter.runId)
        && (!filter.provider || entry.provider === filter.provider)
        && (!filter.type || entry.type === filter.type))
      .slice(0, limit)
      .map((entry) => structuredClone(entry));
    return { events, nextCursor: events.at(-1)?.cursor ?? Math.max(after, this.cursor), resetRequired: false };
  }
}
