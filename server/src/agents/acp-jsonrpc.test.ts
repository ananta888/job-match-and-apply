import { describe, expect, it } from 'vitest';
import { AcpJsonRpcClient } from './acp-jsonrpc.js';

describe('ACP JSON-RPC client', () => {
  it('matches requests to responses and routes notifications', async () => {
    const written: string[] = [];
    const notes: Array<{ method: string; params: unknown }> = [];
    const client = new AcpJsonRpcClient(async (line) => { written.push(line); }, {
      onNotification(method, params) { notes.push({ method, params }); },
      onRequest: () => ({}),
    });
    const pending = client.request('initialize', { protocolVersion: 1 });
    expect(JSON.parse(written[0]!)).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    client.feed(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's' } })}\n`);
    client.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })}\n`);
    await expect(pending).resolves.toEqual({ protocolVersion: 1 });
    expect(notes).toEqual([{ method: 'session/update', params: { sessionId: 's' } }]);
  });

  it('rejects a closed session and does not leak pending results', async () => {
    const client = new AcpJsonRpcClient(async () => undefined, {
      onNotification() {},
      onRequest: () => ({}),
    });
    const pending = client.request('session/new', { cwd: '/tmp', mcpServers: [] });
    client.end();
    await expect(pending).rejects.toThrow('acp_jsonrpc_closed');
  });
});
