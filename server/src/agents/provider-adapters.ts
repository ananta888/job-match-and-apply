import type { AgentCapabilities, AgentEventDraft, AgentProviderInstallation, AgentRunnerPort, AgentRunHandle, ApprovalDecision, ProviderRunContext } from '../ports/agent-runner.js';
import { CodexAppServerAgentAdapter, FeatureFlaggedCodexAgentAdapter, type CodexAppServerFeatureDecision, type CodexAppServerOptions } from './codex-app-server-adapter.js';
import {
  CODEX_CONFORMED_VERSION_PATTERN,
  CODEX_OFFLINE_CONFIG_ARGS,
  CODEX_OFFLINE_NETWORK_CONTRACT,
} from './codex-offline-policy.js';
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
  executableNames: ['codex'], versionArgs: ['--version'], testedVersionPatterns: [CODEX_CONFORMED_VERSION_PATTERN],
  command: {
    args: [
      'exec', '--ignore-user-config', ...CODEX_OFFLINE_CONFIG_ARGS,
      '--json', '--color', 'never', '--sandbox', '{sandbox}', '--cd', '{workspace}', '-'
    ],
    promptTransport: 'stdin', modelArgs: ['--model', '{model}'], profileArgs: ['--profile', '{profile}']
  },
  capabilities: {
    ...baseCapabilities, structuredOutput: true,
    sandboxPolicies: ['read-only', 'workspace-write'],
    extensions: {
      networkControl: true,
      ...CODEX_OFFLINE_NETWORK_CONTRACT,
      offlineConfigOverrides: CODEX_OFFLINE_CONFIG_ARGS,
      officialSemantics: 'codex exec --ignore-user-config --strict-config --config --json',
      maturity: 'stable'
    }
  }
};

export const OPENCODE_MANIFEST: AgentAdapterManifest = {
  schemaVersion: '1.0', id: 'opencode', displayName: 'OpenCode', adapterVersion: '1.1.0',
  protocol: 'opencode-json', trust: 'builtin', enabled: true,
  executableNames: ['opencode'], versionArgs: ['--version'], testedVersionPatterns: ['^1\\.14\\.41$'],
  command: {
    args: ['run', '--pure', '--agent', 'job-match-read-only', '--format', 'json', '--dir', '{workspace}'],
    promptTransport: 'stdin', modelArgs: ['--model', '{model}']
  },
  capabilities: {
    ...baseCapabilities, structuredOutput: true, supportedRuntimeTargets: ['wsl'],
    extensions: {
      networkControl: true, contractRequiresFixture: true,
      conformanceFixture: 'contracts/fixtures/v1/opencode-events.json',
      forbiddenArguments: ['--auto', '--dangerously-skip-permissions'],
      approvalSemantics: 'provider-auto-reject-unapproved',
      pause: false, pauseSemantics: 'unsupported_cancel_only',
      externalSandbox: 'wsl-bubblewrap-v1', networkEnforcement: 'provider-tool-capability-policy',
      networkMechanism: 'server-owned-read-only-tool-allowlist', networkAccessClaim: 'provider-control-plane-only'
    }
  }
};

