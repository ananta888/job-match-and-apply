import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { AgentControlCenter } from './agent-control-center.js';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TICKET_PROTOCOL_PREFIX = 'agent.ticket.';

export interface AgentRealtimeTicket {
  token: string;
  sessionId: string;
  runId: string;
  afterSequence: number;
  expiresAt: string;
}

interface StoredTicket extends Omit<AgentRealtimeTicket, 'token'> {
  origin: string;
  remoteAddress: string;
}

export interface AgentRealtimeTicketAuthorityOptions {
  ttlMs?: number;
  maxOutstanding?: number;
  now?: () => number;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function normalizeRemoteAddress(address: string | undefined): string {
  if (!address) return '';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeRemoteAddress(address);
  return normalized === '127.0.0.1' || normalized === '::1';
}

export function assertAllowedRealtimeOrigin(origin: string | undefined, host: string | undefined): string {
  if (!origin) throw new Error('Der Realtime-Kanal verlangt einen expliziten Browser-Origin.');
  let parsed: URL;
  try { parsed = new URL(origin); }
  catch { throw new Error('Der Realtime-Origin ist ungueltig.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Nur lokale Browser-Origins duerfen Realtime-Tickets anfordern.');
  }
  const normalizedHost = host?.toLowerCase();
  const sameHost = normalizedHost === parsed.host.toLowerCase();
  const developmentOrigin = (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && parsed.port === '4200';
  if (!sameHost && !developmentOrigin) throw new Error('Der Realtime-Origin stimmt nicht mit diesem lokalen Dienst ueberein.');
  return parsed.origin;
}

/** One-time, short-lived tickets keep bearer material out of WebSocket URLs and logs. */
export class AgentRealtimeTicketAuthority {
  private readonly tickets = new Map<string, StoredTicket>();
  private readonly ttlMs: number;
  private readonly maxOutstanding: number;
  private readonly now: () => number;

  constructor(options: AgentRealtimeTicketAuthorityOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.maxOutstanding = options.maxOutstanding ?? 128;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 120_000) throw new Error('Realtime-Ticket-TTL ist ungueltig.');
    if (!Number.isSafeInteger(this.maxOutstanding) || this.maxOutstanding < 1 || this.maxOutstanding > 10_000) throw new Error('Realtime-Ticket-Limit ist ungueltig.');
  }

  issue(input: { runId: string; afterSequence: number; origin: string; remoteAddress: string }): AgentRealtimeTicket {
    if (!RUN_ID.test(input.runId)) throw new Error('Ungueltige Run-ID.');
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) throw new Error('Ungueltige Event-Sequenz.');
    if (!isLoopbackAddress(input.remoteAddress)) throw new Error('Realtime-Tickets werden nur an Loopback-Clients ausgegeben.');
    this.prune();
    if (this.tickets.size >= this.maxOutstanding) throw new Error('Zu viele offene Realtime-Tickets.');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now() + this.ttlMs).toISOString();
    const ticket: StoredTicket = {
      sessionId: randomUUID(), runId: input.runId, afterSequence: input.afterSequence,
      expiresAt, origin: input.origin, remoteAddress: normalizeRemoteAddress(input.remoteAddress)
    };
    this.tickets.set(digest(token), ticket);
    return { token, sessionId: ticket.sessionId, runId: ticket.runId, afterSequence: ticket.afterSequence, expiresAt };
  }

  consume(input: { token: string; runId: string; origin: string; remoteAddress: string }): StoredTicket {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)) throw new Error('Realtime-Ticket ist ungueltig.');
    const key = digest(input.token);
    const ticket = this.tickets.get(key);
    if (!ticket) throw new Error('Realtime-Ticket ist unbekannt oder wurde bereits verwendet.');
    if (Date.parse(ticket.expiresAt) <= this.now()) { this.tickets.delete(key); throw new Error('Realtime-Ticket ist abgelaufen.'); }
    if (ticket.runId !== input.runId || ticket.origin !== input.origin || ticket.remoteAddress !== normalizeRemoteAddress(input.remoteAddress)) {
      throw new Error('Realtime-Ticket ist nicht an diese Sitzung gebunden.');
    }
    this.tickets.delete(key);
    return structuredClone(ticket);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, ticket] of this.tickets) if (Date.parse(ticket.expiresAt) <= now) this.tickets.delete(key);
  }
}

