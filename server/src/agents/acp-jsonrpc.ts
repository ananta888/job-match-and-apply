import { IncrementalJsonlParser } from './jsonl-parser.js';
import { isRecord } from './acp-protocol.js';

export interface JsonRpcError {
  code: number;
  message: string;
}

export interface AcpIncomingRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export interface AcpJsonRpcHandlers {
  onNotification(method: string, params: unknown): void;
  onRequest(request: AcpIncomingRequest): Record<string, unknown> | Promise<Record<string, unknown>>;
}

const MAX_PENDING = 32;

export class AcpJsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly parser = new IncrementalJsonlParser();

  constructor(
    private readonly write: (line: string) => Promise<void>,
    private readonly handlers: AcpJsonRpcHandlers,
  ) {}

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.pending.size >= MAX_PENDING) throw new Error('acp_jsonrpc_backpressure');
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.write(`${payload}\n`);
    return result;
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async respond(id: string | number, result: unknown): Promise<void> {
    await this.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  async respondError(id: string | number, error: JsonRpcError): Promise<void> {
    await this.write(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`);
  }

  feed(chunk: string | Buffer): void {
    this.dispatch(this.parser.feed(chunk).values);
  }

  end(): void {
    this.dispatch(this.parser.end().values);
    for (const [id, waiter] of this.pending) {
      waiter.reject(new Error('acp_jsonrpc_closed'));
      this.pending.delete(id);
    }
  }

  rejectAll(error: Error): void {
    for (const [id, waiter] of this.pending) {
      waiter.reject(error);
      this.pending.delete(id);
    }
  }

  private dispatch(values: unknown[]): void {
    for (const value of values) {
      if (!isRecord(value) || value.jsonrpc !== '2.0') continue;
      if (value.id !== undefined && (value.result !== undefined || value.error !== undefined)) {
        const waiter = this.pending.get(value.id as string | number);
        if (!waiter) continue;
        this.pending.delete(value.id as string | number);
        if (value.error !== undefined) {
          const message = isRecord(value.error) && typeof value.error.message === 'string'
            ? value.error.message : 'acp_jsonrpc_error';
          waiter.reject(Object.assign(new Error(message), { code: 'acp_jsonrpc_error' }));
        } else waiter.resolve(value.result);
        continue;
      }
      if (typeof value.method !== 'string') continue;
      if (value.id !== undefined && value.id !== null) {
        void Promise.resolve(this.handlers.onRequest({
          id: value.id as string | number, method: value.method, params: value.params,
        })).catch(() => undefined);
        continue;
      }
      this.handlers.onNotification(value.method, value.params);
    }
  }
}
