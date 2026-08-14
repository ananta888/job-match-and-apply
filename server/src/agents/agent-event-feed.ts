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

export type AgentEventAuthorization = (runId: string) => boolean;

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

  /** Authorization is evaluated before an entry is copied into the result page. */
  sinceAuthorized(after: number, authorize: AgentEventAuthorization, filter: AgentEventFeedFilter = {}, limit = 500): AgentEventFeedPage {
    if (typeof authorize !== 'function') throw new Error('agent_event_feed_authorization_required');
    const page = this.since(after, filter, 1_000);
    if (page.resetRequired) return page;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('agent_event_feed_limit_invalid');
    return {
      events: page.events.filter((entry) => authorize(entry.runId)).slice(0, limit).map((entry) => structuredClone(entry)),
      // Skipping an unauthorized item is intentional and must not replay it on reconnect.
      nextCursor: page.events.at(-1)?.cursor ?? page.nextCursor,
      resetRequired: false
    };
  }
}

export interface AgentEventDeliveryBatch {
  events: AgentEventFeedItem[];
  lastObservedCursor: number;
  resetRequired: boolean;
}

/**
 * Per-client, non-blocking delivery buffer. Overflow disconnect/reset is a
 * local policy decision and can never apply backpressure to a provider process.
 */
export class AgentEventDeliveryBuffer {
  private readonly pending: AgentEventFeedItem[] = [];
  private lastObservedCursor = 0;
  private resetRequired = false;
  private lastActivityAt: number;

  constructor(
    private readonly authorize: AgentEventAuthorization,
    private readonly capacity = 256,
    private readonly heartbeatMs = 15_000,
    now = new Date(),
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000) throw new Error('agent_event_delivery_capacity_invalid');
    if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs > 120_000) throw new Error('agent_event_delivery_heartbeat_invalid');
    this.lastActivityAt = now.getTime();
  }

  offer(item: AgentEventFeedItem, now = new Date()): 'accepted' | 'unauthorized' | 'duplicate' | 'reset_required' {
    if (!Number.isSafeInteger(item.cursor) || item.cursor < 1) throw new Error('agent_event_delivery_cursor_invalid');
    if (item.cursor <= this.lastObservedCursor) return 'duplicate';
    this.lastObservedCursor = item.cursor;
    this.lastActivityAt = now.getTime();
    if (!this.authorize(item.runId)) return 'unauthorized';
    if (this.resetRequired) return 'reset_required';
    if (this.pending.length >= this.capacity) {
      this.pending.splice(0);
      this.resetRequired = true;
      return 'reset_required';
    }
    // Feed items are metadata-only; no event payload or prompt is accepted by this API.
    this.pending.push(structuredClone(item));
    return 'accepted';
  }

  drain(limit = this.capacity): AgentEventDeliveryBatch {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.capacity) throw new Error('agent_event_delivery_limit_invalid');
    if (this.resetRequired) return { events: [], lastObservedCursor: this.lastObservedCursor, resetRequired: true };
    return { events: this.pending.splice(0, limit).map((entry) => structuredClone(entry)), lastObservedCursor: this.lastObservedCursor, resetRequired: false };
  }

  /** A fresh authorized snapshot must cover every cursor observed before overflow. */
  resumeFromSnapshot(snapshotCursor: number, now = new Date()): void {
    if (!Number.isSafeInteger(snapshotCursor) || snapshotCursor < this.lastObservedCursor) throw new Error('agent_event_delivery_snapshot_stale');
    this.pending.splice(0); this.lastObservedCursor = snapshotCursor; this.resetRequired = false; this.lastActivityAt = now.getTime();
  }

  heartbeatDue(now = new Date()): boolean { return now.getTime() - this.lastActivityAt >= this.heartbeatMs; }
  markHeartbeat(now = new Date()): void { this.lastActivityAt = now.getTime(); }
}
