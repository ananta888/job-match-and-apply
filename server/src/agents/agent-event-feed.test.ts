import { describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentEvent } from '../ports/agent-runner.js';
import { AgentEventDeliveryBuffer, AgentEventFeed } from './agent-event-feed.js';

function event(runId: string, sequence: number, provider = 'fake'): AgentEvent {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION, runId, sequence, provider,
    timestamp: '2026-08-14T00:00:00.000Z', correlationId: `${runId}-${sequence}`,
    kind: 'agent_message_completed', data: { text: 'must never enter global feed', token: 'secret' }
  };
}

describe('AgentEventFeed', () => {
  it('assigns one global cursor, filters, and never copies event payloads', () => {
    const feed = new AgentEventFeed(16);
    feed.append(event('one', 1));
    feed.append(event('two', 1, 'other'));
    feed.append(event('one', 2));
    expect(feed.since(0, { runId: 'one' }).events.map((item) => item.cursor)).toEqual([1, 3]);
    expect(JSON.stringify(feed.since(0))).not.toMatch(/must never|secret|"data"/);
    expect(feed.since(1, { provider: 'other' }).events).toEqual([expect.objectContaining({ cursor: 2, runId: 'two' })]);
  });

  it('requires a snapshot reset when the bounded cursor was lost', () => {
    const feed = new AgentEventFeed(16);
    for (let index = 1; index <= 20; index += 1) feed.append(event('run', index));
    expect(feed.since(1)).toMatchObject({ events: [], nextCursor: 20, resetRequired: true });
    expect(feed.since(20)).toMatchObject({ events: [], nextCursor: 20, resetRequired: false });
    expect(feed.since(21)).toMatchObject({ events: [], nextCursor: 20, resetRequired: true });
  });

  it('filters unauthorized runs before delivery and advances past them without exposing payloads', () => {
    const feed = new AgentEventFeed(16);
    feed.append(event('allowed', 1)); feed.append(event('foreign', 1)); feed.append(event('allowed', 2));
    const page = feed.sinceAuthorized(0, (runId) => runId === 'allowed');
    expect(page).toMatchObject({ nextCursor: 3, resetRequired: false, events: [{ cursor: 1, runId: 'allowed' }, { cursor: 3, runId: 'allowed' }] });
    expect(JSON.stringify(page)).not.toMatch(/foreign|must never|secret|"data"/);
  });

  it('disconnects a slow consumer without blocking append and requires a covering snapshot to resume', () => {
    const buffer = new AgentEventDeliveryBuffer((runId) => runId === 'allowed', 2, 1_000, new Date('2026-08-14T00:00:00Z'));
    const item = (cursor: number, runId = 'allowed') => ({ cursor, runId, runSequence: cursor, provider: 'fake', type: 'heartbeat', timestamp: '2026-08-14T00:00:00Z', correlationId: `c-${cursor}` });
    const at = new Date('2026-08-14T00:00:00Z');
    expect(buffer.offer(item(1), at)).toBe('accepted');
    expect(buffer.offer(item(2, 'foreign'), at)).toBe('unauthorized');
    expect(buffer.offer(item(3), at)).toBe('accepted');
    expect(buffer.offer(item(4), at)).toBe('reset_required');
    expect(buffer.drain()).toMatchObject({ events: [], lastObservedCursor: 4, resetRequired: true });
    expect(() => buffer.resumeFromSnapshot(3)).toThrow('agent_event_delivery_snapshot_stale');
    buffer.resumeFromSnapshot(4, new Date('2026-08-14T00:00:01Z'));
    expect(buffer.offer(item(4), new Date('2026-08-14T00:00:01Z'))).toBe('duplicate');
    expect(buffer.offer(item(5), new Date('2026-08-14T00:00:01Z'))).toBe('accepted');
    expect(buffer.drain()).toMatchObject({ events: [{ cursor: 5 }], resetRequired: false });
    expect(buffer.heartbeatDue(new Date('2026-08-14T00:00:02Z'))).toBe(true);
  });
});
