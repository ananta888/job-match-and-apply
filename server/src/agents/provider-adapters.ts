import type { AgentCapabilities, AgentEventDraft, AgentProviderInstallation, AgentRunnerPort, AgentRunHandle, ApprovalDecision, ProviderRunContext } from '../ports/agent-runner.js';
import { CodexAppServerAgentAdapter, FeatureFlaggedCodexAgentAdapter, type CodexAppServerOptions } from './codex-app-server-adapter.js';
import { GenericJsonlAgentAdapter, type AgentAdapterManifest, type ProviderEventMapper } from './generic-jsonl-adapter.js';
import { ProcessSupervisor } from './process-supervisor.js';
import { AgentRuntimeDiscovery } from './runtime-discovery.js';

const baseCapabilities: Omit<AgentCapabilities, 'schemaVersion' | 'provider' | 'providerVersion' | 'adapterVersion'> = {
  protocolVersion: '1.0',
  streaming: true,
  resume: false,
  interactiveInput: false,
  approvals: false,
  tools: true,
  images: false,
  structuredOutput: false,
  sandboxPolicies: ['read-only'],
  usage: true,
  supportedRuntimeTargets: ['windows', 'wsl', 'linux', 'darwin']
};

export const CODEX_EXEC_MANIFEST: AgentAdapterManifest = {
  schemaVersion: '1.0', id: 'codex-exec', displayName: 'Codex CLI (exec)', adapterVersion: '1.0.0',
  protocol: 'codex-jsonl', trust: 'builtin', enabled: true,
  executableNames: ['codex'], versionArgs: ['--version'], testedVersionPatterns: ['^(?:codex-cli|codex)\\s+0\\.147\\.'],
  command: {
    args: ['exec', '--ignore-user-config', '--json', '--color', 'never', '--sandbox', '{sandbox}', '--cd', '{workspace}', '-'],
    promptTransport: 'stdin', modelArgs: ['--model', '{model}'], profileArgs: ['--profile', '{profile}']
  },
  capabilities: {
    ...baseCapabilities, structuredOutput: true,
    sandboxPolicies: ['read-only', 'workspace-write'],
    extensions: { networkControl: false, officialSemantics: 'codex exec --ignore-user-config --json', maturity: 'stable' }
  }
};

export const OPENCODE_MANIFEST: AgentAdapterManifest = {
  schemaVersion: '1.0', id: 'opencode', displayName: 'OpenCode', adapterVersion: '1.0.0',
  protocol: 'opencode-json', trust: 'builtin', enabled: true,
  executableNames: ['opencode'], versionArgs: ['--version'], testedVersionPatterns: [],
  command: { args: ['run', '--format', 'json', '--dir', '{workspace}', '{prompt}'], promptTransport: 'argument' },
  capabilities: {
    ...baseCapabilities, supportedRuntimeTargets: ['wsl'],
    extensions: {
      networkControl: false, contractRequiresFixture: true, forbiddenArguments: ['--auto'],
      externalSandbox: 'wsl-bubblewrap-v1', networkEnforcement: 'namespace-none'
    }
  }
};

export const CLAUDE_CLI_MANIFEST: AgentAdapterManifest = {
  schemaVersion: '1.0', id: 'claude-cli', displayName: 'Claude CLI', adapterVersion: '1.0.0',
  protocol: 'claude-stream-json', trust: 'builtin', enabled: true,
  executableNames: ['claude'], versionArgs: ['--version'], testedVersionPatterns: [],
  command: {
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--no-session-persistence', '{prompt}'],
    promptTransport: 'argument', modelArgs: ['--model', '{model}']
  },
  capabilities: {
    ...baseCapabilities, supportedRuntimeTargets: ['wsl'],
    extensions: {
      networkControl: false, contractRequiresFixture: true,
      forbiddenArguments: ['--permission-mode=bypassPermissions', '--dangerously-skip-permissions'],
      externalSandbox: 'wsl-bubblewrap-v1', networkEnforcement: 'namespace-none'
    }
  }
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.flatMap((part) => {
      const record = object(part);
      return record && typeof record.text === 'string' ? [record.text] : [];
    }).join('');
    return text || undefined;
  }
  return undefined;
}

