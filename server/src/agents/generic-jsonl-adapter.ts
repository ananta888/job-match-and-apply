import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  AGENT_CONTRACT_VERSION,
  assertCompatibleAgentContract,
  type AgentCapabilities,
  type AgentEventDraft,
  type AgentProviderInstallation,
  type AgentRunnerPort,
  type AgentRunHandle,
  type ApprovalDecision,
  type ProviderRunContext,
  type SandboxPolicy
} from '../ports/agent-runner.js';
import { IncrementalJsonlParser, type JsonlBatch } from './jsonl-parser.js';
import { DEFAULT_PROCESS_LIMITS, ProcessSupervisor, type ProcessResult, type SupervisedProcess } from './process-supervisor.js';
import { assertTrustedHostJobMcpNotNestedInAgentSandbox, WslBubblewrapSandboxBoundary, type ExternalSandboxBoundary } from './provider-sandbox.js';
import { recoverOpencodeAssistantText } from './opencode-session-recover.js';
import { AgentRuntimeDiscovery, type ProviderDiscoveryDefinition } from './runtime-discovery.js';
import {
  CODEX_OFFLINE_NETWORK_CONTRACT,
  CODEX_SANDBOX_ENFORCEMENT_ID,
  hasFixedCodexOfflineConfig,
  isConformedCodexVersion,
} from './codex-offline-policy.js';

export interface AgentAdapterManifest {
  schemaVersion: string;
  id: string;
  displayName: string;
  adapterVersion: string;
  protocol: 'canonical-jsonl' | 'codex-jsonl' | 'opencode-json' | 'claude-stream-json';
  trust: 'builtin' | 'local';
  enabled: boolean;
  executableNames: readonly string[];
  versionArgs: readonly string[];
  testedVersionPatterns: readonly string[];
  command: {
    args: readonly string[];
    promptTransport: 'stdin' | 'argument';
    modelArgs?: readonly string[];
    profileArgs?: readonly string[];
  };
  capabilities: Omit<AgentCapabilities, 'schemaVersion' | 'provider' | 'providerVersion' | 'adapterVersion'>;
  maxJsonLineBytes?: number;
}

export type ProviderEventMapper = (
  value: unknown,
  context?: { request: Pick<ProviderRunContext['request'], 'approvalMode' | 'metadata'> },
) => AgentEventDraft[];
export type ProviderEnvironmentBuilder = (provider: string, installation: AgentProviderInstallation) => NodeJS.ProcessEnv;

/** Browser/run input may tighten these ceilings, but can never raise them. */
export const PROVIDER_RESOURCE_CEILINGS = {
  maxResidentMemoryBytes: 8 * 1024 * 1024 * 1024,
  maxChildProcesses: 64,
} as const;

const SAFE_ENVIRONMENT_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'LANG', 'LC_ALL'
] as const;

/** Child processes receive only operating-system basics unless a composition root injects more. */
export const buildMinimalProviderEnvironment: ProviderEnvironmentBuilder = () => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) if (process.env[key] !== undefined) environment[key] = process.env[key];
  return environment;
};

function canonicalManifest(value: AgentAdapterManifest): string {
  const sort = (input: unknown): unknown => Array.isArray(input) ? input.map(sort) : input && typeof input === 'object'
    ? Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sort(item)]))
    : input;
  return JSON.stringify(sort(value));
}

export function agentManifestFingerprint(manifest: AgentAdapterManifest): string {
  return createHash('sha256').update(canonicalManifest(manifest)).digest('hex');
}

