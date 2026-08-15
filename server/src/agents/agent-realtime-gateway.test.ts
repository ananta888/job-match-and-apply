import { createServer } from 'node:http';
import { once } from 'node:events';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createApp, createDefaultAgentApiDependencies, type AgentApiDependencies } from '../app.js';
import { MemoryConfigStore } from '../services/config-store.js';
import { MemoryAuditLogger } from '../services/audit-logger.js';
import { MemoryWorkspaceStore } from '../services/workspace-store.js';
import {
  AgentRealtimeTicketAuthority,
  assertAllowedRealtimeOrigin,
  attachAgentRealtimeGateway,
  isLoopbackAddress,
  type AgentRealtimeGateway
} from './agent-realtime-gateway.js';

describe('AgentRealtimeTicketAuthority', () => {
  it('binds one-time tickets to run, origin and loopback client and expires them', () => {
    let now = Date.parse('2026-08-13T12:00:00.000Z');
    const authority = new AgentRealtimeTicketAuthority({ ttlMs: 1_000, now: () => now });
    const ticket = authority.issue({ runId: 'run-1', afterSequence: 4, origin: 'http://127.0.0.1:4201', remoteAddress: '::ffff:127.0.0.1' });
    expect(() => authority.consume({ token: ticket.token, runId: 'run-2', origin: 'http://127.0.0.1:4201', remoteAddress: '127.0.0.1' })).toThrow(/Sitzung/);
    expect(authority.consume({ token: ticket.token, runId: 'run-1', origin: 'http://127.0.0.1:4201', remoteAddress: '127.0.0.1' })).toMatchObject({ runId: 'run-1', afterSequence: 4 });
    expect(() => authority.consume({ token: ticket.token, runId: 'run-1', origin: 'http://127.0.0.1:4201', remoteAddress: '127.0.0.1' })).toThrow(/bereits/);

    const expired = authority.issue({ runId: 'run-1', afterSequence: 0, origin: 'http://127.0.0.1:4201', remoteAddress: '127.0.0.1' });
    now += 1_001;
    expect(() => authority.consume({ token: expired.token, runId: 'run-1', origin: 'http://127.0.0.1:4201', remoteAddress: '127.0.0.1' })).toThrow(/abgelaufen/);
    expect(() => authority.issue({ runId: 'run-1', afterSequence: 0, origin: 'http://127.0.0.1:4201', remoteAddress: '10.0.0.4' })).toThrow(/Loopback/);
  });

  it('accepts only same-service or Angular-development loopback origins', () => {
    expect(assertAllowedRealtimeOrigin('http://127.0.0.1:43187', '127.0.0.1:43187')).toBe('http://127.0.0.1:43187');
    expect(assertAllowedRealtimeOrigin('http://localhost:4201', '127.0.0.1:43187')).toBe('http://localhost:4201');
    expect(() => assertAllowedRealtimeOrigin('http://localhost:4200', '127.0.0.1:43187')).toThrow(/stimmt nicht/);
    expect(() => assertAllowedRealtimeOrigin('https://example.org', '127.0.0.1:43187')).toThrow(/lokale/);
    expect(() => assertAllowedRealtimeOrigin(undefined, '127.0.0.1:43187')).toThrow(/Origin/);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
  });
});

describe('AgentRealtimeGateway', () => {
  let dependencies: AgentApiDependencies | undefined;
  let gateway: AgentRealtimeGateway | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    await gateway?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await dependencies?.center.dispose();
  });

  it('is disabled by default and never weakens the SSE plus REST fallback', async () => {
    dependencies = createDefaultAgentApiDependencies(true);
    dependencies.realtimeTickets = undefined;
    const app = createApp(new MemoryConfigStore(), new MemoryAuditLogger(), new MemoryWorkspaceStore(), undefined, dependencies);
    const created = await request(app).post('/api/agent-runs').send({ providerId: 'fake', prompt: 'offline', workspaceMode: 'read_only', network: false });
    expect(created.status).toBe(201);
    const response = await request(app)
      .post(`/api/agent-runs/${created.body.id}/realtime-ticket`)
      .set('Origin', 'http://127.0.0.1:4201')
      .send({ afterSequence: 0 });
    expect(response.status).toBe(503);
    expect((await request(app).get(`/api/agent-runs/${created.body.id}/events?after=0`)).status).toBe(200);
  });

  it('streams a run-bound replay and rejects every mutating client frame', async () => {
    dependencies = createDefaultAgentApiDependencies(true);
    dependencies.realtimeTickets = new AgentRealtimeTicketAuthority();
    const app = createApp(new MemoryConfigStore(), new MemoryAuditLogger(), new MemoryWorkspaceStore(), undefined, dependencies);
    server = createServer(app);
    gateway = attachAgentRealtimeGateway(server, dependencies.center, dependencies.realtimeTickets, { pollIntervalMs: 10, idleTimeoutMs: 5_000 });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Testserver besitzt keinen TCP-Port.');
    const origin = `http://127.0.0.1:${address.port}`;
    const createdResponse = await fetch(`${origin}/api/agent-runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'fake', prompt: 'realtime offline fixture', workspaceMode: 'read_only', network: false })
    });
    expect(createdResponse.status).toBe(201);
    const run = await createdResponse.json() as { id: string };
    const ticketResponse = await fetch(`${origin}/api/agent-runs/${run.id}/realtime-ticket`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ afterSequence: 0 })
    });
    expect(ticketResponse.status).toBe(200);
    expect(ticketResponse.headers.get('cache-control')).toBe('no-store');
    const ticket = await ticketResponse.json() as { path: string; protocols: string[]; sessionId: string };
    expect(ticket.path).not.toContain('ticket');
    const client = new WebSocket(`ws://127.0.0.1:${address.port}${ticket.path}`, ticket.protocols, { origin });
    const received: Array<Record<string, unknown>> = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await once(client, 'open');

    await expect.poll(() => received.some((message) => message.type === 'server.ready')).toBe(true);
    await expect.poll(() => received.filter((message) => message.type === 'server.event').length).toBeGreaterThan(0);
    client.send(JSON.stringify({ type: 'client.ping', nonce: 'safe-nonce' }));
    await expect.poll(() => received.some((message) => message.type === 'server.pong' && message.nonce === 'safe-nonce')).toBe(true);

    client.send(JSON.stringify({ type: 'client.approval', approvalId: 'bypass', decision: 'approve' }));
    await once(client, 'close');
    expect(received).toContainEqual(expect.objectContaining({ type: 'server.error', code: 'controls_require_revision_checked_rest' }));
    expect((await dependencies.center.get(run.id))?.provider).toBe('fake');
  });
});
