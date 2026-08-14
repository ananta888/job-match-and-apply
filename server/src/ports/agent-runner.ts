export const AGENT_CONTRACT_VERSION = '1.0' as const;

export type AgentRunState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'cancelling'
  | 'cancelled'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'orphaned'
  | 'recovering';

export type KnownAgentEventKind =
  | 'run_created'
  | 'capabilities_negotiated'
  | 'process_started'
  | 'agent_message_delta'
  | 'agent_message_completed'
  | 'tool_requested'
  | 'tool_started'
  | 'tool_output'
  | 'tool_completed'
  | 'approval_requested'
  | 'approval_resolved'
  | 'user_input_requested'
  | 'user_input_received'
  | 'artifact_created'
  | 'usage_updated'
  | 'warning'
  | 'error'
  | 'heartbeat'
  | 'run_completed';

/** Unknown provider events stay representable for forward-compatible clients. */
export type AgentEventKind = KnownAgentEventKind | (string & {});
export type RuntimeTarget = 'windows' | 'wsl' | 'linux' | 'darwin' | 'container';
export type SandboxPolicy = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalDecision = 'approved' | 'denied' | 'cancelled' | 'expired';

export interface AgentCapabilities {
  schemaVersion: string;
  provider: string;
  providerVersion?: string;
  adapterVersion: string;
  protocolVersion?: string;
  streaming: boolean;
  resume: boolean;
  interactiveInput: boolean;
  approvals: boolean;
  tools: boolean;
  images: boolean;
  structuredOutput: boolean;
  sandboxPolicies: SandboxPolicy[];
  usage: boolean;
  supportedRuntimeTargets: RuntimeTarget[];
  /** Forward-compatible provider features; consumers must ignore unknown keys. */
  extensions?: Readonly<Record<string, unknown>>;
}

export interface AgentProviderInstallation {
  provider: string;
  runtimeTarget: RuntimeTarget;
  executable: string;
  /** Executable inside the target runtime (for example an absolute WSL path). */
  runtimeExecutable?: string;
  distribution?: string;
  version?: string;
  support: 'supported' | 'untested' | 'unsupported' | 'unavailable';
  authStatus?: 'authenticated' | 'unauthenticated' | 'unknown' | 'not_required';
  authNote?: string;
  reason?: string;
  capabilities?: AgentCapabilities;
}

export interface AgentRunLimits {
  wallTimeMs: number;
  idleTimeMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  totalOutputBytes: number;
  maxInputBytes: number;
  /** Optional tightening of the server-owned provider memory ceiling. */
  maxResidentMemoryBytes: number;
  /** Optional tightening of the server-owned provider descendant ceiling. */
  maxChildProcesses: number;
}

export interface AgentRunRequest {
  provider: string;
  task: string;
  workspaceRoot: string;
  runtimeTarget: RuntimeTarget;
  wslDistribution?: string;
  sandbox: SandboxPolicy;
  network: 'disabled' | 'restricted' | 'enabled';
  approvalMode: 'deny' | 'explicit';
  model?: string;
  profile?: string;
  applicationCaseId?: string;
  companyKey?: string;
  priority?: number;
  limits?: Partial<AgentRunLimits>;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentRunFailure {
  code: string;
  message: string;
  retryable: boolean;
  details?: Readonly<Record<string, unknown>>;
}

export interface AgentRun {
  schemaVersion: typeof AGENT_CONTRACT_VERSION;
  id: string;
  provider: string;
  state: AgentRunState;
  request: AgentRunRequest;
  capabilities?: AgentCapabilities;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  currentSequence: number;
  queuePosition?: number;
  pid?: number;
  providerSessionId?: string;
  failure?: AgentRunFailure;
}

export interface ToolInvocation {
  id: string;
  name: string;
  status: 'requested' | 'running' | 'completed' | 'failed' | 'cancelled';
  risk: 'read' | 'propose' | 'confirm' | 'execute';
  input?: unknown;
  output?: unknown;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolInvocationId?: string;
  title: string;
  explanation: string;
  risk: 'read' | 'propose' | 'confirm' | 'execute';
  scope: Readonly<Record<string, unknown>>;
  requestedAt: string;
  expiresAt: string;
}

export interface UsageSnapshot {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  estimatedCost?: { amount: number; currency: string; estimated: true };
}

export interface ArtifactReference {
  id: string;
  kind: string;
  relativePath?: string;
  sha256?: string;
  bytes?: number;
  mediaType?: string;
}

export interface AgentEvent<T = Readonly<Record<string, unknown>>> {
  schemaVersion: typeof AGENT_CONTRACT_VERSION;
  runId: string;
  sequence: number;
  timestamp: string;
  provider: string;
  correlationId: string;
  /** Stable opaque identifier supplied by a provider, when its protocol has one. */
  providerEventId?: string;
  kind: AgentEventKind;
  data: T;
}

export type AgentEventDraft<T = Readonly<Record<string, unknown>>> = Omit<
  AgentEvent<T>,
  'schemaVersion' | 'runId' | 'sequence' | 'timestamp' | 'provider' | 'correlationId'
> & {
  timestamp?: string;
  correlationId?: string;
};

/**
 * Server-owned domain tools exposed to a provider transport. The bridge is a
 * runtime-only closure: it is never serialized into AgentRunRequest or the run
 * store, and it never contains a bearer capability value.
 */
export interface ProviderDomainToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  requiresApproval: boolean;
  risk: 'read' | 'local_write' | 'sensitive_read' | 'network' | 'external_write' | 'destructive';
}