export function validateAgentManifest(manifest: AgentAdapterManifest, trustedFingerprints: ReadonlySet<string> = new Set()): void {
  assertCompatibleAgentContract(manifest.schemaVersion);
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(manifest.id)) throw new Error('Adapter-ID ist ungültig.');
  if (!manifest.enabled) throw new Error(`Adapter ${manifest.id} ist deaktiviert.`);
  if (manifest.command.args.some((argument) => argument.includes('\0'))) throw new Error('Adapterargument enthält ein NUL-Zeichen.');
  if (manifest.trust !== 'builtin' && !trustedFingerprints.has(agentManifestFingerprint(manifest))) {
    throw new Error(`Lokales Adaptermanifest ${manifest.id} wurde nicht explizit freigegeben.`);
  }
  const placeholders = [...manifest.command.args, ...(manifest.command.modelArgs ?? []), ...(manifest.command.profileArgs ?? [])]
    .flatMap((argument) => [...argument.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]));
  const allowed = new Set(['workspace', 'sandbox', 'model', 'profile', 'prompt']);
  const unknown = placeholders.find((placeholder) => !allowed.has(placeholder ?? ''));
  if (unknown) throw new Error(`Unbekannter Manifest-Platzhalter: ${unknown}`);
  if (manifest.command.promptTransport === 'argument' && !manifest.command.args.includes('{prompt}')) {
    throw new Error('Argument-Prompttransport benötigt genau den Platzhalter {prompt}.');
  }
  if (manifest.command.promptTransport === 'stdin' && manifest.command.args.includes('{prompt}')) {
    throw new Error('Stdin-Prompt darf nicht gleichzeitig in der Prozessliste erscheinen.');
  }
}

function replaceArgument(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_whole, key: string) => values[key] ?? '');
}

/**
 * Applies the exact-version, server-owned zero-tool contract used for private
 * CV source data. Generic browser/API callers cannot set request metadata.
 */
export function applyServerOwnedProviderToolMode(
  provider: string,
  args: readonly string[],
  request: Pick<ProviderRunContext['request'], 'approvalMode' | 'metadata'>,
): string[] {
  const mode = request.metadata?.providerToolMode;
  if (mode === undefined) return [...args];
  if (mode !== 'none' || request.metadata?.workflowId !== 'cv-ai-structuring'
    || request.approvalMode !== 'deny'
    || !Array.isArray(request.metadata?.requiredRootMcpTools)
    || request.metadata.requiredRootMcpTools.length !== 0) {
    throw new Error('server_owned_provider_tool_mode_invalid');
  }
  const result = [...args];
  const replaceValue = (flag: string, expected: string, replacement: string): void => {
    const index = result.indexOf(flag);
    if (index < 0 || result[index + 1] !== expected) throw new Error('provider_zero_tools_argv_contract_invalid');
    result[index + 1] = replacement;
  };
  if (provider === 'opencode') {
    replaceValue('--agent', 'job-match-read-only', 'job-match-no-tools');
    return result;
  }
  if (provider === 'claude-cli') {
    replaceValue('--tools', 'Read', '');
    replaceValue('--disallowedTools', 'mcp__*', '*');
    return result;
  }
  if (provider === 'codex-exec') {
    // Codex offers no tool-removal flag. Its zero-tools contract for the
    // private CV workflow is the containment already encoded in the argv:
    // a read-only sandbox (no writes), the fixed offline config (no user
    // tools/MCP, network off), attested at process start, backed by
    // server-side quarantine of any observed tool activity. Assert that
    // containment is present and leave the argv unchanged (fail closed).
    const sandboxIndex = result.indexOf('--sandbox');
    if (sandboxIndex < 0 || result[sandboxIndex + 1] !== 'read-only'
      || !result.includes('--ignore-user-config')
      || !hasFixedCodexOfflineConfig(result)) {
      throw new Error('provider_zero_tools_argv_contract_invalid');
    }
    return result;
  }
  throw new Error('provider_zero_tools_not_supported');
}

function redactProgress(value: string): string {
  return value
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .slice(0, 8_192);
}

function canonicalMapper(value: unknown): AgentEventDraft[] {
  if (!value || typeof value !== 'object') return [{ kind: 'warning', data: { code: 'invalid_provider_event_shape' } }];
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== 'string' || !record.data || typeof record.data !== 'object') {
    return [{ kind: 'warning', data: { code: 'unknown_provider_event', providerEventType: String(record.type ?? 'unknown') } }];
  }
  return [{
    kind: record.kind,
    data: record.data as Readonly<Record<string, unknown>>,
    ...(typeof record.timestamp === 'string' ? { timestamp: record.timestamp } : {}),
    ...(typeof record.correlationId === 'string' ? { correlationId: record.correlationId } : {})
  }];
}

