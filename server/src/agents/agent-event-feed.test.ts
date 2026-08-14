import { describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentEvent } from '../ports/agent-runner.js';
import { AgentEventFeed } from './agent-event-feed.js';

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
});
