import { createHash, randomUUID } from 'node:crypto';
import { normalize, resolve } from 'node:path';
import {
  AGENT_CONTRACT_VERSION,
  assertCompatibleAgentContract,
  assertAgentCapabilities,
  type AgentEvent,
  type AgentEventDraft,
  type AgentProviderInstallation,
  type AgentRunnerPort,
  type AgentRun,
  type AgentRunRequest,
  type AgentRunStore,
  type ApprovalDecision
} from '../ports/agent-runner.js';
import { nextAgentEvent } from './event-factory.js';
import { transitionRunWithAudit, type InvalidTransitionAudit } from './state-machine.js';
import { validateWorkspaceRoot } from './runtime-discovery.js';
import {
  assertUserInputActor,
  normalizeUserInputRequest,
  pendingUserInputRequest,
  SensitiveUserInputRedactor,
  validateUserInputAnswer,
  type AgentUserInputActor,
} from './user-input.js';

interface QueuedRun {
  runId: string;
  priority: number;
  ordinal: number;
  enqueuedAt: number;
  workspaceKey: string;
  ownerId?: string;
}

interface RunReservation { provider: string; workspaceKey: string; ownerId?: string; }

export type AgentQueueBlockReason = 'global_limit' | 'provider_limit' | 'workspace_limit' | 'owner_limit';

export interface AgentQueueEntryDiagnostic {
  runId: string;
  provider: string;
  workspaceRoot: string;
  ownerId?: string;
  position: number;
  basePriority: number;
  effectivePriority: number;
  waitMs: number;
  blockedBy: AgentQueueBlockReason[];
}

export interface AgentQueueDiagnostics {
  capturedAt: string;
  depth: number;
  active: number;
  limits: {
    global: number;
    perProvider: number;
    perWorkspace?: number;
    perOwner?: number;
    queuedGlobal?: number;
    queuedPerWorkspace?: number;
    queuedPerOwner?: number;
  };
  activeByProvider: Readonly<Record<string, number>>;
  activeByWorkspace: Readonly<Record<string, number>>;
  activeByOwner: Readonly<Record<string, number>>;
  queue: AgentQueueEntryDiagnostic[];
}

export type RecoveryDecision = 'cleanup' | 'resume';

export interface AgentRecoveryLease {
  runId: string;
  leaseId: string;
  operatorId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface AgentRecoveryDiagnostic {
  runId: string;
  state: AgentRun['state'];
  provider: string;
  providerSessionPresent: boolean;
  processAdoptionAllowed: false;
  allowedDecisions: readonly RecoveryDecision[];
  lease?: Omit<AgentRecoveryLease, 'leaseId'>;
}

export class AgentQueueLimitError extends Error {
  readonly name = 'AgentQueueLimitError';