export class GenericJsonlAgentAdapter implements AgentRunnerPort {
  readonly provider: string;
  private readonly active = new Map<string, SupervisedProcess>();
  private readonly contexts = new Map<string, ProviderRunContext>();

  constructor(
    readonly manifest: AgentAdapterManifest,
    private readonly supervisor: Pick<ProcessSupervisor, 'start'> = new ProcessSupervisor(),
    private readonly discovery = new AgentRuntimeDiscovery(),
    private readonly mapper: ProviderEventMapper = canonicalMapper,
    trustedFingerprints: ReadonlySet<string> = new Set(),
    private readonly allowUntestedVersions = false,
    private readonly environmentBuilder: ProviderEnvironmentBuilder = buildMinimalProviderEnvironment,
    private readonly externalSandbox: ExternalSandboxBoundary = new WslBubblewrapSandboxBoundary()
  ) {
    validateAgentManifest(manifest, trustedFingerprints);
    this.provider = manifest.id;
  }

  private discoveryDefinition(): ProviderDiscoveryDefinition {
    return {
      provider: this.provider, executableNames: this.manifest.executableNames,
      versionArgs: this.manifest.versionArgs,
      testedVersionPatterns: this.manifest.testedVersionPatterns.map((pattern) => new RegExp(pattern, 'i')),
      ...(this.provider === 'codex-exec' ? { authStatusArgs: ['login', 'status'] } : {})
    };
  }

  async discover(): Promise<AgentProviderInstallation[]> {
    const local = await this.discovery.discoverLocal(this.discoveryDefinition());
    const wsl = process.platform === 'win32' ? await this.discovery.discoverWsl(this.discoveryDefinition()) : [];
    return [...local, ...wsl];
  }

  async capabilities(installation: AgentProviderInstallation): Promise<AgentCapabilities> {
    if (installation.provider !== this.provider) throw new Error('Installation gehört zu einem anderen Provider.');
    const manifestCapabilities = structuredClone(this.manifest.capabilities);
    if (this.provider === 'codex-exec') {
      const offlineControlVerified = installation.support === 'supported'
        && isConformedCodexVersion(installation.version)
        && hasFixedCodexOfflineConfig(this.manifest.command.args);
      manifestCapabilities.extensions = {
        ...manifestCapabilities.extensions,
        networkControl: offlineControlVerified,
        networkControlProof: offlineControlVerified
          ? 'exact-version-and-fixed-argv'
          : 'unavailable-for-installation',
      };
    }
    return {
      ...manifestCapabilities, schemaVersion: AGENT_CONTRACT_VERSION,
      provider: this.provider, providerVersion: installation.version, adapterVersion: this.manifest.adapterVersion
    };
  }

