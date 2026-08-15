import { isAbsolute } from 'node:path';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  AGENT_CONTRACT_VERSION,
  type AgentCapabilities,
  type AgentEventDraft,
  type AgentProviderInstallation,
  type AgentRunnerPort,
  type AgentRunHandle,
  type ApprovalDecision,
  type ProviderDomainToolDescriptor,
  type ProviderRunContext
} from '../ports/agent-runner.js';
import { IncrementalJsonlParser } from './jsonl-parser.js';
import { buildMinimalProviderEnvironment, PROVIDER_RESOURCE_CEILINGS, type ProviderEnvironmentBuilder } from './generic-jsonl-adapter.js';
import { DEFAULT_PROCESS_LIMITS, ProcessSupervisor, type SupervisedProcess } from './process-supervisor.js';
import { assertTrustedHostJobMcpNotNestedInAgentSandbox } from './provider-sandbox.js';
import { AgentRuntimeDiscovery } from './runtime-discovery.js';
import {
  CODEX_CONFORMED_VERSION_PATTERN,
  CODEX_OFFLINE_CONFIG_ARGS,
  CODEX_OFFLINE_NETWORK_CONTRACT,
  CODEX_SANDBOX_ENFORCEMENT_ID,
  hasFixedCodexOfflineConfig,
  isConformedCodexVersion,
} from './codex-offline-policy.js';

export const CODEX_APP_SERVER_FEATURE_FLAG = 'CODEX_APP_SERVER_EXPERIMENTAL';

/** Versioned, built-in manifest. Only stdio is allowed; no listener address is configurable. */
export const CODEX_APP_SERVER_MANIFEST = Object.freeze({
  schemaVersion: '1.0',
  id: 'codex-app-server',
  providerId: 'codex-exec',
  adapterVersion: '0.1.0',
  protocol: 'codex-app-server-jsonrpc-v2',
  maturity: 'experimental',
  transport: 'stdio-jsonl',
  featureFlag: CODEX_APP_SERVER_FEATURE_FLAG,
  executableNames: ['codex'],
  versionArgs: ['--version'],
  testedVersionPatterns: [CODEX_CONFORMED_VERSION_PATTERN],
  commandArgs: ['app-server', ...CODEX_OFFLINE_CONFIG_ARGS, '--listen', 'stdio://'],
  fallbackProviderId: 'codex-exec'
} as const);

type JsonObject = Record<string, unknown>;
type RpcId = number | string;
type RpcResponse = { id: RpcId; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };

interface PendingRpc {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface ProviderApprovalBridge {
  kind: 'provider';
  rpcId: RpcId;
  method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval';
}

interface DomainToolApprovalBridge {
  kind: 'domain_tool';
  rpcId: RpcId;
  requestId: string;
  toolName: string;
  args: Readonly<Record<string, unknown>>;
  callId: string;
}

type ApprovalBridge = ProviderApprovalBridge | DomainToolApprovalBridge;

interface AppServerRun {
  context: ProviderRunContext;
  process: SupervisedProcess;
  parser: IncrementalJsonlParser;
  pending: Map<RpcId, PendingRpc>;
  approvals: Map<string, ApprovalBridge>;
  threadId?: string;
  turnId?: string;
  protocolFailure?: Error;
  terminal?: Awaited<AgentRunHandle['completion']>;
  emitQueue: Promise<void>;
  nextRpcId: number;
  dynamicToolNames: Map<string, string>;
  isolatedCodexHome?: { path: string; dispose(): Promise<void> };
}

export interface CodexAppServerOptions {
  requestTimeoutMs?: number;
  cancelGraceMs?: number;
  environmentBuilder?: ProviderEnvironmentBuilder;
  /** Conformance-only hook; production falls back until user config can be ignored. */
  userConfigIsolationVerified?: boolean;
}

export type CodexAppServerFeatureDecision = boolean | (() => boolean | Promise<boolean>);

async function isolatedCodexHome(runId: string): Promise<{ path: string; dispose(): Promise<void> }> {
  const safeRun = runId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'run';
  const base = resolve(tmpdir(), 'job-match-codex-homes');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const path = resolve(base, `${safeRun}-${randomUUID()}`);
  if (!path.startsWith(`${base}\\`) && !path.startsWith(`${base}/`)) throw new Error('codex_isolated_home_escape');
  await mkdir(path, { recursive: false, mode: 0o700 });
  const configuredHome = process.env.CODEX_HOME;
  const userHome = process.env.USERPROFILE ?? process.env.HOME;
  const sourceHome = configuredHome && isAbsolute(configuredHome)
    ? resolve(configuredHome) : userHome && isAbsolute(userHome) ? resolve(userHome, '.codex') : undefined;
  if (sourceHome) {
    const authPath = resolve(sourceHome, 'auth.json');
    try {
      const info = await lstat(authPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('codex_auth_source_unsafe');
      const auth = await readFile(authPath);
      await writeFile(resolve(path, 'auth.json'), auth, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
    }
  }
  return {
    path,
    async dispose() {
      if (!path.startsWith(`${base}\\`) && !path.startsWith(`${base}/`)) throw new Error('codex_isolated_home_escape');
      await rm(path, { recursive: true, force: true });
    },
  };
}

export class CodexAppServerHealthError extends Error {
  constructor(message: string) { super(message); this.name = 'CodexAppServerHealthError'; }
}

export class CodexAppServerProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'CodexAppServerProtocolError'; }
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringField(value: unknown, field: string): string | undefined {
  const candidate = object(value)?.[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

function rpcId(value: unknown): RpcId | undefined {
  const id = object(value)?.id;
  return typeof id === 'number' || typeof id === 'string' ? id : undefined;
}

function versionSupported(version: string | undefined): boolean { return isConformedCodexVersion(version); }

function sandboxPolicy(context: ProviderRunContext, workspaceRoot: string): JsonObject {
  if (context.request.sandbox === 'danger-full-access') throw new Error('Codex App Server erlaubt in dieser Integration keine danger-full-access Sandbox.');
  if (context.request.network !== 'disabled') throw new Error('Codex App Server ist in dieser Integration ausschliesslich offline freigegeben.');
  return context.request.sandbox === 'workspace-write'
    ? { type: 'workspaceWrite', writableRoots: [workspaceRoot], networkAccess: false }
    : { type: 'readOnly', networkAccess: false };
}

function approvalPolicy(context: ProviderRunContext): 'never' | 'onRequest' {
  return context.request.approvalMode === 'explicit' ? 'onRequest' : 'never';
}

function safeMessage(value: unknown, fallback: string): string {
  return String(value ?? fallback)
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .slice(0, 8_192);
}

function dynamicToolName(name: string): string {
  const normalized = name.replace(/\./g, '__');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(normalized)) throw new CodexAppServerProtocolError('Root-Toolname ist fuer Codex ungueltig.');
  return normalized;
}

function dynamicTools(context: ProviderRunContext): JsonObject[] | undefined {
  if (!context.domainTools) return undefined;
  const descriptors = context.domainTools.listTools();
  if (!descriptors.length || descriptors.length > 64) throw new CodexAppServerProtocolError('Root-Toolkatalog ist leer oder zu gross.');
  const names = new Set<string>();
  const tools = descriptors.map((tool: ProviderDomainToolDescriptor) => {
    const name = dynamicToolName(tool.name);
    if (names.has(name)) throw new CodexAppServerProtocolError('Root-Toolnamen kollidieren nach der Codex-Normalisierung.');
    names.add(name);
    return {
      type: 'function', name, description: tool.description.slice(0, 1_024),
      deferLoading: false, inputSchema: structuredClone(tool.inputSchema),
    };
  });
  return [{
    type: 'namespace', name: context.domainTools.namespace,
    description: 'Rungebundene, serverseitig minimierte Werkzeuge fuer Jobs, Bewerbungsfaelle, Mail und Dokumentvorschlaege.',
    tools,
  }];
}

function safeDomainToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^(?:mcp|approval|capability)_[a-z0-9_:,.-]+$/i.test(message)
    ? message.slice(0, 240) : 'mcp_tool_failed';
}

function itemDrafts(method: 'item/started' | 'item/completed', params: JsonObject): AgentEventDraft[] {
  const item = object(params.item);
  if (!item || typeof item.type !== 'string' || typeof item.id !== 'string') {
    throw new CodexAppServerProtocolError(`${method}: ungueltige item-Struktur.`);
  }
  const completed = method === 'item/completed';
  switch (item.type) {
    case 'userMessage':
    case 'reasoning':
    case 'contextCompaction':
    case 'enteredReviewMode':
      return [{ kind: 'heartbeat', data: { phase: item.type, itemId: item.id } }];
    case 'agentMessage': {
      if (!completed) return [];
      if (typeof item.text !== 'string') throw new CodexAppServerProtocolError('agentMessage ohne Text.');
      return [{ kind: 'agent_message_completed', data: { text: item.text, itemId: item.id, phase: item.phase } }];
    }
    case 'plan':
      return completed && typeof item.text === 'string'
        ? [{ kind: 'tool_output', data: { id: item.id, type: 'plan', output: item.text } }]
        : [{ kind: 'heartbeat', data: { phase: 'plan', itemId: item.id } }];
    case 'commandExecution':
    case 'fileChange':
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabToolCall':
    case 'webSearch':
    case 'imageView': {
      const data: JsonObject = { id: item.id, type: item.type, status: item.status };
      if (item.type === 'commandExecution') {
        data.name = Array.isArray(item.command) ? item.command.map(String).join(' ') : item.command;
        if (typeof item.aggregatedOutput === 'string') data.output = item.aggregatedOutput.slice(0, 64 * 1024);
        if (typeof item.exitCode === 'number') data.exitCode = item.exitCode;
      } else if (item.type === 'fileChange') data.name = 'fileChange';
      else data.name = item.tool ?? item.query ?? item.type;
      return [{ kind: completed ? 'tool_completed' : 'tool_started', data }];
    }
    case 'exitedReviewMode':
      return completed && typeof item.review === 'string'
        ? [{ kind: 'agent_message_completed', data: { text: item.review, itemId: item.id, phase: 'review' } }]
        : [];
    default:
      throw new CodexAppServerProtocolError(`Unbekannter Codex App Server item-Typ: ${item.type}`);
  }
}

/** Maps only methods documented by the v2 App Server contract. Unknown methods throw fail-closed. */
export function mapCodexAppServerNotification(method: string, paramsValue: unknown): AgentEventDraft[] {
  const params = object(paramsValue) ?? {};
  switch (method) {
    case 'thread/started': {
      const threadId = stringField(params.thread, 'id');
      if (!threadId) throw new CodexAppServerProtocolError('thread/started ohne thread.id.');
      return [{ kind: 'warning', data: { code: 'provider_session_started', sessionId: threadId } }];
    }
    case 'thread/status/changed':
    case 'thread/closed':
    case 'serverRequest/resolved':
    case 'turn/diff/updated':
    case 'turn/plan/updated':
    case 'hook/started':
    case 'hook/completed':
    case 'model/safetyBuffering/updated':
    case 'model/rerouted':
    case 'model/verification':
      return [{ kind: 'heartbeat', data: { phase: method } }];
    case 'thread/archived':
    case 'thread/unarchived':
      return [{ kind: 'warning', data: { code: method.replace('/', '_') } }];
    case 'turn/started': {
      const turnId = stringField(params.turn, 'id');
      if (!turnId) throw new CodexAppServerProtocolError('turn/started ohne turn.id.');
      return [{ kind: 'heartbeat', data: { phase: 'turn_started', turnId } }];
    }
    case 'item/started':
    case 'item/completed':
      return itemDrafts(method, params);
    case 'item/agentMessage/delta':
      if (typeof params.delta !== 'string') throw new CodexAppServerProtocolError('Agent-Delta ohne Text.');
      return [{ kind: 'agent_message_delta', data: { text: params.delta, itemId: params.itemId } }];
    case 'item/plan/delta':
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/summaryPartAdded':
    case 'item/reasoning/textDelta':
      return [{ kind: 'heartbeat', data: { phase: method } }];
    case 'item/commandExecution/outputDelta':
      if (typeof params.delta !== 'string') throw new CodexAppServerProtocolError('Command-Delta ohne Text.');
      return [{ kind: 'tool_output', data: { id: params.itemId, output: params.delta.slice(0, 64 * 1024) } }];
    case 'thread/tokenUsage/updated': {
      const usage = object(params.tokenUsage ?? params.usage ?? params);
      const number = (...keys: string[]): number | undefined => {
        const candidate = keys.map((key) => usage?.[key]).find((value) => typeof value === 'number' && Number.isFinite(value));
        return typeof candidate === 'number' ? candidate : undefined;
      };
      return [{ kind: 'usage_updated', data: Object.fromEntries(Object.entries({
        inputTokens: number('inputTokens', 'input_tokens'),
        cachedInputTokens: number('cachedInputTokens', 'cached_input_tokens'),
        outputTokens: number('outputTokens', 'output_tokens'),
        reasoningTokens: number('reasoningTokens', 'reasoning_tokens'),
        totalTokens: number('totalTokens', 'total_tokens')
      }).filter(([, value]) => value !== undefined)) }];
    }
    case 'configWarning':
      return [{ kind: 'warning', data: { code: 'codex_config_warning', message: safeMessage(params.summary, 'Codex-Konfigurationswarnung') } }];
    case 'warning':
      return [{ kind: 'warning', data: { code: 'codex_warning', message: safeMessage(params.message, 'Codex-Warnung') } }];
    case 'error': {
      const error = object(params.error);
      return [{ kind: 'error', data: { code: 'codex_app_server_error', message: safeMessage(error?.message, 'Codex App Server Fehler'), retryable: false } }];
    }
    case 'turn/completed':
      return [];
    default:
      throw new CodexAppServerProtocolError(`Unbekanntes Codex App Server Ereignis: ${method}`);
  }
}

export class CodexAppServerAgentAdapter implements AgentRunnerPort {
  readonly provider = CODEX_APP_SERVER_MANIFEST.providerId;
  private readonly active = new Map<string, AppServerRun>();
  private readonly previous = new Map<string, { context: ProviderRunContext; threadId: string }>();
  private readonly timeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly environmentBuilder: ProviderEnvironmentBuilder;
  private readonly userConfigIsolationVerified: boolean;

  constructor(
    private readonly supervisor: Pick<ProcessSupervisor, 'start'> = new ProcessSupervisor(),
    private readonly discovery = new AgentRuntimeDiscovery(),
    options: CodexAppServerOptions = {}
  ) {
    this.timeoutMs = options.requestTimeoutMs ?? 5_000;
    this.cancelGraceMs = Math.max(25, Math.min(options.cancelGraceMs ?? 750, 5_000));
    this.environmentBuilder = options.environmentBuilder ?? buildMinimalProviderEnvironment;
    this.userConfigIsolationVerified = options.userConfigIsolationVerified === true;
  }

  supports(installation: AgentProviderInstallation): boolean {
    return installation.provider === this.provider && installation.runtimeTarget !== 'wsl'
      && installation.support === 'supported' && versionSupported(installation.version);
  }

  hasVerifiedUserConfigIsolation(): boolean { return this.userConfigIsolationVerified; }

  async discover(): Promise<AgentProviderInstallation[]> {
    const definition = {
      provider: this.provider, executableNames: CODEX_APP_SERVER_MANIFEST.executableNames,
      versionArgs: CODEX_APP_SERVER_MANIFEST.versionArgs,
      testedVersionPatterns: CODEX_APP_SERVER_MANIFEST.testedVersionPatterns.map((pattern) => new RegExp(pattern, 'i')),
      authStatusArgs: ['login', 'status']
    };
    const local = await this.discovery.discoverLocal(definition);
    const wsl = process.platform === 'win32' ? await this.discovery.discoverWsl(definition) : [];
    return [...local, ...wsl];
  }

  async capabilities(installation: AgentProviderInstallation): Promise<AgentCapabilities> {
    if (!this.supports(installation)) throw new CodexAppServerHealthError('Codex-Version ist nicht fuer den App-Server-Vertrag freigegeben.');
    if (!this.userConfigIsolationVerified || !hasFixedCodexOfflineConfig(CODEX_APP_SERVER_MANIFEST.commandArgs)) {
      throw new CodexAppServerHealthError('codex_offline_network_control_unverified');
    }
    return {
      schemaVersion: AGENT_CONTRACT_VERSION, provider: this.provider, providerVersion: installation.version,
      adapterVersion: CODEX_APP_SERVER_MANIFEST.adapterVersion, protocolVersion: CODEX_APP_SERVER_MANIFEST.protocol,
      streaming: true, resume: true, interactiveInput: true, approvals: true, tools: true, images: true,
      structuredOutput: true, sandboxPolicies: ['read-only', 'workspace-write'], usage: true,
      supportedRuntimeTargets: ['windows', 'linux', 'darwin'],
      extensions: {
        maturity: 'experimental', transport: 'stdio', networkControl: true,
        ...CODEX_OFFLINE_NETWORK_CONTRACT,
        offlineConfigOverrides: CODEX_OFFLINE_CONFIG_ARGS,
        dynamicTools: true, dynamicToolsContract: 'codex-app-server-item-tool-call-v1',
        pause: false, pauseSemantics: 'unsupported_cancel_only',
        featureFlag: CODEX_APP_SERVER_FEATURE_FLAG,
      }
    };
  }

  private queue(run: AppServerRun, draft: AgentEventDraft): void {
    run.emitQueue = run.emitQueue.then(() => run.context.emit(draft));
  }

  private write(run: AppServerRun, value: JsonObject): Promise<void> {
    return run.process.writeInput(`${JSON.stringify(value)}\n`);
  }

  private request(run: AppServerRun, method: string, params: JsonObject): Promise<unknown> {
    const id = run.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        run.pending.delete(id);
        reject(new CodexAppServerHealthError(`Codex App Server antwortet nicht auf ${method}.`));
      }, this.timeoutMs);
      timer.unref();
      run.pending.set(id, { resolve, reject, timer });
      void this.write(run, { method, id, params }).catch((error) => {
        clearTimeout(timer); run.pending.delete(id); reject(error as Error);
      });
    });
  }

  private protocolFailure(run: AppServerRun, error: Error): void {
    if (run.protocolFailure) return;
    run.protocolFailure = error;
    this.queue(run, { kind: 'error', data: { code: 'codex_app_server_protocol_error', message: safeMessage(error.message, 'Protokollfehler'), retryable: false } });
    void run.process.cancel('Codex App Server Protokollabweichung.');
  }

  private respond(run: AppServerRun, id: RpcId, result: JsonObject): void {
    void this.write(run, { id, result }).catch((error) => this.protocolFailure(run, error as Error));
  }

  private async executeDomainTool(
    run: AppServerRun,
    rpcIdValue: RpcId,
    callId: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      const result = await run.context.domainTools!.execute(toolName, args);
      const text = JSON.stringify({ data: result.data, sourceReferences: result.sourceReferences });
      if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('mcp_tool_result_too_large');
      this.respond(run, rpcIdValue, { contentItems: [{ type: 'inputText', text }], success: true });
      this.queue(run, { kind: 'tool_output', data: {
        id: callId, name: toolName, success: true,
        sourceReferences: [...result.sourceReferences], result: result.data,
      } });
    } catch (error) {
      const code = safeDomainToolError(error);
      this.respond(run, rpcIdValue, {
        contentItems: [{ type: 'inputText', text: JSON.stringify({ error: code }) }], success: false,
      });
      this.queue(run, { kind: 'warning', data: { code, toolName, callId } });
    }
  }

  private async dynamicToolRequest(run: AppServerRun, message: JsonObject, id: RpcId): Promise<void> {
    const params = object(message.params) ?? {};
    const threadId = stringField(params, 'threadId');
    const turnId = stringField(params, 'turnId');
    const callId = stringField(params, 'callId');
    const namespace = stringField(params, 'namespace');
    const providerToolName = stringField(params, 'tool');
    const args = object(params.arguments);
    if (!run.context.domainTools || !threadId || !turnId || !callId || !namespace || !providerToolName || !args
      || threadId !== run.threadId || turnId !== run.turnId || namespace !== run.context.domainTools.namespace) {
      throw new CodexAppServerProtocolError('Dynamischer Toolcall ist nicht an Run, Thread und Turn gebunden.');
    }
    if (Buffer.byteLength(JSON.stringify(args), 'utf8') > 256 * 1024) throw new CodexAppServerProtocolError('Dynamischer Toolcall ist zu gross.');
    const toolName = run.dynamicToolNames.get(providerToolName);
    const descriptor = toolName ? run.context.domainTools.listTools().find((tool) => tool.name === toolName) : undefined;
    if (!toolName || !descriptor) throw new CodexAppServerProtocolError('Dynamischer Toolcall ist nicht allowlistet.');
    this.queue(run, { kind: 'tool_requested', data: { id: callId, name: toolName, risk: descriptor.risk } });
    if (!descriptor.requiresApproval) {
      await this.executeDomainTool(run, id, callId, toolName, args);
      return;
    }
    const approval = await run.context.domainTools.requestApproval(toolName, args);
    run.approvals.set(approval.id, {
      kind: 'domain_tool', rpcId: id, requestId: approval.id, toolName,
      args: structuredClone(args), callId,
    });
    this.queue(run, { kind: 'approval_requested', data: {
      id: approval.id, itemId: callId, kind: 'root_domain_tool', title: approval.title,
      explanation: approval.explanation, risk: approval.risk, requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt, summary: `${toolName} · einmalig und parametergebunden`,
    } });
  }

  private serverRequest(run: AppServerRun, message: JsonObject, method: string, id: RpcId): void {
    if (method === 'item/tool/call') {
      void this.dynamicToolRequest(run, message, id).catch((error) => this.protocolFailure(run, error as Error));
      return;
    }
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
      void this.write(run, { id, error: { code: -32601, message: 'Unsupported server request' } })
        .catch((error) => this.protocolFailure(run, error as Error));
      this.protocolFailure(run, new CodexAppServerProtocolError(`Unbekannter serverinitiierter Request: ${method}`));
      return;
    }
    const params = object(message.params) ?? {};
    const threadId = stringField(params, 'threadId'); const turnId = stringField(params, 'turnId'); const itemId = stringField(params, 'itemId');
    if (!threadId || !turnId || !itemId || threadId !== run.threadId || turnId !== run.turnId) {
      this.protocolFailure(run, new CodexAppServerProtocolError('Approval ist nicht an den aktiven Thread/Turn gebunden.'));
      return;
    }
    if (run.context.request.approvalMode !== 'explicit') {
      this.respond(run, id, { decision: 'decline' });
      this.queue(run, { kind: 'warning', data: { code: 'approval_denied_by_policy', itemId } });
      return;
    }
    const approvalId = `codex-${String(id)}`;
    run.approvals.set(approvalId, { kind: 'provider', rpcId: id, method });
    this.queue(run, { kind: 'approval_requested', data: {
      id: approvalId, itemId, kind: method.includes('fileChange') ? 'file_change' : 'command_execution',
      title: method.includes('fileChange') ? 'Codex-Dateiaenderung freigeben' : 'Codex-Befehl freigeben',
      explanation: safeMessage(params.reason, 'Codex bittet um eine einmalige Freigabe.'), risk: 'execute',
      threadId, turnId, command: params.command, cwd: params.cwd, grantRoot: params.grantRoot
    } });
  }

  private consume(run: AppServerRun, value: unknown): void {
    try {
      const message = object(value);
      if (!message) throw new CodexAppServerProtocolError('JSON-RPC-Nachricht ist kein Objekt.');
      const id = rpcId(message);
      const method = typeof message.method === 'string' ? message.method : undefined;
      if (id !== undefined && !method) {
        const pending = run.pending.get(id);
        if (!pending) throw new CodexAppServerProtocolError(`Antwort mit unbekannter ID: ${String(id)}`);
        clearTimeout(pending.timer); run.pending.delete(id);
        const error = object(message.error);
        if (error) pending.reject(new Error(`Codex RPC ${String(error.code ?? '')}: ${safeMessage(error.message, 'Fehler')}`));
        else if ('result' in message) pending.resolve(message.result);
        else pending.reject(new CodexAppServerProtocolError('RPC-Antwort ohne result/error.'));
        return;
      }
      if (!method) throw new CodexAppServerProtocolError('JSON-RPC-Nachricht ohne method/id.');
      if (id !== undefined) { this.serverRequest(run, message, method, id); return; }
      if (method === 'turn/started') run.turnId = stringField(object(message.params)?.turn, 'id') ?? run.turnId;
      if (method === 'turn/completed') {
        const turn = object(object(message.params)?.turn);
        if (!turn || typeof turn.status !== 'string' || !['completed', 'interrupted', 'failed'].includes(turn.status)) {
          throw new CodexAppServerProtocolError('turn/completed besitzt unbekannten Status.');
        }
        run.terminal = turn.status === 'completed' ? { state: 'succeeded' }
          : turn.status === 'interrupted' ? { state: 'cancelled' }
            : { state: 'failed', failure: { code: 'codex_turn_failed', message: safeMessage(object(turn.error)?.message, 'Codex-Turn fehlgeschlagen.'), retryable: false } };
        this.queue(run, { kind: 'run_completed', data: { state: run.terminal.state, transport: 'codex-app-server' } });
        void run.process.cancel('Codex App Server Turn abgeschlossen.');
        return;
      }
      for (const draft of mapCodexAppServerNotification(method, message.params)) this.queue(run, draft);
    } catch (error) { this.protocolFailure(run, error as Error); }
  }

  private async launch(context: ProviderRunContext, resumeThreadId?: string, resumeInput?: string): Promise<AgentRunHandle> {
    if (this.active.has(context.runId)) throw new Error(`Run ${context.runId} laeuft bereits.`);
    if (!this.supports(context.installation)) throw new CodexAppServerHealthError('Codex App Server Manifest/Version ist nicht freigegeben.');
    if (!this.userConfigIsolationVerified) throw new CodexAppServerHealthError('user_config_isolation_unverified');
    if (!isAbsolute(context.request.workspaceRoot)) throw new Error('Workspace muss absolut sein.');
    if (!context.request.task.trim() || context.request.task.includes('\0')) throw new Error('Agentenaufgabe ist ungueltig.');
    await assertTrustedHostJobMcpNotNestedInAgentSandbox(context.request.workspaceRoot);
    let workspace = context.request.workspaceRoot;
    let args: string[] = [...CODEX_APP_SERVER_MANIFEST.commandArgs];
    const policy = sandboxPolicy(context, workspace);
    if (args.some((argument) => /^(?:ws|wss|unix):\/\//i.test(argument))) throw new Error('Codex App Server Listenertransport ist nicht erlaubt.');

    const isolatedHome = await isolatedCodexHome(context.runId);
    let run!: AppServerRun;
    const parser = new IncrementalJsonlParser();
    let processHandle: SupervisedProcess;
    try {
      processHandle = this.supervisor.start({
        executable: context.installation.executable, args, cwd: context.request.workspaceRoot,
        env: { ...this.environmentBuilder(this.provider, context.installation), CODEX_HOME: isolatedHome.path },
        limits: {
          ...DEFAULT_PROCESS_LIMITS,
          ...context.request.limits,
          maxResidentMemoryBytes: Math.min(
            context.request.limits?.maxResidentMemoryBytes ?? PROVIDER_RESOURCE_CEILINGS.maxResidentMemoryBytes,
            PROVIDER_RESOURCE_CEILINGS.maxResidentMemoryBytes,
          ),
          maxChildProcesses: Math.min(
            context.request.limits?.maxChildProcesses ?? PROVIDER_RESOURCE_CEILINGS.maxChildProcesses,
            PROVIDER_RESOURCE_CEILINGS.maxChildProcesses,
          ),
        }
      }, {
        onStart: (pid) => this.queue(run, { kind: 'process_started', data: {
          pid, runtimeTarget: context.installation.runtimeTarget, transport: 'stdio',
          sandboxEnforcement: CODEX_SANDBOX_ENFORCEMENT_ID,
          ...CODEX_OFFLINE_NETWORK_CONTRACT,
        } }),
        onStdout: (chunk) => {
          const batch = parser.feed(chunk);
          for (const value of batch.values) this.consume(run, value);
          if (batch.diagnostics.length) this.protocolFailure(run, new CodexAppServerProtocolError(`Ungueltiges JSONL: ${batch.diagnostics[0]?.code}`));
        },
        onStderr: (chunk) => this.queue(run, { kind: 'warning', data: { code: 'provider_stderr', message: safeMessage(chunk, 'Codex stderr') } }),
        onHeartbeat: () => this.queue(run, { kind: 'heartbeat', data: { transport: 'stdio' } })
      });
    } catch (error) {
      await isolatedHome.dispose().catch(() => undefined);
      throw error;
    }
    run = {
      context, process: processHandle, parser, pending: new Map(), approvals: new Map(),
      emitQueue: Promise.resolve(), nextRpcId: 1,
      dynamicToolNames: new Map((context.domainTools?.listTools() ?? []).map((tool) => [dynamicToolName(tool.name), tool.name])),
      isolatedCodexHome: isolatedHome,
    };
    this.active.set(context.runId, run);

    try {
      const initialized = object(await this.request(run, 'initialize', {
        clientInfo: { name: 'job_match_and_apply', title: 'Job Match and Apply', version: CODEX_APP_SERVER_MANIFEST.adapterVersion },
        capabilities: { experimentalApi: Boolean(context.domainTools) },
      }));
      if (!initialized) throw new CodexAppServerHealthError('Initialize-Healthcheck lieferte kein Objekt.');
      await this.write(run, { method: 'initialized', params: {} });
      const scopedDynamicTools = dynamicTools(context);
      const threadResult = object(await this.request(run, resumeThreadId ? 'thread/resume' : 'thread/start', resumeThreadId
        ? { threadId: resumeThreadId, cwd: workspace, approvalPolicy: approvalPolicy(context), sandbox: context.request.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly', ...(scopedDynamicTools ? { dynamicTools: scopedDynamicTools } : {}) }
        : { cwd: workspace, approvalPolicy: approvalPolicy(context), sandbox: context.request.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly', serviceName: 'job_match_and_apply', ephemeral: true, ...(scopedDynamicTools ? { dynamicTools: scopedDynamicTools } : {}), ...(context.request.model ? { model: context.request.model } : {}) }));
      const threadId = stringField(threadResult?.thread, 'id');
      if (!threadId || (resumeThreadId && threadId !== resumeThreadId)) throw new CodexAppServerHealthError('Thread-Healthcheck lieferte keine passende thread.id.');
      run.threadId = threadId;
      const input = resumeThreadId ? resumeInput : context.request.task;
      if (!input?.trim()) throw new Error('Resume benoetigt eine neue Eingabe.');
      const turnResult = object(await this.request(run, 'turn/start', {
        threadId, input: [{ type: 'text', text: input }], cwd: workspace,
        approvalPolicy: approvalPolicy(context), sandboxPolicy: policy,
        ...(context.request.model ? { model: context.request.model } : {})
      }));
      const turnId = stringField(turnResult?.turn, 'id');
      if (!turnId) throw new CodexAppServerHealthError('Turn-Healthcheck lieferte keine turn.id.');
      run.turnId = turnId;
      this.previous.set(context.runId, { context, threadId });
    } catch (error) {
      await processHandle.cancel('App-Server-Healthcheck fehlgeschlagen.');
      this.active.delete(context.runId);
      await isolatedHome.dispose();
      for (const pending of run.pending.values()) { clearTimeout(pending.timer); pending.reject(error as Error); }
      throw error instanceof CodexAppServerHealthError ? error : new CodexAppServerHealthError((error as Error).message);
    }

    const completion = (async () => {
      const result = await processHandle.completion;
      const tail = parser.end();
      for (const value of tail.values) this.consume(run, value);
      if (tail.diagnostics.length) run.protocolFailure ??= new CodexAppServerProtocolError('Unvollstaendige JSONL-Nachricht.');
      for (const pending of run.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Codex App Server wurde beendet.')); }
      await run.emitQueue;
      this.active.delete(context.runId);
      await run.isolatedCodexHome?.dispose().catch(() => undefined);
      if (run.protocolFailure) return { state: 'failed' as const, failure: { code: 'codex_app_server_protocol_error', message: run.protocolFailure.message, retryable: false } };
      if (run.terminal) return run.terminal;
      if (result.termination === 'cancelled') return { state: 'cancelled' as const };
      return { state: result.termination === 'timeout' || result.termination === 'idle_timeout' ? 'timed_out' as const : 'failed' as const,
        failure: { code: `codex_app_server_${result.termination}`, message: result.error ?? 'Codex App Server endete ohne turn/completed.', retryable: false } };
    })();
    return { runId: context.runId, completion };
  }

  start(context: ProviderRunContext): Promise<AgentRunHandle> { return this.launch(context); }

  async sendInput(runId: string, input: string): Promise<void> {
    const run = this.active.get(runId);
    if (!run?.threadId || !run.turnId) throw new Error(`Codex App Server Run ${runId} ist nicht aktiv.`);
    if (!input.trim() || input.includes('\0')) throw new Error('Eingabe ist ungueltig.');
    const result = object(await this.request(run, 'turn/steer', {
      threadId: run.threadId, expectedTurnId: run.turnId, input: [{ type: 'text', text: input }]
    }));
    if (stringField(result, 'turnId') !== run.turnId) throw new CodexAppServerProtocolError('turn/steer bestaetigt nicht den aktiven Turn.');
  }

  async resolveApproval(runId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const run = this.active.get(runId); const bridge = run?.approvals.get(approvalId);
    if (!run || !bridge) throw new Error('Approval ist nicht offen oder gehoert nicht zu diesem Run.');
    if (bridge.kind === 'domain_tool') {
      const approved = decision === 'approved';
      await run.context.domainTools!.resolveApproval(bridge.requestId, approved ? 'approve' : 'deny', 'local-user');
      run.approvals.delete(approvalId);
      this.queue(run, { kind: 'approval_resolved', data: { id: approvalId, decision } });
      if (approved) await this.executeDomainTool(run, bridge.rpcId, bridge.callId, bridge.toolName, bridge.args);
      else this.respond(run, bridge.rpcId, {
        contentItems: [{ type: 'inputText', text: JSON.stringify({ error: 'mcp_approval_denied' }) }], success: false,
      });
      return;
    }
    const mapped = decision === 'approved' ? 'accept' : decision === 'cancelled' || decision === 'expired' ? 'cancel' : 'decline';
    this.respond(run, bridge.rpcId, { decision: mapped });
    run.approvals.delete(approvalId);
    this.queue(run, { kind: 'approval_resolved', data: { id: approvalId, decision } });
  }

  async cancel(runId: string): Promise<void> {
    const run = this.active.get(runId);
    if (!run?.threadId || !run.turnId) throw new Error(`Codex App Server Run ${runId} ist nicht aktiv.`);
    for (const [approvalId, bridge] of [...run.approvals]) {
      if (bridge.kind === 'domain_tool') {
        await run.context.domainTools?.resolveApproval(bridge.requestId, 'deny', 'local-user').catch(() => undefined);
        this.respond(run, bridge.rpcId, {
          contentItems: [{ type: 'inputText', text: JSON.stringify({ error: 'mcp_approval_cancelled' }) }],
          success: false,
        });
      } else {
        this.respond(run, bridge.rpcId, { decision: 'cancel' });
      }
      run.approvals.delete(approvalId);
      this.queue(run, { kind: 'approval_resolved', data: { id: approvalId, decision: 'cancelled' } });
    }
    const interrupt = this.request(run, 'turn/interrupt', { threadId: run.threadId, turnId: run.turnId })
      .catch((error) => this.queue(run, { kind: 'warning', data: {
        code: 'codex_interrupt_unconfirmed', message: safeMessage(error, 'Interrupt wurde nicht bestaetigt.'),
      } }));
    await Promise.race([
      interrupt,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.cancelGraceMs);
        timer.unref();
      }),
    ]);
    await run.process.cancel('Codex App Server Run abgebrochen.');
  }

  async resume(runId: string, input?: string): Promise<AgentRunHandle> {
    const previous = this.previous.get(runId);
    if (!previous) throw new Error(`Kein Codex App Server Thread fuer Run ${runId}.`);
    return this.launch(previous.context, previous.threadId, input);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((run) => run.process.cancel('Adapter wird beendet.')));
    await Promise.allSettled([...this.active.values()].map((run) => run.process.completion));
    this.active.clear();
  }
}

/** Selects App Server only when explicitly enabled; all pre-turn health failures fall back to codex exec. */
export class FeatureFlaggedCodexAgentAdapter implements AgentRunnerPort {
  readonly provider: string;
  private readonly selected = new Map<string, AgentRunnerPort>();

  constructor(
    private readonly appServer: CodexAppServerAgentAdapter,
    private readonly fallback: AgentRunnerPort,
    private readonly enabled: CodexAppServerFeatureDecision = process.env[CODEX_APP_SERVER_FEATURE_FLAG] === '1'
  ) {
    if (fallback.provider !== appServer.provider) throw new Error('Codex-Fallback muss dieselbe Provider-ID besitzen.');
    this.provider = fallback.provider;
  }

  discover(): Promise<AgentProviderInstallation[]> { return this.fallback.discover(); }

  private async isEnabled(): Promise<boolean> {
    return typeof this.enabled === 'function' ? Boolean(await this.enabled()) : this.enabled;
  }

  async capabilities(installation: AgentProviderInstallation): Promise<AgentCapabilities> {
    const enabled = await this.isEnabled();
    if (enabled && this.appServer.supports(installation) && this.appServer.hasVerifiedUserConfigIsolation()) {
      return this.appServer.capabilities(installation);
    }
    const capabilities = await this.fallback.capabilities(installation);
    return { ...capabilities, extensions: { ...capabilities.extensions,
      appServerRequested: enabled, appServerSelected: false,
      appServerFallbackReason: !enabled ? 'feature_flag_disabled'
        : !this.appServer.supports(installation) ? 'version_not_allowlisted' : 'user_config_isolation_unverified'
    } };
  }

  async start(context: ProviderRunContext): Promise<AgentRunHandle> {
    const enabled = await this.isEnabled();
    if (!enabled || !this.appServer.supports(context.installation)) {
      if (context.domainTools) throw new CodexAppServerHealthError('required_root_domain_tools_unavailable');
      if (enabled) await context.emit({ kind: 'warning', data: { code: 'codex_app_server_fallback', reason: 'version_not_allowlisted', fallback: this.fallback.provider } });
      this.selected.set(context.runId, this.fallback);
      return this.fallback.start(context);
    }
    try {
      const handle = await this.appServer.start(context);
      this.selected.set(context.runId, this.appServer);
      return handle;
    } catch (error) {
      if (!(error instanceof CodexAppServerHealthError)) throw error;
      // Capabilities advertise networkControl only for this App-Server
      // transport. Falling back after preflight would silently weaken the
      // promised offline boundary, so selected offline runs fail closed.
      if (context.request.network === 'disabled' || context.domainTools) throw error;
      await context.emit({ kind: 'warning', data: { code: 'codex_app_server_fallback', reason: safeMessage(error.message, 'healthcheck_failed'), fallback: this.fallback.provider } });
      this.selected.set(context.runId, this.fallback);
      return this.fallback.start(context);
    }
  }

  private delegate(runId: string): AgentRunnerPort {
    const selected = this.selected.get(runId);
    if (!selected) throw new Error(`Run ${runId} besitzt keinen ausgewaehlten Codex-Transport.`);
    return selected;
  }

  sendInput(runId: string, input: string): Promise<void> { return this.delegate(runId).sendInput(runId, input); }
  resolveApproval(runId: string, approvalId: string, decision: ApprovalDecision): Promise<void> { return this.delegate(runId).resolveApproval(runId, approvalId, decision); }
  cancel(runId: string, reason?: string): Promise<void> { return this.delegate(runId).cancel(runId, reason); }
  resume(runId: string, input?: string): Promise<AgentRunHandle> { return this.delegate(runId).resume(runId, input); }
  async dispose(): Promise<void> { await Promise.allSettled([this.appServer.dispose(), this.fallback.dispose()]); this.selected.clear(); }
}