function normalizedUsage(value: unknown): Record<string, number> | undefined {
  const usage = object(value);
  if (!usage) return undefined;
  const number = (...keys: string[]): number | undefined => {
    const value = keys.map((key) => usage[key]).find((candidate) => typeof candidate === 'number');
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const result = {
    inputTokens: number('inputTokens', 'input_tokens'),
    cachedInputTokens: number('cachedInputTokens', 'cached_input_tokens', 'cache_read_input_tokens'),
    outputTokens: number('outputTokens', 'output_tokens'),
    reasoningTokens: number('reasoningTokens', 'reasoning_tokens'),
    totalTokens: number('totalTokens', 'total_tokens')
  };
  return Object.fromEntries(Object.entries(result).filter(([, candidate]) => candidate !== undefined)) as Record<string, number>;
}

export const mapCodexJsonlEvent: ProviderEventMapper = (value): AgentEventDraft[] => {
  const event = object(value);
  const type = typeof event?.type === 'string' ? event.type : undefined;
  if (!event || !type) return [{ kind: 'warning', data: { code: 'invalid_codex_event' } }];
  if (type === 'thread.started') {
    return [{ kind: 'warning', data: { code: 'provider_session_started', sessionId: event.thread_id ?? event.threadId } }];
  }
  if (type === 'turn.started') return [{ kind: 'heartbeat', data: { phase: 'turn_started' } }];
  if (type === 'turn.completed') {
    const usage = normalizedUsage(event.usage);
    return usage ? [{ kind: 'usage_updated', data: usage }] : [{ kind: 'heartbeat', data: { phase: 'turn_completed' } }];
  }
  if (type === 'turn.failed' || type === 'error') {
    const error = object(event.error);
    return [{ kind: 'error', data: { code: String(error?.code ?? type), message: String(error?.message ?? event.message ?? 'Codex-Fehler'), retryable: Boolean(error?.retryable) } }];
  }
  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const item = object(event.item);
    const itemType = typeof item?.type === 'string' ? item.type : 'unknown';
    const status = type.split('.')[1];
    if (itemType === 'agent_message' || itemType === 'assistant_message') {
      const text = textFromContent(item?.text ?? item?.content ?? item?.message);
      if (!text) return [];
      return [{ kind: status === 'completed' ? 'agent_message_completed' : 'agent_message_delta', data: { text, itemId: item?.id } }];
    }
    if (itemType.includes('tool') || ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(itemType)) {
      const kind = status === 'started' ? 'tool_started' : status === 'completed' ? 'tool_completed' : 'tool_output';
      const output = item?.aggregated_output ?? item?.output ?? item?.result;
      return [{ kind, data: {
        id: item?.id, type: itemType, status: item?.status, name: item?.name ?? item?.command,
        ...(output === undefined ? {} : { output: String(output).slice(0, 64 * 1024) }),
        ...(typeof item?.exit_code === 'number' ? { exitCode: item.exit_code } : {})
      } }];
    }
    return [{ kind: 'warning', data: { code: 'unknown_codex_item', itemType, status } }];
  }
  return [{ kind: 'warning', data: { code: 'unknown_codex_event', providerEventType: type } }];
};

export const mapOpenCodeJsonEvent: ProviderEventMapper = (value): AgentEventDraft[] => {
  const event = object(value); const type = typeof event?.type === 'string' ? event.type : undefined;
  if (!event || !type) return [{ kind: 'warning', data: { code: 'invalid_opencode_event' } }];
  const part = object(event.part ?? event.message ?? event.data);
  const text = textFromContent(part?.text ?? event.text ?? part?.content);
  if (type.includes('text') || type.includes('message')) {
    return text ? [{ kind: type.includes('delta') ? 'agent_message_delta' : 'agent_message_completed', data: { text } }] : [];
  }
  if (type.includes('tool')) return [{ kind: type.includes('completed') ? 'tool_completed' : 'tool_started', data: { providerEventType: type, id: part?.id, name: part?.name } }];
  if (type.includes('error')) return [{ kind: 'error', data: { code: type, message: String(event.message ?? part?.message ?? 'OpenCode-Fehler'), retryable: false } }];
  return [{ kind: 'warning', data: { code: 'unknown_opencode_event', providerEventType: type } }];
};