  private async launch(context: ProviderRunContext, overrideArgs?: readonly string[]): Promise<AgentRunHandle> {
    const { installation, request } = context;
    if (installation.provider !== this.provider) throw new Error('Installation gehört zu einem anderen Provider.');
    if (request.provider !== this.provider) throw new Error('Run-Anfrage gehört zu einem anderen Provider.');
    if (installation.support === 'unsupported' || installation.support === 'unavailable') throw new Error(installation.reason ?? 'Providerinstallation ist nicht nutzbar.');
    const version = installation.version;
    const exactVersionSupported = version !== undefined && version === version.trim() && !/[\r\n\0]/.test(version)
      && this.manifest.testedVersionPatterns.some((pattern) => new RegExp(pattern, 'i').test(version));
    if (!this.allowUntestedVersions && (installation.support === 'untested' || !exactVersionSupported)) {
      throw new Error('Provider-Version ist nicht durch Contract-Fixtures freigegeben.');
    }
    if (!isAbsolute(request.workspaceRoot)) throw new Error('Workspace muss vor dem Providerstart absolut validiert sein.');
    if (typeof request.task !== 'string' || !request.task.trim() || request.task.includes('\0')) throw new Error('Agentenaufgabe ist leer oder ungültig.');
    const promptBytes = Buffer.byteLength(request.task);
    const maximumPromptBytes = this.manifest.command.promptTransport === 'argument' ? 16 * 1024 : (request.limits?.maxInputBytes ?? DEFAULT_PROCESS_LIMITS.maxInputBytes);
    if (promptBytes > maximumPromptBytes) throw new Error(`Agentenaufgabe überschreitet das sichere Promptlimit von ${maximumPromptBytes} Byte.`);
    if (this.manifest.command.promptTransport === 'argument' && request.task.startsWith('-')) {
      throw new Error('Ein argumentbasierter Prompt darf nicht mit einem Optionspräfix beginnen.');
    }
    if (request.model !== undefined && (typeof request.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(request.model))) {
      throw new Error('Modell enthält unzulässige Zeichen.');
    }
    if (request.profile !== undefined && (typeof request.profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(request.profile))) {
      throw new Error('Profil enthält unzulässige Zeichen.');
    }
    const capabilities = await this.capabilities(installation);
    if (request.runtimeTarget !== installation.runtimeTarget) throw new Error('Run- und Installations-Runtime stimmen nicht überein.');
    if (!capabilities.supportedRuntimeTargets.includes(installation.runtimeTarget)) {
      throw new Error(`Runtime ${installation.runtimeTarget} wird von ${this.provider} nicht angeboten.`);
    }
    if (!capabilities.sandboxPolicies.includes(request.sandbox)) throw new Error(`Sandbox ${request.sandbox} wird von ${this.provider} nicht angeboten.`);
    const supportedNetworkModes = capabilities.extensions?.supportedNetworkModes;
    if (Array.isArray(supportedNetworkModes) && !supportedNetworkModes.includes(request.network)) {
      throw new Error(`Netzwerkmodus ${request.network} ist fuer ${this.provider} nicht freigegeben.`);
    }
    if ((this.provider === 'codex-exec' || request.network !== 'disabled')
      && capabilities.extensions?.networkControl !== true) {
      throw new Error(`Netzwerkmodus ${request.network} kann von ${this.provider} nicht sicher erzwungen werden.`);
    }
    if (request.approvalMode === 'explicit' && !capabilities.approvals) throw new Error(`${this.provider} besitzt keine interaktive Approval-Brücke.`);

    if (this.provider === 'codex-exec' && request.profile !== undefined) throw new Error('codex_profile_layers_are_forbidden_in_agent_center');

    // Codex also loads project-scoped MCP configuration, so this guard applies
    // before every provider spawn rather than only inside the WSL sandbox path.
    await assertTrustedHostJobMcpNotNestedInAgentSandbox(request.workspaceRoot);

    let workspace = request.workspaceRoot;
    if (installation.runtimeTarget === 'wsl') {
      if (!installation.distribution || !installation.runtimeExecutable) throw new Error('WSL-Installation ist unvollständig.');
      workspace = await this.discovery.windowsPathToWsl(request.workspaceRoot, installation.distribution, installation.executable);
    }
    const values = { workspace, sandbox: request.sandbox, model: request.model ?? '', profile: request.profile ?? '', prompt: request.task };
    let args = (overrideArgs ?? this.manifest.command.args).map((argument) => replaceArgument(argument, values));
    args = applyServerOwnedProviderToolMode(this.provider, args, request);
    if (request.model && this.manifest.command.modelArgs) args.push(...this.manifest.command.modelArgs.map((argument) => replaceArgument(argument, values)));
    if (request.profile && this.manifest.command.profileArgs) args.push(...this.manifest.command.profileArgs.map((argument) => replaceArgument(argument, values)));
    let executable = installation.executable;
    let sandboxEnforcement: string | undefined;
    let networkEnforcement: string | undefined;
    let networkMechanism: string | undefined;
    let networkAccessClaim: string | undefined;
    let recoverableHost: string | undefined;
    if (this.manifest.capabilities.extensions?.externalSandbox === 'wsl-bubblewrap-v1') {
      if (this.provider === 'opencode') {
        recoverableHost = join(request.workspaceRoot, '.oc-session');
        await mkdir(recoverableHost, { recursive: true, mode: 0o700 });
      }
      const recoverableStateRoot = recoverableHost && installation.distribution
        ? await this.discovery.windowsPathToWsl(recoverableHost, installation.distribution, installation.executable)
        : undefined;
      const plan = await this.externalSandbox.plan({
        provider: this.provider as 'opencode' | 'claude-cli',
        installation,
        providerExecutable: installation.runtimeExecutable ?? '',
        providerArgs: args,
        workspaceRoot: workspace,
        sandbox: request.sandbox,
        network: request.network,
        ...(recoverableStateRoot ? { recoverableStateRoot } : {}),
      });
      executable = plan.executable;
      args = plan.args;
      sandboxEnforcement = plan.enforcedBy;
      networkEnforcement = plan.networkEnforcement;
      networkMechanism = plan.networkMechanism;
      networkAccessClaim = plan.networkAccessClaim;
    } else if (installation.runtimeTarget === 'wsl') {
      args = ['-d', installation.distribution!, '--', installation.runtimeExecutable!, ...args];
    }
    if (this.provider === 'codex-exec') {
      sandboxEnforcement = CODEX_SANDBOX_ENFORCEMENT_ID;
      networkEnforcement = CODEX_OFFLINE_NETWORK_CONTRACT.networkEnforcement;
      networkMechanism = CODEX_OFFLINE_NETWORK_CONTRACT.networkMechanism;
      networkAccessClaim = CODEX_OFFLINE_NETWORK_CONTRACT.networkAccessClaim;
    }

    const parser = new IncrementalJsonlParser(this.manifest.maxJsonLineBytes);
    let emitQueue = Promise.resolve();
    let providerReportedError = false;
    let sawCompletedMessage = false;
    const queue = (draft: AgentEventDraft): void => {
      if (draft.kind === 'error') providerReportedError = true;
      if (draft.kind === 'agent_message_completed') sawCompletedMessage = true;
      emitQueue = emitQueue.then(() => context.emit(draft));
    };
    const consume = (batch: JsonlBatch): void => {
      for (const value of batch.values) {
        const providerEventId = value && typeof value === 'object' && !Array.isArray(value)
          ? [Reflect.get(value, 'eventId'), Reflect.get(value, 'event_id')]
            .find((candidate): candidate is string => typeof candidate === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,180}$/.test(candidate))
          : undefined;
        const drafts = this.mapper(value, context);
        drafts.forEach((draft, index) => queue(providerEventId
          ? { ...draft, providerEventId: `${providerEventId}:${index}` }
          : draft));
      }
      for (const diagnostic of batch.diagnostics) queue({ kind: 'warning', data: { code: `jsonl_${diagnostic.code}`, line: diagnostic.line, message: diagnostic.message } });
    };
    const processHandle = this.supervisor.start({
      executable, args, cwd: request.workspaceRoot,
      env: this.environmentBuilder(this.provider, installation),
      stdin: this.manifest.command.promptTransport === 'stdin' ? request.task : undefined,
      limits: {
        ...DEFAULT_PROCESS_LIMITS,
        ...request.limits,
        maxResidentMemoryBytes: Math.min(
          request.limits?.maxResidentMemoryBytes ?? PROVIDER_RESOURCE_CEILINGS.maxResidentMemoryBytes,
          PROVIDER_RESOURCE_CEILINGS.maxResidentMemoryBytes,
        ),
        maxChildProcesses: Math.min(
          request.limits?.maxChildProcesses ?? PROVIDER_RESOURCE_CEILINGS.maxChildProcesses,
          PROVIDER_RESOURCE_CEILINGS.maxChildProcesses,
        ),
      }
    }, {
      onStart: (pid) => queue({ kind: 'process_started', data: {
        pid, runtimeTarget: installation.runtimeTarget,
        ...(sandboxEnforcement ? { sandboxEnforcement, networkEnforcement, networkMechanism, networkAccessClaim } : {})
      } }),
      onStdout: (chunk) => consume(parser.feed(chunk)),
      onStderr: (chunk) => queue({ kind: 'warning', data: { code: 'provider_stderr', message: redactProgress(chunk) } }),
      onHeartbeat: () => queue({ kind: 'heartbeat', data: {} })
    });
    this.active.set(context.runId, processHandle);
    this.contexts.set(context.runId, context);

