import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACP_CLIENT_CAPABILITIES,
  ACP_FORBIDDEN_CLIENT_METHODS,
  acpClientInitializeParams,
  acpSessionNewParams,
  assertAcpInitializeResult,
  isForbiddenAcpClientMethod,
  mapAcpJsonRpcMessage,
  sessionIdFromNewResult,
} from './acp-protocol.js';

describe('ACP protocol mapping', () => {
  it('advertises no filesystem or terminal client capabilities', () => {
    expect(ACP_CLIENT_CAPABILITIES).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    expect(acpSessionNewParams('/tmp/workspace').mcpServers).toEqual([]);
    expect(acpClientInitializeParams().protocolVersion).toBe(1);
    expect(ACP_FORBIDDEN_CLIENT_METHODS.some((method) => method.startsWith('fs/'))).toBe(true);
  });

  it('maps agent text chunks and usage without copying unknown fields', () => {
    expect(mapAcpJsonRpcMessage({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } },
    })).toEqual([{ kind: 'agent_message_delta', data: { text: 'hello', role: 'assistant' } }]);
    expect(mapAcpJsonRpcMessage({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'sess-1', update: { sessionUpdate: 'usage_update', used: 12, size: 100, cost: { amount: 0.1, currency: 'USD' } } },
    })).toEqual([{ kind: 'usage_updated', data: { totalTokens: 12, contextSize: 100, cost: 0.1, currency: 'USD' } }]);
  });

  it('refuses file and terminal client methods and unknown envelopes', () => {
    expect(isForbiddenAcpClientMethod('fs/read_text_file')).toBe(true);
    expect(isForbiddenAcpClientMethod('terminal/create')).toBe(true);
    expect(mapAcpJsonRpcMessage({
      jsonrpc: '2.0', id: 3, method: 'fs/read_text_file', params: { path: '/secret' },
    })).toEqual([{ kind: 'warning', data: { code: 'acp_client_method_forbidden', method: 'fs/read_text_file' } }]);
    expect(JSON.stringify(mapAcpJsonRpcMessage({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' }, secret: 'sk-not-copied' } },
    }))).not.toContain('sk-not-copied');
    expect(mapAcpJsonRpcMessage({ type: 'future.event' })[0]).toMatchObject({ kind: 'warning', data: { code: 'unknown_acp_event' } });
  });

  it('accepts only protocol version 1 and a safe session id', () => {
    expect(assertAcpInitializeResult({ protocolVersion: 1, agentCapabilities: {} })).toEqual({
      protocolVersion: 1, sessionLoad: false,
    });
    expect(() => assertAcpInitializeResult({ protocolVersion: 2 })).toThrow('acp_protocol_version_unsupported');
    expect(sessionIdFromNewResult({ sessionId: 'sess-synthetic' })).toBe('sess-synthetic');
    expect(() => sessionIdFromNewResult({ sessionId: '../escape' })).toThrow('acp_session_id_invalid');
  });

  it('replays the synthetic fixture without credentials', async () => {
    const fixture = JSON.parse(await readFile(resolve(process.cwd(), '..', 'contracts/fixtures/v1/acp-events.json'), 'utf8')) as {
      events: unknown[];
    };
    const mapped = fixture.events.flatMap((event) => mapAcpJsonRpcMessage(event));
    expect(mapped).toEqual(expect.arrayContaining([
      { kind: 'agent_message_delta', data: { text: 'synthetic acp result', role: 'assistant' } },
    ]));
    expect(JSON.stringify(fixture)).not.toMatch(/sk-|BEGIN |password/i);
  });
});