export const mapClaudeStreamEvent: ProviderEventMapper = (value): AgentEventDraft[] => {
  const event = object(value); const type = typeof event?.type === 'string' ? event.type : undefined;
  if (!event || !type) return [{ kind: 'warning', data: { code: 'invalid_claude_event' } }];
  if (type === 'assistant') {
    const message = object(event.message);
    const text = textFromContent(message?.content ?? event.content);
    return text ? [{ kind: 'agent_message_completed', data: { text } }] : [];
  }
  if (type === 'result') {
    const drafts: AgentEventDraft[] = [];
    if (typeof event.result === 'string') drafts.push({ kind: 'agent_message_completed', data: { text: event.result } });
    const usage = normalizedUsage(event.usage);
    if (usage) drafts.push({ kind: 'usage_updated', data: usage });
    if (event.is_error === true) drafts.push({ kind: 'error', data: { code: String(event.subtype ?? 'claude_result_error'), message: String(event.result ?? 'Claude-Fehler'), retryable: false } });
    return drafts;
  }
  if (type === 'system') return [{ kind: 'heartbeat', data: { phase: String(event.subtype ?? 'system') } }];
  if (type.includes('tool')) return [{ kind: type.includes('result') ? 'tool_completed' : 'tool_started', data: { providerEventType: type } }];
  return [{ kind: 'warning', data: { code: 'unknown_claude_event', providerEventType: type } }];
};

export class CodexExecAgentAdapter implements AgentRunnerPort {
  readonly provider = CODEX_EXEC_MANIFEST.id;
  private readonly delegate: FeatureFlaggedCodexAgentAdapter;
  constructor(supervisor = new ProcessSupervisor(), discovery = new AgentRuntimeDiscovery(), allowUntestedVersions = false, appServerOptions: CodexAppServerOptions & { enabled?: boolean } = {}) {
    const fallback = new GenericJsonlAgentAdapter(CODEX_EXEC_MANIFEST, supervisor, discovery, mapCodexJsonlEvent, new Set(), allowUntestedVersions);
    const appServer = new CodexAppServerAgentAdapter(supervisor, discovery, appServerOptions);
    this.delegate = new FeatureFlaggedCodexAgentAdapter(appServer, fallback, appServerOptions.enabled);
  }
  discover(): Promise<AgentProviderInstallation[]> { return this.delegate.discover(); }
  capabilities(installation: AgentProviderInstallation): Promise<AgentCapabilities> { return this.delegate.capabilities(installation); }
  start(context: ProviderRunContext): Promise<AgentRunHandle> { return this.delegate.start(context); }
  sendInput(runId: string, input: string): Promise<void> { return this.delegate.sendInput(runId, input); }
  resolveApproval(runId: string, approvalId: string, decision: ApprovalDecision): Promise<void> { return this.delegate.resolveApproval(runId, approvalId, decision); }
  cancel(runId: string, reason?: string): Promise<void> { return this.delegate.cancel(runId, reason); }
  resume(runId: string, input?: string): Promise<AgentRunHandle> { return this.delegate.resume(runId, input); }
  dispose(): Promise<void> { return this.delegate.dispose(); }
}

export class OpenCodeAgentAdapter extends GenericJsonlAgentAdapter {
  constructor(supervisor = new ProcessSupervisor(), discovery = new AgentRuntimeDiscovery(), allowUntestedVersions = false) {
    super(OPENCODE_MANIFEST, supervisor, discovery, mapOpenCodeJsonEvent, new Set(), allowUntestedVersions);
  }
}

export class ClaudeCliAgentAdapter extends GenericJsonlAgentAdapter {
  constructor(supervisor = new ProcessSupervisor(), discovery = new AgentRuntimeDiscovery(), allowUntestedVersions = false) {
    super(CLAUDE_CLI_MANIFEST, supervisor, discovery, mapClaudeStreamEvent, new Set(), allowUntestedVersions);
  }
}
