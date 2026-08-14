import { isAbsolute } from 'node:path';
import {
  AGENT_CONTRACT_VERSION,
  type AgentCapabilities,
  type AgentEventDraft,
  type AgentProviderInstallation,
  type AgentRunnerPort,
  type AgentRunHandle,
  type ApprovalDecision,
  type ProviderRunContext
} from '../ports/agent-runner.js';
import { IncrementalJsonlParser } from './jsonl-parser.js';
import { buildMinimalProviderEnvironment, type ProviderEnvironmentBuilder } from './generic-jsonl-adapter.js';
import { DEFAULT_PROCESS_LIMITS, ProcessSupervisor, type SupervisedProcess } from './process-supervisor.js';
import { assertTrustedHostJobMcpNotNestedInAgentSandbox } from './provider-sandbox.js';
import { AgentRuntimeDiscovery } from './runtime-discovery.js';

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
  testedVersionPatterns: ['^(?:codex-cli|codex)\\s+0\\.147\\.'],
  commandArgs: ['app-server', '--listen', 'stdio://'],
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

interface ApprovalBridge {
  rpcId: RpcId;
  method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval';
}

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
}

export interface CodexAppServerOptions {
  requestTimeoutMs?: number;
  environmentBuilder?: ProviderEnvironmentBuilder;
  /** Conformance-only hook; production falls back until user config can be ignored. */
  userConfigIsolationVerified?: boolean;
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

function versionSupported(version: string | undefined): boolean {
  return version !== undefined && CODEX_APP_SERVER_MANIFEST.testedVersionPatterns.some((pattern) => new RegExp(pattern, 'i').test(version));
}

function sandboxPolicy(context: ProviderRunContext, workspaceRoot: string): JsonObject {
  if (context.request.sandbox === 'danger-full-access') throw new Error('Codex App Server erlaubt in dieser Integration keine danger-full-access Sandbox.');
  if (context.request.network !== 'disabled') throw new Error('Codex App Server ist in dieser Integration ausschliesslich offline freigegeben.');
  return context.request.sandbox === 'workspace-write'
    ? { type: 'workspaceWrite', writableRoots: [workspaceRoot], networkAccess: false }
    : { type: 'readOnly', access: { type: 'fullAccess' } };
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
  private readonly environmentBuilder: ProviderEnvironmentBuilder;
  private readonly userConfigIsolationVerified: boolean;

  constructor(
    private readonly supervisor: Pick<ProcessSupervisor, 'start'> = new ProcessSupervisor(),
    private readonly discovery = new AgentRuntimeDiscovery(),
    options: CodexAppServerOptions = {}
  ) {
    this.timeoutMs = options.requestTimeoutMs ?? 5_000;
    this.environmentBuilder = options.environmentBuilder ?? buildMinimalProviderEnvironment;
    this.userConfigIsolationVerified = options.userConfigIsolationVerified === true;
  }

  supports(installation: AgentProviderInstallation): boolean {
    return installation.provider === this.provider && installation.support === 'supported' && versionSupported(installation.version);
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
    return {
      schemaVersion: AGENT_CONTRACT_VERSION, provider: this.provider, providerVersion: installation.version,
      adapterVersion: CODEX_APP_SERVER_MANIFEST.adapterVersion, protocolVersion: CODEX_APP_SERVER_MANIFEST.protocol,
      streaming: true, resume: true, interactiveInput: true, approvals: true, tools: true, images: true,
      structuredOutput: true, sandboxPolicies: ['read-only', 'workspace-write'], usage: true,
      supportedRuntimeTargets: ['windows', 'wsl', 'linux', 'darwin'],
      extensions: { maturity: 'experimental', transport: 'stdio', networkControl: false, featureFlag: CODEX_APP_SERVER_FEATURE_FLAG }
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

  private serverRequest(run: AppServerRun, message: JsonObject, method: string, id: RpcId): void {
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
    run.approvals.set(approvalId, { rpcId: id, method });
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
    if (context.installation.runtimeTarget === 'wsl') {
      if (!context.installation.distribution || !context.installation.runtimeExecutable) throw new CodexAppServerHealthError('WSL-Installation ist unvollstaendig.');
      workspace = await this.discovery.windowsPathToWsl(context.request.workspaceRoot, context.installation.distribution, context.installation.executable);
      args = ['-d', context.installation.distribution, '--', context.installation.runtimeExecutable, ...args];
    }
    const policy = sandboxPolicy(context, workspace);
    if (args.some((argument) => /^(?:ws|wss|unix):\/\//i.test(argument))) throw new Error('Codex App Server Listenertransport ist nicht erlaubt.');

    let run!: AppServerRun;
    const parser = new IncrementalJsonlParser();
    const processHandle = this.supervisor.start({
      executable: context.installation.executable, args, cwd: context.request.workspaceRoot,
      env: this.environmentBuilder(this.provider, context.installation), limits: { ...DEFAULT_PROCESS_LIMITS, ...context.request.limits }
    }, {
      onStart: (pid) => this.queue(run, { kind: 'process_started', data: { pid, runtimeTarget: context.installation.runtimeTarget, transport: 'stdio' } }),
      onStdout: (chunk) => {
        const batch = parser.feed(chunk);
        for (const value of batch.values) this.consume(run, value);
        if (batch.diagnostics.length) this.protocolFailure(run, new CodexAppServerProtocolError(`Ungueltiges JSONL: ${batch.diagnostics[0]?.code}`));
      },
      onStderr: (chunk) => this.queue(run, { kind: 'warning', data: { code: 'provider_stderr', message: safeMessage(chunk, 'Codex stderr') } }),
      onHeartbeat: () => this.queue(run, { kind: 'heartbeat', data: { transport: 'stdio' } })
    });
    run = { context, process: processHandle, parser, pending: new Map(), approvals: new Map(), emitQueue: Promise.resolve(), nextRpcId: 1 };
    this.active.set(context.runId, run);

    try {
      const initialized = object(await this.request(run, 'initialize', {
        clientInfo: { name: 'job_match_and_apply', title: 'Job Match and Apply', version: CODEX_APP_SERVER_MANIFEST.adapterVersion }
      }));
      if (!initialized) throw new CodexAppServerHealthError('Initialize-Healthcheck lieferte kein Objekt.');
      await this.write(run, { method: 'initialized', params: {} });
      const threadResult = object(await this.request(run, resumeThreadId ? 'thread/resume' : 'thread/start', resumeThreadId
        ? { threadId: resumeThreadId, cwd: workspace, approvalPolicy: approvalPolicy(context), sandbox: context.request.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly' }
        : { cwd: workspace, approvalPolicy: approvalPolicy(context), sandbox: context.request.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly', serviceName: 'job_match_and_apply', ...(context.request.model ? { model: context.request.model } : {}) }));
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
      if (run.protocolFailure) return { state: 'failed' as const, failure: { code: 'codex_app_server_protocol_error', message: run.protocolFailure.message, retryable: false } };
      if (run.terminal) return run.terminal;
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
    const mapped = decision === 'approved' ? 'accept' : decision === 'cancelled' || decision === 'expired' ? 'cancel' : 'decline';
    this.respond(run, bridge.rpcId, { decision: mapped });
    run.approvals.delete(approvalId);
    this.queue(run, { kind: 'approval_resolved', data: { id: approvalId, decision } });
  }

  async cancel(runId: string): Promise<void> {
    const run = this.active.get(runId);
    if (!run?.threadId || !run.turnId) throw new Error(`Codex App Server Run ${runId} ist nicht aktiv.`);
    await this.request(run, 'turn/interrupt', { threadId: run.threadId, turnId: run.turnId });
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
    private readonly enabled = process.env[CODEX_APP_SERVER_FEATURE_FLAG] === '1'
  ) {
    if (fallback.provider !== appServer.provider) throw new Error('Codex-Fallback muss dieselbe Provider-ID besitzen.');
    this.provider = fallback.provider;
  }

  discover(): Promise<AgentProviderInstallation[]> { return this.fallback.discover(); }

  async capabilities(installation: AgentProviderInstallation): Promise<AgentCapabilities> {
    if (this.enabled && this.appServer.supports(installation) && this.appServer.hasVerifiedUserConfigIsolation()) {
      return this.appServer.capabilities(installation);
    }
    const capabilities = await this.fallback.capabilities(installation);
    return { ...capabilities, extensions: { ...capabilities.extensions,
      appServerRequested: this.enabled, appServerSelected: false,
      appServerFallbackReason: !this.enabled ? 'feature_flag_disabled'
        : !this.appServer.supports(installation) ? 'version_not_allowlisted' : 'user_config_isolation_unverified'
    } };
  }

  async start(context: ProviderRunContext): Promise<AgentRunHandle> {
    if (!this.enabled || !this.appServer.supports(context.installation)) {
      if (this.enabled) await context.emit({ kind: 'warning', data: { code: 'codex_app_server_fallback', reason: 'version_not_allowlisted', fallback: this.fallback.provider } });
      this.selected.set(context.runId, this.fallback);
      return this.fallback.start(context);
    }
    try {
      const handle = await this.appServer.start(context);
      this.selected.set(context.runId, this.appServer);
      return handle;
    } catch (error) {
      if (!(error instanceof CodexAppServerHealthError)) throw error;
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