export interface AgentRealtimeGatewayOptions {
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
  maxFramesPerWindow?: number;
  rateWindowMs?: number;
  idleTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface AgentRealtimeGateway {
  close(): Promise<void>;
}

function rejectUpgrade(socket: Socket, status: 400 | 401 | 403 | 404 | 429 | 503): void {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : status === 429 ? 'Too Many Requests' : status === 503 ? 'Service Unavailable' : 'Bad Request';
  if (socket.writable) socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function protocols(request: IncomingMessage): string[] {
  return String(request.headers['sec-websocket-protocol'] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

/**
 * Optional local WebSocket transport. Mutating controls deliberately remain on the
 * revision-checked REST API; client frames only acknowledge, ping, or request replay.
 */
export function attachAgentRealtimeGateway(
  server: HttpServer,
  center: AgentControlCenter,
  tickets: AgentRealtimeTicketAuthority,
  options: AgentRealtimeGatewayOptions = {}
): AgentRealtimeGateway {
  const maxFrameBytes = options.maxFrameBytes ?? 4 * 1024;
  const maxBufferedBytes = options.maxBufferedBytes ?? 256 * 1024;
  const maxFramesPerWindow = options.maxFramesPerWindow ?? 30;
  const rateWindowMs = options.rateWindowMs ?? 10_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: maxFrameBytes,
    perMessageDeflate: false,
    handleProtocols: (requested) => requested.has('agent.v1') ? 'agent.v1' : false
  });

  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) { rejectUpgrade(socket, 403); return; }
    const match = /^\/api\/agent-runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/channel$/.exec(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (!match) { rejectUpgrade(socket, 404); return; }
    const requestedProtocols = protocols(request);
    const encodedTicket = requestedProtocols.find((protocol) => protocol.startsWith(TICKET_PROTOCOL_PREFIX));
    if (!requestedProtocols.includes('agent.v1') || !encodedTicket) { rejectUpgrade(socket, 401); return; }
    let origin: string;
    try { origin = assertAllowedRealtimeOrigin(request.headers.origin, request.headers.host); }
    catch { rejectUpgrade(socket, 403); return; }
    let session: StoredTicket;
    try {
      session = tickets.consume({
        token: encodedTicket.slice(TICKET_PROTOCOL_PREFIX.length), runId: match[1]!, origin,
        remoteAddress: request.socket.remoteAddress ?? ''
      });
    } catch { rejectUpgrade(socket, 401); return; }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit('connection', webSocket, request, session);
    });
  };

  webSockets.on('connection', (webSocket: WebSocket, _request: IncomingMessage, session: StoredTicket) => {
    let cursor = session.afterSequence;
    let lastAcknowledged = session.afterSequence;
    let lastActivity = Date.now();
    let windowStarted = Date.now();
    let framesInWindow = 0;
    let polling = false;
    const send = (value: Readonly<Record<string, unknown>>): boolean => {
      if (webSocket.readyState !== WebSocket.OPEN) return false;
      if (webSocket.bufferedAmount > maxBufferedBytes) { webSocket.close(1013, 'backpressure'); return false; }
      webSocket.send(JSON.stringify(value));
      return true;
    };
    const poll = async (): Promise<void> => {
      if (polling || webSocket.readyState !== WebSocket.OPEN) return;
      polling = true;
      try {
        const events = await center.events(session.runId, cursor);
        for (const event of events) {
          if (!send({ type: 'server.event', sessionId: session.sessionId, event })) return;
          cursor = event.sequence;
        }
        if (cursor - lastAcknowledged > 10_000) webSocket.close(1013, 'acknowledgement required');
      } catch { webSocket.close(1011, 'event stream unavailable'); }
      finally { polling = false; }
    };
    void center.get(session.runId).then((run) => {
      if (!run) { webSocket.close(1008, 'run not found'); return; }
      send({ type: 'server.ready', protocolVersion: '1.0', sessionId: session.sessionId, runId: session.runId, currentSequence: run.currentSequence, controls: 'revision-checked-rest-only' });
      void poll();
    });

    webSocket.on('pong', () => { lastActivity = Date.now(); });
    webSocket.on('message', (raw, binary) => {
      lastActivity = Date.now();
      const now = Date.now();
      if (now - windowStarted >= rateWindowMs) { windowStarted = now; framesInWindow = 0; }
      framesInWindow += 1;
      if (framesInWindow > maxFramesPerWindow) { webSocket.close(1008, 'rate limit'); return; }
      const payload = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
      if (binary || payload.byteLength > maxFrameBytes) { webSocket.close(1009, 'frame too large'); return; }
      let value: unknown;
      try { value = JSON.parse(payload.toString('utf8')); }
      catch { webSocket.close(1007, 'invalid json'); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { webSocket.close(1008, 'invalid message'); return; }
      const message = value as Record<string, unknown>;
      if (message.type === 'client.ping' && Object.keys(message).every((key) => ['type', 'nonce'].includes(key)) && (message.nonce === undefined || typeof message.nonce === 'string')) {
        send({ type: 'server.pong', sessionId: session.sessionId, nonce: message.nonce }); return;
      }
      if (message.type === 'client.ack' && Object.keys(message).every((key) => ['type', 'sequence'].includes(key)) && Number.isSafeInteger(message.sequence) && Number(message.sequence) >= lastAcknowledged && Number(message.sequence) <= cursor) {
        lastAcknowledged = Number(message.sequence); return;
      }
      if (message.type === 'client.resync' && Object.keys(message).every((key) => ['type', 'afterSequence'].includes(key)) && Number.isSafeInteger(message.afterSequence) && Number(message.afterSequence) >= 0 && Number(message.afterSequence) <= cursor) {
        cursor = Number(message.afterSequence); void poll(); return;
      }
      send({ type: 'server.error', sessionId: session.sessionId, code: 'controls_require_revision_checked_rest', message: 'Dieser Kanal akzeptiert keine Freigaben, Eingaben oder anderen mutierenden Befehle.' });
      webSocket.close(1008, 'unsupported message');
    });

    const timer = setInterval(() => {
      if (Date.now() - lastActivity > idleTimeoutMs) { webSocket.close(1001, 'idle timeout'); return; }
      if (webSocket.readyState === WebSocket.OPEN) { webSocket.ping(); void poll(); }
    }, Math.min(15_000, Math.max(250, Math.floor(idleTimeoutMs / 2))));
    timer.unref();
    webSocket.once('close', () => clearInterval(timer));
    webSocket.once('error', () => clearInterval(timer));
  });

  server.on('upgrade', onUpgrade);
  return {
    close: async () => {
      server.off('upgrade', onUpgrade);
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    }
  };
}
