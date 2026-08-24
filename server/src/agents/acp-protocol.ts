import type { AgentEventDraft } from '../ports/agent-runner.js';

export const ACP_PROTOCOL_VERSION = 1 as const;
export const ACP_CLIENT_NAME = 'job-match-and-apply';
export const ACP_CLIENT_VERSION = '0.1.0';

export const ACP_FORBIDDEN_CLIENT_METHODS = [
  'fs/read_text_file', 'fs/write_text_file',
  'terminal/create', 'terminal/output', 'terminal/release', 'terminal/wait_for_exit', 'terminal/kill',
] as const;

export const ACP_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_METHOD = /^(?:[a-z][a-z0-9_]*\/)*[a-z][a-z0-9_]*$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isForbiddenAcpClientMethod(method: string): boolean {
  return (ACP_FORBIDDEN_CLIENT_METHODS as readonly string[]).includes(method)
    || method.startsWith('fs/') || method.startsWith('terminal/');
}

export function acpClientInitializeParams(): Record<string, unknown> {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: structuredClone(ACP_CLIENT_CAPABILITIES),
    clientInfo: { name: ACP_CLIENT_NAME, title: 'Job Match & Apply', version: ACP_CLIENT_VERSION },
  };
}

export function acpSessionNewParams(cwd: string): Record<string, unknown> {
  if (!cwd || cwd.includes('\0')) throw new Error('acp_cwd_invalid');
  return { cwd, mcpServers: [] };
}

export function acpPromptParams(sessionId: string, text: string): Record<string, unknown> {
  if (!SAFE_ID.test(sessionId)) throw new Error('acp_session_id_invalid');
  if (!text.trim() || text.includes('\0')) throw new Error('acp_prompt_invalid');
  return { sessionId, prompt: [{ type: 'text', text }] };
}

export function acpPermissionDeniedResult(): Record<string, unknown> {
  return { outcome: { outcome: 'cancelled' } };
}

export function assertAcpInitializeResult(value: unknown): { protocolVersion: number; sessionLoad: boolean } {
  if (!isRecord(value)) throw new Error('acp_initialize_invalid');
  const protocolVersion = value.protocolVersion;
  if (protocolVersion !== ACP_PROTOCOL_VERSION) throw new Error('acp_protocol_version_unsupported');
  const capabilities = isRecord(value.agentCapabilities) ? value.agentCapabilities : {};
  return { protocolVersion, sessionLoad: capabilities.loadSession === true };
}

export function sessionIdFromNewResult(value: unknown): string {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || !SAFE_ID.test(value.sessionId)) {
    throw new Error('acp_session_id_invalid');
  }
  return value.sessionId;
}

export function textFromContent(value: unknown): string | undefined {
  if (typeof value === 'string' && value && !value.includes('\0')) return value;
  if (!isRecord(value)) return undefined;
  if (value.type === 'text' && typeof value.text === 'string' && value.text && !value.text.includes('\0')) {
    return value.text;
  }
  return undefined;
}

function toolStatus(value: unknown): string {
  return value === 'in_progress' || value === 'completed' || value === 'failed' || value === 'cancelled'
    ? value : 'requested';
}

export function mapAcpJsonRpcMessage(value: unknown): AgentEventDraft[] {
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    return [{ kind: 'warning', data: { code: 'unknown_acp_event', reason: 'not_jsonrpc_2' } }];
  }
  if (typeof value.method === 'string') {
    if (!SAFE_METHOD.test(value.method)) {
      return [{ kind: 'warning', data: { code: 'unknown_acp_event', reason: 'method_invalid' } }];
    }
    if (value.method === 'session/update') return mapSessionUpdate(value.params);
    if (value.method === 'session/request_permission') {
      return [{ kind: 'warning', data: { code: 'acp_permission_denied', method: value.method } }];
    }
    if (isForbiddenAcpClientMethod(value.method)) {
      return [{ kind: 'warning', data: { code: 'acp_client_method_forbidden', method: value.method } }];
    }
    return [{ kind: 'warning', data: { code: 'unknown_acp_event', method: value.method } }];
  }
  if (value.result !== undefined || value.error !== undefined) return [];
  return [{ kind: 'warning', data: { code: 'unknown_acp_event', reason: 'unrecognized_envelope' } }];
}

function mapSessionUpdate(params: unknown): AgentEventDraft[] {
  if (!isRecord(params) || !isRecord(params.update)) {
    return [{ kind: 'warning', data: { code: 'unknown_acp_event', reason: 'session_update_invalid' } }];
  }
  const update = params.update;
  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    const text = textFromContent(update.content);
    if (!text) return [];
    return [{ kind: 'agent_message_delta', data: { text, role: kind === 'agent_thought_chunk' ? 'thought' : 'assistant' } }];
  }
  if (kind === 'tool_call') {
    const id = typeof update.toolCallId === 'string' && SAFE_ID.test(update.toolCallId) ? update.toolCallId : undefined;
    return [{
      kind: 'tool_started',
      data: {
        ...(id ? { id } : {}),
        title: typeof update.title === 'string' ? update.title.slice(0, 200) : 'tool',
        toolKind: typeof update.kind === 'string' ? update.kind.slice(0, 40) : 'other',
        status: toolStatus(update.status),
      },
    }];
  }
  if (kind === 'tool_call_update') {
    const status = toolStatus(update.status);
    const id = typeof update.toolCallId === 'string' && SAFE_ID.test(update.toolCallId) ? update.toolCallId : undefined;
    return [{
      kind: status === 'completed' || status === 'failed' || status === 'cancelled' ? 'tool_completed' : 'tool_output',
      data: { ...(id ? { id } : {}), status },
    }];
  }
  if (kind === 'usage_update') {
    const used = typeof update.used === 'number' && Number.isFinite(update.used) ? update.used : undefined;
    const size = typeof update.size === 'number' && Number.isFinite(update.size) ? update.size : undefined;
    const cost = isRecord(update.cost) ? update.cost : undefined;
    return [{
      kind: 'usage_updated',
      data: {
        ...(used !== undefined ? { totalTokens: used } : {}),
        ...(size !== undefined ? { contextSize: size } : {}),
        ...(cost && typeof cost.amount === 'number' ? { cost: cost.amount } : {}),
        ...(cost && typeof cost.currency === 'string' ? { currency: cost.currency } : {}),
      },
    }];
  }
  if (kind === 'plan' || kind === 'available_commands_update' || kind === 'current_mode_update') {
    return [{ kind: 'heartbeat', data: { phase: kind } }];
  }
  return [{ kind: 'warning', data: { code: 'unknown_acp_event', sessionUpdate: kind || 'missing' } }];
}