export interface ProviderDomainToolResult {
  data: unknown;
  sourceReferences: readonly string[];
}

export interface ProviderDomainToolApproval {
  id: string;
  title: string;
  explanation: string;
  risk: ProviderDomainToolDescriptor['risk'];
  requestedAt: string;
  expiresAt: string;
}

export interface ProviderDomainToolBridge {
  readonly namespace: 'job_match_apply';
  listTools(): readonly ProviderDomainToolDescriptor[];
  execute(name: string, args: Readonly<Record<string, unknown>>): Promise<ProviderDomainToolResult>;
  requestApproval(name: string, args: Readonly<Record<string, unknown>>): Promise<ProviderDomainToolApproval>;
  resolveApproval(requestId: string, decision: 'approve' | 'deny', actor: string): Promise<void>;
  revoke(): Promise<void>;
}

export interface ProviderRunContext {
  runId: string;
  request: AgentRunRequest;
  installation: AgentProviderInstallation;
  emit(event: AgentEventDraft): Promise<void>;
  /** Present only for an exact-version provider transport that negotiated it. */
  domainTools?: ProviderDomainToolBridge;
}

export interface AgentRunHandle {
  readonly runId: string;
  readonly completion: Promise<{ state: Extract<AgentRunState, 'succeeded' | 'failed' | 'timed_out' | 'cancelled'>; failure?: AgentRunFailure }>;
}

/** Provider boundary. Domain/orchestration code only depends on this contract. */
export interface AgentRunnerPort {
  readonly provider: string;
  discover(): Promise<AgentProviderInstallation[]>;
  capabilities(installation: AgentProviderInstallation): Promise<AgentCapabilities>;
  start(context: ProviderRunContext): Promise<AgentRunHandle>;
  sendInput(runId: string, input: string): Promise<void>;
  resolveApproval(runId: string, approvalId: string, decision: ApprovalDecision): Promise<void>;
  cancel(runId: string, reason?: string): Promise<void>;
  resume(runId: string, input?: string): Promise<AgentRunHandle>;
  dispose(): Promise<void>;
}

export interface AgentRunStore {
  create(run: AgentRun): Promise<AgentRun>;
  get(runId: string): Promise<AgentRun | undefined>;
  list(): Promise<AgentRun[]>;
  update(run: AgentRun): Promise<AgentRun>;
  append(event: AgentEvent): Promise<'appended' | 'duplicate'>;
  events(runId: string, afterSequence?: number): Promise<AgentEvent[]>;
  recover(): Promise<{ recovered: string[]; truncatedTails: string[]; errors: Array<{ runId: string; message: string }> }>;
  prune(options: { before: string; dryRun?: boolean }): Promise<{ matched: string[]; removed: string[] }>;
  export(runId: string, options?: { includeSensitive?: boolean }): Promise<{ run: AgentRun; events: AgentEvent[] }>;
}

export function assertCompatibleAgentContract(schemaVersion: string, supportedMajor = 1): void {
  const match = /^(\d+)\.(\d+)$/.exec(schemaVersion);
  if (!match || Number(match[1]) !== supportedMajor) {
    throw new Error(`Inkompatible Agent-Vertragsversion: ${schemaVersion}; erwartet ${supportedMajor}.x.`);
  }
}

/** Runtime guard for adapter/plugin boundaries; additive fields stay allowed. */
export function assertAgentCapabilities(value: unknown, supportedMajor = 1): asserts value is AgentCapabilities {
  if (!value || typeof value !== 'object') throw new Error('Agent-Capabilities fehlen.');
  const candidate = value as Partial<AgentCapabilities>;
  if (typeof candidate.schemaVersion !== 'string') throw new Error('Agent-Capabilities enthalten keine Vertragsversion.');
  assertCompatibleAgentContract(candidate.schemaVersion, supportedMajor);
  if (typeof candidate.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(candidate.provider)) throw new Error('Agent-Capabilities enthalten keinen gueltigen Provider.');
  if (typeof candidate.adapterVersion !== 'string' || !candidate.adapterVersion.trim()) throw new Error('Agent-Capabilities enthalten keine Adapterversion.');
  for (const field of ['streaming', 'resume', 'interactiveInput', 'approvals', 'tools', 'images', 'structuredOutput', 'usage'] as const) {
    if (typeof candidate[field] !== 'boolean') throw new Error(`Agent-Capability ${field} fehlt oder ist ungueltig.`);
  }
  if (!Array.isArray(candidate.sandboxPolicies) || candidate.sandboxPolicies.some((item) => !['read-only', 'workspace-write', 'danger-full-access'].includes(item))) {
    throw new Error('Agent-Capability sandboxPolicies fehlt oder ist ungueltig.');
  }
  if (!Array.isArray(candidate.supportedRuntimeTargets) || candidate.supportedRuntimeTargets.some((item) => !['windows', 'wsl', 'linux', 'darwin', 'container'].includes(item))) {
    throw new Error('Agent-Capability supportedRuntimeTargets fehlt oder ist ungueltig.');
  }
}