  constructor(
    readonly code: 'queue_global_limit' | 'queue_workspace_limit' | 'queue_owner_limit' | 'owner_metadata_required',
    readonly scope: string,
    readonly limit: number,
    readonly current: number,
  ) {
    super(`${code}: ${scope} hat ${current} von ${limit} erlaubten Queue-Slots belegt.`);
  }
}

export interface AgentControlCenterOptions {
  maxParallel: number;
  maxParallelPerProvider: number;
  maxParallelPerWorkspace?: number;
  maxParallelPerOwner?: number;
  maxQueued?: number;
  maxQueuedPerWorkspace?: number;
  maxQueuedPerOwner?: number;
  ownerMetadataKeys?: readonly string[];
  queueAgingIntervalMs?: number;
  queueAgingPriorityStep?: number;
  queueAgingMaxBoost?: number;
  recoveryLeaseMs?: number;
  allowedWorkspaceRoots: readonly string[];
  installationSelector?: (installations: AgentProviderInstallation[], request: AgentRunRequest) => AgentProviderInstallation | undefined;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onQueueDepth?: (depth: number) => void;
  now?: () => Date;
  id?: () => string;
  leaseId?: () => string;
}

function countBy(values: Iterable<string | undefined>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) if (value !== undefined) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function workspaceKey(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function assertOptionalLimit(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${name} muss mindestens 1 sein.`);
}

export class AgentControlCenter {
  private readonly providers = new Map<string, AgentRunnerPort>();
  private readonly queue: QueuedRun[] = [];
  private readonly active = new Map<string, AgentRunnerPort>();
  private readonly inFlight = new Map<string, RunReservation>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  private readonly inputRedactors = new Map<string, SensitiveUserInputRedactor>();
  private readonly inputInFlight = new Set<string>();
  private readonly recoveryLeases = new Map<string, AgentRecoveryLease>();
  private readonly resolvingRecoveries = new Set<string>();
  private pendingAdmissions = 0;
  private readonly pendingAdmissionsByWorkspace = new Map<string, number>();
  private readonly pendingAdmissionsByOwner = new Map<string, number>();
  private ordinal = 0;
  private scheduling = false;
  private disposed = false;

  constructor(private readonly store: AgentRunStore, providers: readonly AgentRunnerPort[], private readonly options: AgentControlCenterOptions) {
    if (!Number.isSafeInteger(options.maxParallel) || options.maxParallel < 1) throw new Error('Globale Parallelität muss mindestens 1 sein.');
    if (!Number.isSafeInteger(options.maxParallelPerProvider) || options.maxParallelPerProvider < 1) throw new Error('Providerparallelität muss mindestens 1 sein.');
    assertOptionalLimit('Workspaceparallelitaet', options.maxParallelPerWorkspace);
    assertOptionalLimit('Ownerparallelitaet', options.maxParallelPerOwner);
    assertOptionalLimit('Globale Queue-Kapazitaet', options.maxQueued);
    assertOptionalLimit('Workspace-Queue-Kapazitaet', options.maxQueuedPerWorkspace);
    assertOptionalLimit('Owner-Queue-Kapazitaet', options.maxQueuedPerOwner);
    assertOptionalLimit('Queue-Aging-Intervall', options.queueAgingIntervalMs);
    assertOptionalLimit('Queue-Aging-Schritt', options.queueAgingPriorityStep);
    assertOptionalLimit('Queue-Aging-Maximalbonus', options.queueAgingMaxBoost);
    assertOptionalLimit('Recovery-Lease-Dauer', options.recoveryLeaseMs);
    if (options.ownerMetadataKeys?.some((key) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key))) throw new Error('Owner-Metadatenkeys sind ungueltig.');
    for (const provider of providers) {
      if (this.providers.has(provider.provider)) throw new Error(`Provider ${provider.provider} ist doppelt registriert.`);
      this.providers.set(provider.provider, provider);
    }
  }

  async enqueue(request: AgentRunRequest): Promise<AgentRun> {
    if (this.disposed) throw new Error('Agent Control Center wurde beendet.');
    const provider = this.providers.get(request.provider);
    if (!provider) throw new Error(`Unbekannter Provider: ${request.provider}`);
    if (typeof request.task !== 'string' || !request.task.trim() || request.task.includes('\0') || Buffer.byteLength(request.task) > 1024 * 1024) {
      throw new Error('Agentenaufgabe ist leer, ungültig oder größer als 1 MiB.');
    }
    if (request.priority !== undefined && (!Number.isSafeInteger(request.priority) || request.priority < -100 || request.priority > 100)) {
      throw new Error('Run-Priorität muss eine Ganzzahl zwischen -100 und 100 sein.');
    }
    const workspaceRoot = await validateWorkspaceRoot(request.workspaceRoot, this.options.allowedWorkspaceRoots);
    const normalizedRequest = { ...structuredClone(request), workspaceRoot };
    const ownerId = this.ownerId(normalizedRequest);
    const normalizedWorkspace = workspaceKey(workspaceRoot);
    this.assertQueueCapacity(normalizedWorkspace, ownerId);
    this.reserveAdmission(normalizedWorkspace, ownerId);
    let admissionReserved = true;
    try {
      const now = this.now();
      const run: AgentRun = {
        schemaVersion: AGENT_CONTRACT_VERSION, id: (this.options.id ?? randomUUID)(), provider: request.provider,
        state: 'queued', request: normalizedRequest,
        requestedAt: now.toISOString(), updatedAt: now.toISOString(), currentSequence: 0,
        queuePosition: this.queue.length + 1
      };
      await this.store.create(run);
      await this.emit(run.id, { kind: 'run_created', data: {
        request: structuredClone(normalizedRequest), requestedAt: run.requestedAt
      } });
      this.queue.push({
        runId: run.id, priority: request.priority ?? 0, ordinal: this.ordinal++, enqueuedAt: now.getTime(),
        workspaceKey: normalizedWorkspace, ownerId,
      });
      this.releaseAdmission(normalizedWorkspace, ownerId);
      admissionReserved = false;
      await this.refreshQueuePositions(); this.options.onQueueDepth?.(this.queue.length);
      void this.schedule();
      return (await this.store.get(run.id))!;
    } finally {
      if (admissionReserved) this.releaseAdmission(normalizedWorkspace, ownerId);
    }
  }

  async get(runId: string): Promise<AgentRun | undefined> { return this.store.get(runId); }
  async list(): Promise<AgentRun[]> { return this.store.list(); }
  async events(runId: string, afterSequence = 0): Promise<AgentEvent[]> { return this.store.events(runId, afterSequence); }

  async getQueueDiagnostics(): Promise<AgentQueueDiagnostics> {
    const now = this.now();
    this.sortQueue(now.getTime());
    const activeByProvider = countBy([...this.inFlight.values()].map((item) => item.provider));
    const activeByWorkspace = countBy([...this.inFlight.values()].map((item) => item.workspaceKey));
    const activeByOwner = countBy([...this.inFlight.values()].map((item) => item.ownerId));
    const queue: AgentQueueEntryDiagnostic[] = [];
    for (let index = 0; index < this.queue.length; index += 1) {
      const item = this.queue[index]!;
      const run = await this.store.get(item.runId);
      if (!run) continue;
      queue.push({
        runId: item.runId,
        provider: run.provider,
        workspaceRoot: run.request.workspaceRoot,
        ownerId: item.ownerId,
        position: index + 1,
        basePriority: item.priority,
        effectivePriority: this.effectivePriority(item, now.getTime()),
        waitMs: Math.max(0, now.getTime() - item.enqueuedAt),
        blockedBy: this.blockReasons(item, run.provider, activeByProvider, activeByWorkspace, activeByOwner),
      });
    }
    return {
      capturedAt: now.toISOString(), depth: this.queue.length, active: this.inFlight.size,
      limits: {
        global: this.options.maxParallel,
        perProvider: this.options.maxParallelPerProvider,
        perWorkspace: this.options.maxParallelPerWorkspace,
        perOwner: this.options.maxParallelPerOwner,
        queuedGlobal: this.options.maxQueued,
        queuedPerWorkspace: this.options.maxQueuedPerWorkspace,
        queuedPerOwner: this.options.maxQueuedPerOwner,
      },
      activeByProvider, activeByWorkspace, activeByOwner, queue,
    };
  }

  async getRecoveryDiagnostics(): Promise<AgentRecoveryDiagnostic[]> {
    this.expireRecoveryLeases();
    const runs = await this.store.list();
    return runs.filter((run) => run.state === 'orphaned' || run.state === 'recovering').map((run) => {
      const lease = this.recoveryLeases.get(run.id);
      return {
        runId: run.id,
        state: run.state,
        provider: run.provider,
        providerSessionPresent: Boolean(run.providerSessionId),
        processAdoptionAllowed: false as const,
        allowedDecisions: ['cleanup', 'resume'] as const,
        ...(lease ? { lease: {
          runId: lease.runId, operatorId: lease.operatorId, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt,
        } } : {}),
      };
    });
  }

  async acquireRecoveryLease(runId: string, operatorId: string): Promise<AgentRecoveryLease> {
    this.assertOperatorId(operatorId);
    this.expireRecoveryLeases();
    const run = await this.required(runId);
    if (run.state !== 'orphaned') throw new Error(`Run ${runId} ist nicht fuer eine Recovery-Entscheidung freigegeben.`);
    const existing = this.recoveryLeases.get(runId);
    if (existing) throw new Error(`Run ${runId} besitzt bereits eine aktive Recovery-Lease.`);
    const acquiredAt = this.now();
    const lease: AgentRecoveryLease = {
      runId,
      leaseId: (this.options.leaseId ?? randomUUID)(),
      operatorId,
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: new Date(acquiredAt.getTime() + (this.options.recoveryLeaseMs ?? 5 * 60_000)).toISOString(),
    };
    this.recoveryLeases.set(runId, lease);
    return structuredClone(lease);
  }

  async resolveRecovery(
    runId: string,
    leaseId: string,
    operatorId: string,
    decision: RecoveryDecision,
    input?: string,
  ): Promise<{ resolved: AgentRun; replacement?: AgentRun }> {
    this.assertOperatorId(operatorId);
    const lease = this.requiredRecoveryLease(runId, leaseId, operatorId);
    if (this.resolvingRecoveries.has(runId)) throw new Error(`Recovery fuer Run ${runId} wird bereits entschieden.`);
    this.resolvingRecoveries.add(runId);
    try {
      let orphaned = await this.required(runId);
      if (orphaned.state !== 'orphaned') throw new Error(`Run ${runId} ist nicht mehr orphaned; Recovery wird verweigert.`);
      if (decision !== 'cleanup' && decision !== 'resume') throw new Error('Unbekannte Recovery-Entscheidung.');

      let replacement: AgentRun | undefined;
      if (decision === 'resume') {
        const task = input ?? orphaned.request.task;
        const priorMetadata = orphaned.request.metadata && typeof orphaned.request.metadata === 'object'
          ? structuredClone(orphaned.request.metadata) : {};
        orphaned = await this.transition(orphaned, 'recovering', 'operator reserved recovery replacement', this.now());
        await this.store.update(orphaned);
        try {
          // Recovery always creates a newly scheduled run. It never adopts a PID or
          // calls provider.resume() against state owned by an earlier server process.
          replacement = await this.enqueue({
            ...structuredClone(orphaned.request),
            task,
            metadata: { ...priorMetadata, recoveryOf: runId, recoveryMode: 'new-process', recoveryOperator: operatorId },
          });
        } catch (error) {
          const recovering = await this.required(runId);
          if (recovering.state === 'recovering') await this.store.update(await this.transition(recovering, 'orphaned', 'replacement admission failed closed', this.now()));
          throw error;
        }
      }

      let resolved = await this.transition(orphaned, 'cancelled', `operator recovery ${decision}`, this.now());
      resolved.failure = {
        code: decision === 'resume' ? 'recovered_as_new_run' : 'recovery_cleaned_up',
        message: decision === 'resume' ? `Durch neuen Run ${replacement!.id} ersetzt.` : 'Durch Operatorentscheidung abgeschlossen.',
        retryable: false,
      };
      await this.store.update(resolved);
      await this.emit(runId, { kind: 'run_completed', data: {
        state: 'cancelled', reason: resolved.failure.code, ...(replacement ? { replacementRunId: replacement.id } : {}),
      } });
      this.recoveryLeases.delete(lease.runId);
      resolved = (await this.required(runId));
      return { resolved, ...(replacement ? { replacement } : {}) };
    } finally {
      this.resolvingRecoveries.delete(runId);
    }
  }

  async sendInput(runId: string, input: string, actor: AgentUserInputActor): Promise<void> {
    assertUserInputActor(actor);
    const run = await this.required(runId);
    if (run.state !== 'waiting_for_input') throw new Error(`Run ${runId} wartet nicht auf Eingabe.`);
    if (this.inputInFlight.has(runId)) throw new Error(`Run ${runId} verarbeitet bereits eine Eingabe.`);
    const provider = this.active.get(runId);
    if (!provider) throw new Error(`Run ${runId} ist nicht aktiv.`);
    if (!run.capabilities?.interactiveInput) throw new Error(`${run.provider} unterstützt keine interaktive Eingabe.`);
    const inputLimit = run.request.limits?.maxInputBytes ?? 256 * 1024;
    const request = pendingUserInputRequest(await this.store.events(runId), this.now());
    validateUserInputAnswer(request, input, inputLimit);
    const redactor = this.inputRedactors.get(runId) ?? new SensitiveUserInputRedactor();
    this.inputRedactors.set(runId, redactor);
    if (request.sensitive) redactor.add(input);
    this.inputInFlight.add(runId);
    try {
      await provider.sendInput(runId, input);
      await this.emit(runId, { kind: 'user_input_received', data: {
        received: true,
        byteLength: Buffer.byteLength(input, 'utf8'),
        sensitive: request.sensitive,
        requestId: request.id,
        requestedSequence: request.requestedSequence,
        actor: { id: actor.id, type: actor.type },
      } });
    } finally {
      this.inputInFlight.delete(runId);
    }
  }

  async resolveApproval(runId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const run = await this.required(runId);
    if (run.state !== 'waiting_for_approval') throw new Error(`Run ${runId} wartet nicht auf eine Freigabe.`);
    const provider = this.active.get(runId);
    if (!provider || !run.capabilities?.approvals) throw new Error(`${run.provider} besitzt keine aktive Approval-Brücke.`);
    if (!['approved', 'denied', 'cancelled', 'expired'].includes(decision)) throw new Error('Ungültige Freigabeentscheidung.');
    await provider.resolveApproval(runId, approvalId, decision);
  }

  async cancel(runId: string, reason = 'Vom Nutzer abgebrochen.'): Promise<void> {
    let run = await this.required(runId);
    if (['cancelled', 'succeeded', 'failed', 'timed_out'].includes(run.state)) return;
    if (run.state === 'queued') {
      const index = this.queue.findIndex((candidate) => candidate.runId === runId);
      if (index >= 0) this.queue.splice(index, 1);
      run = await this.transition(run, 'cancelled', reason, (this.options.now ?? (() => new Date()))());
      await this.store.update(run); await this.emit(runId, { kind: 'run_completed', data: { state: 'cancelled', reason } });
      await this.refreshQueuePositions(); this.options.onQueueDepth?.(this.queue.length); return;
    }
    if (run.state === 'orphaned' || run.state === 'recovering') {
      run = await this.transition(run, 'cancelled', reason, this.now());
      await this.store.update(run);
      await this.emit(runId, { kind: 'run_completed', data: { state: 'cancelled', reason } });
      this.recoveryLeases.delete(runId);
      return;
    }
    if (run.state !== 'cancelling') { run = await this.transition(run, 'cancelling', reason); await this.store.update(run); }
    const provider = this.active.get(runId);
    if (provider) await provider.cancel(runId, reason);
  }

  async recover(): ReturnType<AgentRunStore['recover']> {
    if (this.inFlight.size > 0 || this.queue.length > 0 || this.active.size > 0) throw new Error('Recovery ist nur beim Start ohne aktive oder eingereihte Runs erlaubt.');
    this.recoveryLeases.clear();
    return this.store.recover();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.active.entries()].map(([runId, provider]) => provider.cancel(runId, 'Server wird beendet.')));
    await Promise.allSettled([...this.providers.values()].map((provider) => provider.dispose()));
    this.inputRedactors.clear();
    this.inputInFlight.clear();
  }

  private now(): Date { return (this.options.now ?? (() => new Date()))(); }

  private ownerId(request: AgentRunRequest): string | undefined {
    const keys = this.options.ownerMetadataKeys ?? ['ownerId', 'userId'];
    for (const key of keys) {
      const value = request.metadata?.[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9@._:-]{0,127}$/.test(value)) throw new Error(`Owner-Metadatum ${key} ist ungueltig.`);
      return value;
    }
    if (this.options.maxParallelPerOwner !== undefined || this.options.maxQueuedPerOwner !== undefined) {
      throw new AgentQueueLimitError('owner_metadata_required', keys.join('|'), 1, 0);
    }
    return undefined;
  }

  private assertQueueCapacity(workspace: string, ownerId: string | undefined): void {
    const checks: Array<[number | undefined, number, AgentQueueLimitError['code'], string]> = [
      [this.options.maxQueued, this.queue.length + this.pendingAdmissions, 'queue_global_limit', 'global'],
      [this.options.maxQueuedPerWorkspace, this.queue.filter((item) => item.workspaceKey === workspace).length + (this.pendingAdmissionsByWorkspace.get(workspace) ?? 0), 'queue_workspace_limit', workspace],
      [this.options.maxQueuedPerOwner, ownerId === undefined ? 0 : this.queue.filter((item) => item.ownerId === ownerId).length + (this.pendingAdmissionsByOwner.get(ownerId) ?? 0), 'queue_owner_limit', ownerId ?? 'missing'],
    ];
    for (const [limit, current, code, scope] of checks) if (limit !== undefined && current >= limit) throw new AgentQueueLimitError(code, scope, limit, current);
  }

  private reserveAdmission(workspace: string, ownerId: string | undefined): void {
    this.pendingAdmissions += 1;
    this.pendingAdmissionsByWorkspace.set(workspace, (this.pendingAdmissionsByWorkspace.get(workspace) ?? 0) + 1);
    if (ownerId !== undefined) this.pendingAdmissionsByOwner.set(ownerId, (this.pendingAdmissionsByOwner.get(ownerId) ?? 0) + 1);
  }

  private releaseAdmission(workspace: string, ownerId: string | undefined): void {
    this.pendingAdmissions -= 1;
    const workspaceCount = (this.pendingAdmissionsByWorkspace.get(workspace) ?? 1) - 1;
    if (workspaceCount === 0) this.pendingAdmissionsByWorkspace.delete(workspace); else this.pendingAdmissionsByWorkspace.set(workspace, workspaceCount);
    if (ownerId !== undefined) {
      const ownerCount = (this.pendingAdmissionsByOwner.get(ownerId) ?? 1) - 1;
      if (ownerCount === 0) this.pendingAdmissionsByOwner.delete(ownerId); else this.pendingAdmissionsByOwner.set(ownerId, ownerCount);
    }
  }

  private effectivePriority(item: QueuedRun, nowMs: number): number {
    const interval = this.options.queueAgingIntervalMs ?? 30_000;
    const step = this.options.queueAgingPriorityStep ?? 1;
    const maximum = this.options.queueAgingMaxBoost ?? 100;
    return item.priority + Math.min(maximum, Math.floor(Math.max(0, nowMs - item.enqueuedAt) / interval) * step);
  }

  private sortQueue(nowMs = this.now().getTime()): void {
    this.queue.sort((a, b) => this.effectivePriority(b, nowMs) - this.effectivePriority(a, nowMs) || a.ordinal - b.ordinal);
  }

  private blockReasons(
    item: QueuedRun,
    provider: string,
    activeByProvider = countBy([...this.inFlight.values()].map((value) => value.provider)),
    activeByWorkspace = countBy([...this.inFlight.values()].map((value) => value.workspaceKey)),
    activeByOwner = countBy([...this.inFlight.values()].map((value) => value.ownerId)),
  ): AgentQueueBlockReason[] {
    const reasons: AgentQueueBlockReason[] = [];
    if (this.inFlight.size >= this.options.maxParallel) reasons.push('global_limit');
    if ((activeByProvider[provider] ?? 0) >= this.options.maxParallelPerProvider) reasons.push('provider_limit');
    if (this.options.maxParallelPerWorkspace !== undefined && (activeByWorkspace[item.workspaceKey] ?? 0) >= this.options.maxParallelPerWorkspace) reasons.push('workspace_limit');
    if (item.ownerId !== undefined && this.options.maxParallelPerOwner !== undefined && (activeByOwner[item.ownerId] ?? 0) >= this.options.maxParallelPerOwner) reasons.push('owner_limit');
    return reasons;
  }

  private assertOperatorId(operatorId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9@._:-]{0,127}$/.test(operatorId)) throw new Error('Recovery-Operator-ID ist ungueltig.');
  }

  private expireRecoveryLeases(): void {
    const now = this.now().getTime();
    for (const [runId, lease] of this.recoveryLeases) if (new Date(lease.expiresAt).getTime() <= now) this.recoveryLeases.delete(runId);
  }

  private requiredRecoveryLease(runId: string, leaseId: string, operatorId: string): AgentRecoveryLease {
    this.expireRecoveryLeases();
    const lease = this.recoveryLeases.get(runId);
    if (!lease || lease.leaseId !== leaseId || lease.operatorId !== operatorId) throw new Error('Recovery-Lease fehlt, ist abgelaufen oder gehoert einem anderen Operator.');
    return lease;
  }

  private async refreshQueuePositions(): Promise<void> {
    this.sortQueue();
    for (let index = 0; index < this.queue.length; index += 1) {
      const run = await this.store.get(this.queue[index]!.runId);
      if (run && run.queuePosition !== index + 1) await this.store.update({ ...run, queuePosition: index + 1, updatedAt: this.now().toISOString() });
    }
  }

  private async schedule(): Promise<void> {
    if (this.scheduling || this.disposed) return;
    this.scheduling = true;
    try {
      while (this.inFlight.size < this.options.maxParallel) {
        this.sortQueue();
        let chosen = -1;
        for (let candidate = 0; candidate < this.queue.length; candidate += 1) {
          const queued = this.queue[candidate]!;
          const run = await this.store.get(queued.runId);
          if (!run) continue;
          if (this.blockReasons(queued, run.provider).length === 0) { chosen = candidate; break; }
        }
        if (chosen < 0) break;
        const [queued] = this.queue.splice(chosen, 1);
        if (!queued) break;
        this.options.onQueueDepth?.(this.queue.length);
        const reserved = await this.store.get(queued.runId);
        if (!reserved) continue;
        this.inFlight.set(queued.runId, { provider: reserved.provider, workspaceKey: queued.workspaceKey, ownerId: queued.ownerId });
        await this.refreshQueuePositions();
        void this.execute(queued.runId);
      }
    } finally { this.scheduling = false; }
  }

  private async execute(runId: string): Promise<void> {
    let run = await this.required(runId);
    const provider = this.providers.get(run.provider)!;
    try {
      run = await this.transition(run, 'starting', 'queue slot allocated', (this.options.now ?? (() => new Date()))());
      run.queuePosition = undefined; await this.store.update(run);
      const installations = await provider.discover();
      const installation = this.options.installationSelector?.(installations, run.request)
        ?? installations.find((candidate) => candidate.runtimeTarget === run.request.runtimeTarget
          && (!run.request.wslDistribution || candidate.distribution === run.request.wslDistribution)
          && candidate.support === 'supported');
      if (!installation) throw new Error(`Keine freigegebene ${run.provider}-Installation für ${run.request.runtimeTarget} gefunden.`);
      const capabilities = await provider.capabilities(installation);
      assertAgentCapabilities(capabilities);
      if (capabilities.provider !== run.provider) throw new Error('Capability-Provider stimmt nicht mit dem Run ueberein.');
      run = { ...(await this.required(runId)), capabilities }; await this.store.update(run);
      await this.emit(runId, { kind: 'capabilities_negotiated', data: { capabilities } });
      this.active.set(runId, provider);
      const handle = await provider.start({ runId, request: run.request, installation, emit: (draft) => this.emit(runId, draft, 'provider') });
      const outcome = await handle.completion;
      run = await this.required(runId);
      if (!['cancelled', 'succeeded', 'failed', 'timed_out'].includes(run.state)) {
        run = await this.transition(run, outcome.state, 'provider completed');
        if (outcome.failure) run.failure = outcome.failure;
        await this.store.update(run);
      }
    } catch (error) {
      run = await this.required(runId);
      if (!['cancelled', 'succeeded', 'failed', 'timed_out'].includes(run.state)) {
        if (run.state === 'cancelling') run = await this.transition(run, 'cancelled', 'cancel failed closed');
        else {
          run = await this.transition(run, 'failed', 'provider start/run failed');
          run.failure = { code: 'agent_run_failed', message: (error as Error).message, retryable: false };
        }
        await this.store.update(run);
        await this.emit(runId, { kind: 'error', data: { code: run.failure?.code ?? 'cancelled', message: run.failure?.message ?? (error as Error).message } });
        await this.emit(runId, { kind: 'run_completed', data: { state: run.state } });
      }
    } finally {
      this.active.delete(runId);
      this.inFlight.delete(runId);
      // Provider output is no longer accepted once the run is terminal, so the
      // in-memory exact-value redactor can release sensitive answer material.
      this.inputRedactors.delete(runId);
      void this.schedule();
    }
  }

  private async emit(runId: string, draft: AgentEventDraft, source: 'server' | 'provider' = 'server'): Promise<void> {
    const previous = this.eventQueues.get(runId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const run = await this.required(runId);
      if (source === 'provider' && draft.kind === 'user_input_received') throw new Error('provider_user_input_receipt_forbidden');
      if (source === 'provider' && ['cancelled', 'succeeded', 'failed', 'timed_out'].includes(run.state)) {
        throw new Error('provider_event_after_terminal_forbidden');
      }
      const now = this.now();
      let providerDraft = draft;
      if (source === 'provider' && draft.kind === 'user_input_requested') {
        const { timestamp: _providerTimestamp, ...withoutProviderTimestamp } = draft;
        providerDraft = { ...withoutProviderTimestamp, data: normalizeUserInputRequest(draft.data, now) };
      }
      const redactor = this.inputRedactors.get(runId);
      const sanitizedDraft = redactor && providerDraft.kind !== 'user_input_received'
        ? { ...providerDraft, data: redactor.redact(providerDraft.data) as Readonly<Record<string, unknown>> }
        : providerDraft;
      const event = nextAgentEvent(run, sanitizedDraft, now);
      await this.store.append(event);
      try { await this.options.onEvent?.(structuredClone(event)); } catch { /* Observability cannot fail a run. */ }
    });
    this.eventQueues.set(runId, operation.catch(() => undefined));
    return operation;
  }

  private async transition(run: AgentRun, to: AgentRun['state'], reason: string, now = this.now()): Promise<AgentRun> {
    return transitionRunWithAudit(run, to, reason, (audit) => this.persistInvalidTransition(audit), now);
  }

  private async persistInvalidTransition(audit: InvalidTransitionAudit): Promise<void> {
    const reasonSha256 = createHash('sha256').update(audit.reason, 'utf8').digest('hex');
    await this.emit(audit.runId, { kind: 'warning', timestamp: audit.timestamp, data: {
      code: 'invalid_state_transition', from: audit.from, to: audit.to, reasonSha256
    } });
  }

  private async required(runId: string): Promise<AgentRun> {
    const run = await this.store.get(runId);
    if (!run) throw new Error(`Run ${runId} wurde nicht gefunden.`);
    return run;
  }
}