    const completion = (async () => {
      try {
        const result = await processHandle.completion;
        consume(parser.end());
        if (recoverableHost && !sawCompletedMessage) {
          const recovered = await recoverOpencodeAssistantText(recoverableHost);
          if (recovered) queue({ kind: 'agent_message_completed', data: { text: recovered, recoveredFrom: 'opencode-session-store' } });
        }
        if (recoverableHost) await rm(recoverableHost, { recursive: true, force: true }).catch(() => undefined);
        const outcome = providerReportedError && result.termination === 'exit' && result.exitCode === 0
          ? { state: 'failed' as const, failure: { code: 'provider_reported_error', message: 'Provider meldete einen strukturierten Fehler.', retryable: false } }
          : this.outcome(result);
        if (outcome.failure) queue({ kind: 'error', data: { code: outcome.failure.code, message: outcome.failure.message, retryable: outcome.failure.retryable } });
        queue({ kind: 'run_completed', data: {
          state: outcome.state, exitCode: result.exitCode, termination: result.termination,
          ...(outcome.failure ? { failure: outcome.failure } : {}),
        } });
        await emitQueue;
        return outcome;
      } finally {
        if (recoverableHost) await rm(recoverableHost, { recursive: true, force: true }).catch(() => undefined);
        this.active.delete(context.runId);
        this.contexts.delete(context.runId);
      }
    })();
    return { runId: context.runId, completion };
  }

  private outcome(result: ProcessResult): Awaited<AgentRunHandle['completion']> {
    if (result.termination === 'cancelled') return { state: 'cancelled' };
    if (result.termination === 'timeout' || result.termination === 'idle_timeout') {
      return { state: 'timed_out', failure: { code: result.termination, message: result.error ?? 'Zeitlimit überschritten.', retryable: true } };
    }
    if (result.termination === 'exit' && result.exitCode === 0) return { state: 'succeeded' };
    return { state: 'failed', failure: { code: result.termination, message: result.error ?? `Providerprozess endete mit Code ${String(result.exitCode)}.`, retryable: result.termination !== 'output_limit' } };
  }

  async start(context: ProviderRunContext): Promise<AgentRunHandle> {
    if (this.active.has(context.runId)) throw new Error(`Run ${context.runId} läuft bereits.`);
    return this.launch(context);
  }

  async sendInput(runId: string, input: string): Promise<void> {
    if (!this.manifest.capabilities.interactiveInput) throw new Error(`${this.provider} unterstützt keine laufende Eingabe.`);
    const processHandle = this.active.get(runId);
    if (!processHandle) throw new Error(`Run ${runId} ist nicht aktiv.`);
    await processHandle.writeInput(input);
  }

  async resolveApproval(_runId: string, _approvalId: string, _decision: ApprovalDecision): Promise<void> {
    throw new Error(`${this.provider} besitzt keine implementierte Approval-Brücke.`);
  }

  async cancel(runId: string, reason?: string): Promise<void> {
    const processHandle = this.active.get(runId);
    if (!processHandle) throw new Error(`Run ${runId} ist nicht aktiv.`);
    await processHandle.cancel(reason);
  }

  async resume(runId: string, _input?: string): Promise<AgentRunHandle> {
    const context = this.contexts.get(runId);
    if (!context || !this.manifest.capabilities.resume) throw new Error(`${this.provider} kann Run ${runId} nicht wiederaufnehmen.`);
    throw new Error('Provider-Resume benötigt einen providerspezifischen, versionierten Adapter.');
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((handle) => handle.cancel('Agentadapter wird beendet.')));
    await Promise.allSettled([...this.active.values()].map((handle) => handle.completion));
    this.active.clear();
    this.contexts.clear();
  }
}