export const CLAUDE_CLI_MANIFEST: AgentAdapterManifest = {
  schemaVersion: '1.0', id: 'claude-cli', displayName: 'Claude CLI', adapterVersion: '1.1.0',
  protocol: 'claude-stream-json', trust: 'builtin', enabled: true,
  executableNames: ['claude'], versionArgs: ['--version'], testedVersionPatterns: ['^2\\.1\\.232 \\(Claude Code\\)$'],
  command: {
    args: [
      '--safe-mode', '-p', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'plan', '--tools', 'Read', '--disallowedTools', 'mcp__*',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands', '--no-session-persistence'
    ],
    promptTransport: 'stdin', modelArgs: ['--model', '{model}']
  },
  capabilities: {
    ...baseCapabilities, structuredOutput: true, supportedRuntimeTargets: ['wsl'],
    extensions: {
      networkControl: true, contractRequiresFixture: true,
      conformanceFixture: 'contracts/fixtures/v1/claude-cli-events.json',
      forbiddenArguments: ['--permission-mode=bypassPermissions', '--dangerously-skip-permissions'],
      permissionMode: 'plan', builtinToolAllowlist: ['Read'],
      customizations: 'safe-mode-strict-empty-mcp-and-slash-commands-disabled',
      pause: false, pauseSemantics: 'unsupported_cancel_only',
      externalSandbox: 'wsl-bubblewrap-v1', networkEnforcement: 'provider-tool-capability-policy',
      networkMechanism: 'server-owned-read-only-tool-allowlist', networkAccessClaim: 'provider-control-plane-only'
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
  if (type === 'text' || type.includes('message')) {
    return text ? [{ kind: type.includes('delta') ? 'agent_message_delta' : 'agent_message_completed', data: { text } }] : [];
  }
  if (type === 'step_start') return [{ kind: 'heartbeat', data: { phase: 'step_started', sessionId: event.sessionID, itemId: part?.id } }];
  if (type === 'step_finish') {
    const tokens = object(part?.tokens);
    const cache = object(tokens?.cache);
    const inputTokens = typeof tokens?.input === 'number' && Number.isFinite(tokens.input) ? tokens.input : undefined;
    const outputTokens = typeof tokens?.output === 'number' && Number.isFinite(tokens.output) ? tokens.output : undefined;
    const usage = {
      inputTokens,
      cachedInputTokens: typeof cache?.read === 'number' && Number.isFinite(cache.read) ? cache.read : undefined,
      outputTokens,
      reasoningTokens: typeof tokens?.reasoning === 'number' && Number.isFinite(tokens.reasoning) ? tokens.reasoning : undefined
    };
    const data = Object.fromEntries(Object.entries(usage).filter(([, candidate]) => candidate !== undefined)) as Record<string, number>;
    return Object.keys(data).length > 0
      ? [{ kind: 'usage_updated', data }]
      : [{ kind: 'heartbeat', data: { phase: 'step_finished' } }];
  }
  if (type === 'tool_use' || type.includes('tool')) {
    const state = object(part?.state);
    const status = typeof state?.status === 'string' ? state.status : type.includes('completed') ? 'completed' : 'running';
    const output = state?.output ?? state?.error;
    return [{
      kind: status === 'completed' || status === 'error' ? 'tool_completed' : 'tool_started',
      data: {
        providerEventType: type, id: part?.id, name: part?.tool ?? part?.name, status,
        ...(output === undefined ? {} : { output: String(output).slice(0, 64 * 1024) })
      }
    }];
  }
  if (type === 'error' || type.includes('error')) {
    const error = object(event.error);
    const details = object(error?.data);
    return [{ kind: 'error', data: {
      code: String(error?.name ?? error?.code ?? type),
      message: String(details?.message ?? error?.message ?? event.message ?? part?.message ?? 'OpenCode-Fehler'),
      retryable: false
    } }];
  }
  return [{ kind: 'warning', data: { code: 'unknown_opencode_event', providerEventType: type } }];
};

export const mapClaudeStreamEvent: ProviderEventMapper = (value): AgentEventDraft[] => {
  const event = object(value); const type = typeof event?.type === 'string' ? event.type : undefined;
  if (!event || !type) return [{ kind: 'warning', data: { code: 'invalid_claude_event' } }];
  if (type === 'assistant') {
    const message = object(event.message);
    const content = Array.isArray(message?.content ?? event.content) ? (message?.content ?? event.content) as unknown[] : [];
    const drafts: AgentEventDraft[] = [];
    for (const rawBlock of content) {
      const block = object(rawBlock);
      if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
        drafts.push({ kind: 'agent_message_completed', data: { text: block.text } });
      } else if (block?.type === 'tool_use') {
        drafts.push({ kind: 'tool_started', data: { id: block.id, name: block.name } });
      }
    }
    return drafts;
  }
  if (type === 'user') {
    const message = object(event.message);
    const content = Array.isArray(message?.content ?? event.content) ? (message?.content ?? event.content) as unknown[] : [];
    return content.flatMap((rawBlock): AgentEventDraft[] => {
      const block = object(rawBlock);
      if (block?.type !== 'tool_result') return [];
      const output = textFromContent(block.content);
      return [{ kind: 'tool_completed', data: {
        id: block.tool_use_id,
        status: block.is_error === true ? 'failed' : 'completed',
        ...(output === undefined ? {} : { output: output.slice(0, 64 * 1024) })
      } }];
    });
  }
  if (type === 'result') {
    const drafts: AgentEventDraft[] = [];
    const usage = normalizedUsage(event.usage);
    const totalCostUsd = typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd)
      && event.total_cost_usd >= 0 ? event.total_cost_usd : undefined;
    if (usage || totalCostUsd !== undefined) drafts.push({
      kind: 'usage_updated',
      data: {
        ...(usage ?? {}),
        ...(totalCostUsd === undefined ? {} : { reportedCostMicros: Math.round(totalCostUsd * 1_000_000), currency: 'USD' }),
      },
    });
    if (event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success')) {
      drafts.push({ kind: 'error', data: { code: String(event.subtype ?? 'claude_result_error'), message: String(event.result ?? 'Claude-Fehler'), retryable: false } });
    }
    return drafts;
  }
  if (type === 'system' && event.subtype === 'init') {
    const exactTools = Array.isArray(event.tools) && event.tools.length === 1 && event.tools[0] === 'Read';
    const empty = (candidate: unknown): boolean => Array.isArray(candidate) && candidate.length === 0;
    const conforms = event.claude_code_version === '2.1.232' && event.permissionMode === 'plan' && exactTools
      && empty(event.mcp_servers) && empty(event.plugins) && empty(event.skills) && empty(event.slash_commands);
    if (!conforms) return [{ kind: 'error', data: {
      code: 'claude_runtime_conformance_mismatch',
      message: 'Claude-Runtime meldet breitere oder unvollstaendige Capabilities.',
      retryable: false
    } }];
    return [{ kind: 'heartbeat', data: {
      phase: 'initialized', sessionId: event.session_id, providerVersion: event.claude_code_version,
      permissionMode: event.permissionMode, tools: event.tools
    } }];
  }
  if (type === 'system' && event.subtype === 'api_retry') {
    const knownErrors = new Set([
      'authentication_failed', 'oauth_org_not_allowed', 'billing_error', 'rate_limit', 'overloaded',
      'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens', 'unknown'
    ]);
    const errorCategory = typeof event.error === 'string' && knownErrors.has(event.error) ? event.error : 'unknown';
    return [{ kind: 'warning', data: {
      code: 'provider_api_retry', attempt: event.attempt, maxRetries: event.max_retries,
      retryDelayMs: event.retry_delay_ms, errorCategory
    } }];
  }
  if (type === 'system') return [{ kind: 'heartbeat', data: { phase: String(event.subtype ?? 'system') } }];
  if (type.includes('tool')) return [{ kind: type.includes('result') ? 'tool_completed' : 'tool_started', data: { providerEventType: type } }];
  return [{ kind: 'warning', data: { code: 'unknown_claude_event', providerEventType: type } }];
};

export class CodexExecAgentAdapter implements AgentRunnerPort {
  readonly provider = CODEX_EXEC_MANIFEST.id;
  private readonly delegate: FeatureFlaggedCodexAgentAdapter;
  constructor(supervisor = new ProcessSupervisor(), discovery = new AgentRuntimeDiscovery(), allowUntestedVersions = false, appServerOptions: CodexAppServerOptions & { enabled?: CodexAppServerFeatureDecision } = {}) {
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
