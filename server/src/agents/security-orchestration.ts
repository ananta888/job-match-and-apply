import { canonicalJson } from './security-approval.js';

export interface BudgetLimits {
  wallTimeMs: number;
  tokens: number;
  costMicros: number;
  toolCalls: number;
  iterations: number;
}

export interface BudgetUsage {
  wallTimeMs: number;
  tokens: number;
  costMicros: number;
  toolCalls: number;
  iterations: number;
}

export type OrchestrationGate = 'user_input' | 'approval' | 'evidence_complete' | 'review_complete';
export type NodeFailureStrategy = 'fail_fast' | 'skip_dependents' | 'continue_unrelated';
export type SideEffectSemantics = 'none' | 'idempotent_local' | 'non_idempotent';

export interface RetryPolicy {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  transientCategories: readonly AgentFailureCategory[];
}

export interface OrchestrationNode {
  id: string;
  role: string;
  providerId: string;
  dependsOn: readonly string[];
  inputRefs: readonly string[];
  outputRefs: readonly string[];
  gates: readonly OrchestrationGate[];
  contextIsolationKey: string;
  declaredIndependentAgent: boolean;
  sideEffect: SideEffectSemantics;
  idempotencyKey?: string;
  budget: BudgetLimits;
  retry: RetryPolicy;
  failureStrategy: NodeFailureStrategy;
  fanOutGroup?: string;
  fanInGroup?: string;
}

export interface OrchestrationPlan {
  id: string;
  version: string;
  allowedProviders: readonly string[];
  inputRefs: readonly string[];
  totalBudget: BudgetLimits;
  nodes: readonly OrchestrationNode[];
}

export interface ValidatedOrchestrationPlan {
  plan: OrchestrationPlan;
  topologicalOrder: string[];
  parallelLevels: string[][];
  independentAgentNodeIds: string[];
}

const BUDGET_KEYS: (keyof BudgetLimits)[] = ['wallTimeMs', 'tokens', 'costMicros', 'toolCalls', 'iterations'];

function assertBudget(name: string, budget: BudgetLimits): void {
  for (const key of BUDGET_KEYS) {
    const value = budget[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name}_budget_invalid:${key}`);
  }
  if (budget.wallTimeMs < 1 || budget.iterations < 1) throw new Error(`${name}_budget_too_small`);
}

export function validateOrchestrationPlan(plan: OrchestrationPlan): ValidatedOrchestrationPlan {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(plan.id)) throw new Error('orchestration_plan_id_invalid');
  if (!/^\d+\.\d+\.\d+$/.test(plan.version)) throw new Error('orchestration_plan_version_invalid');
  assertBudget('plan', plan.totalBudget);
  if (new Set(plan.allowedProviders).size !== plan.allowedProviders.length || plan.allowedProviders.length === 0) {
    throw new Error('orchestration_allowed_providers_invalid');
  }

  const nodes = new Map<string, OrchestrationNode>();
  const outputOwners = new Map<string, string>();
  const declaredRefs = new Set(plan.inputRefs);
  const independentContexts = new Set<string>();
  for (const node of plan.nodes) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(node.id)) throw new Error('orchestration_node_id_invalid');
    if (nodes.has(node.id)) throw new Error(`orchestration_node_duplicate:${node.id}`);
    if (!plan.allowedProviders.includes(node.providerId)) throw new Error(`orchestration_provider_undeclared:${node.providerId}`);
    if (!node.contextIsolationKey.trim()) throw new Error(`orchestration_context_key_required:${node.id}`);
    if (node.declaredIndependentAgent) {
      if (node.dependsOn.length > 0) throw new Error(`independent_agent_has_dependency:${node.id}`);
      if (independentContexts.has(node.contextIsolationKey)) throw new Error(`independent_agent_context_reused:${node.contextIsolationKey}`);
      independentContexts.add(node.contextIsolationKey);
    }
    assertBudget(`node_${node.id}`, node.budget);
    if (!Number.isSafeInteger(node.retry.maxAttempts) || node.retry.maxAttempts < 1 || node.retry.maxAttempts > node.budget.iterations) {
      throw new Error(`orchestration_retry_attempts_invalid:${node.id}`);
    }
    if (
      !Number.isSafeInteger(node.retry.initialBackoffMs)
      || !Number.isSafeInteger(node.retry.maxBackoffMs)
      || node.retry.initialBackoffMs < 0
      || node.retry.maxBackoffMs < node.retry.initialBackoffMs
    ) throw new Error(`orchestration_retry_backoff_invalid:${node.id}`);
    if (node.sideEffect === 'non_idempotent' && node.retry.maxAttempts > 1 && !node.idempotencyKey) {
      throw new Error(`non_idempotent_retry_without_idempotency_key:${node.id}`);
    }
    for (const output of node.outputRefs) {
      if (!output.trim() || outputOwners.has(output) || declaredRefs.has(output)) throw new Error(`orchestration_output_ref_conflict:${output}`);
      outputOwners.set(output, node.id);
    }
    nodes.set(node.id, node);
    for (const key of BUDGET_KEYS) {
      if (node.budget[key] > plan.totalBudget[key]) throw new Error(`orchestration_node_budget_exceeds_plan:${node.id}:${key}`);
    }
  }
  for (const [output] of outputOwners) declaredRefs.add(output);
  const dependsTransitivelyOn = (nodeId: string, possibleAncestor: string, visited = new Set<string>()): boolean => {
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    const current = nodes.get(nodeId);
    if (!current) return false;
    return current.dependsOn.includes(possibleAncestor)
      || current.dependsOn.some((dependency) => dependsTransitivelyOn(dependency, possibleAncestor, visited));
  };
  for (const node of plan.nodes) {
    if (node.dependsOn.includes(node.id)) throw new Error(`orchestration_self_dependency:${node.id}`);
    for (const dependency of node.dependsOn) {
      if (!nodes.has(dependency)) throw new Error(`orchestration_dependency_missing:${node.id}:${dependency}`);
    }
    for (const input of node.inputRefs) {
      if (!declaredRefs.has(input)) throw new Error(`orchestration_input_ref_missing:${node.id}:${input}`);
      const owner = outputOwners.get(input);
      if (owner && !dependsTransitivelyOn(node.id, owner)) throw new Error(`orchestration_input_dependency_missing:${node.id}:${owner}`);
    }
  }
  const indegree = new Map<string, number>([...nodes].map(([id, node]) => [id, node.dependsOn.length]));
  const levels: string[][] = [];
  const order: string[] = [];
  let ready = [...nodes.keys()].filter((id) => indegree.get(id) === 0).sort();
  while (ready.length > 0) {
    levels.push(ready);
    order.push(...ready);
    const next: string[] = [];
    for (const completed of ready) {
      for (const node of plan.nodes) {
        if (!node.dependsOn.includes(completed)) continue;
        const remaining = (indegree.get(node.id) ?? 0) - 1;
        indegree.set(node.id, remaining);
        if (remaining === 0) next.push(node.id);
      }
    }
    ready = [...new Set(next)].sort();
  }
  if (order.length !== plan.nodes.length) throw new Error('orchestration_dependency_cycle');
  return {
    plan: structuredClone(plan),
    topologicalOrder: order,
    parallelLevels: levels,
    independentAgentNodeIds: plan.nodes.filter((node) => node.declaredIndependentAgent).map((node) => node.id),
  };
}

export class BudgetTracker {
  private readonly usage: BudgetUsage = { wallTimeMs: 0, tokens: 0, costMicros: 0, toolCalls: 0, iterations: 0 };
  private exceededKey?: keyof BudgetLimits;

  constructor(readonly limits: BudgetLimits) {
    assertBudget('tracker', limits);
  }

  consume(delta: Partial<BudgetUsage>): BudgetUsage {
    for (const key of BUDGET_KEYS) {
      const value = delta[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`budget_usage_invalid:${key}`);
      if (this.usage[key] + value > this.limits[key]) {
        this.exceededKey = key;
        throw new Error(`budget_exceeded:${key}`);
      }
    }
    for (const key of BUDGET_KEYS) this.usage[key] += delta[key] ?? 0;
    return this.snapshot();
  }

  canStart(sideEffect: SideEffectSemantics, projected: Partial<BudgetUsage> = {}): boolean {
    if (this.exceededKey && sideEffect !== 'none') return false;
    return BUDGET_KEYS.every((key) => this.usage[key] + (projected[key] ?? 0) <= this.limits[key]);
  }

  snapshot(): BudgetUsage {
    return { ...this.usage };
  }
}

export type AgentFailureCategory =
  | 'rate_limit'
  | 'provider_unavailable'
  | 'transport_interrupted'
  | 'timeout'
  | 'validation'
  | 'policy_blocked'
  | 'cancelled'
  | 'unknown';

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  reason: string;
  requiresNewApproval: boolean;
}

export function decideRetry(input: {
  node: OrchestrationNode;
  category: AgentFailureCategory;
  attempt: number;
  hasFreshApproval?: boolean;
  secureIdempotencyCheckPassed?: boolean;
}): RetryDecision {
  if (input.attempt >= input.node.retry.maxAttempts) return { retry: false, delayMs: 0, reason: 'attempt_limit', requiresNewApproval: false };
  if (!input.node.retry.transientCategories.includes(input.category)) {
    return { retry: false, delayMs: 0, reason: 'non_transient_failure', requiresNewApproval: false };
  }
  if (input.node.sideEffect === 'non_idempotent') {
    if (!input.secureIdempotencyCheckPassed || !input.hasFreshApproval) {
      return { retry: false, delayMs: 0, reason: 'non_idempotent_action_requires_new_check_and_approval', requiresNewApproval: true };
    }
  }
  const delayMs = Math.min(
    input.node.retry.maxBackoffMs,
    input.node.retry.initialBackoffMs * (2 ** Math.max(0, input.attempt - 1)),
  );
  return { retry: true, delayMs, reason: 'classified_transient_failure', requiresNewApproval: input.node.sideEffect === 'non_idempotent' };
}

export type NodeExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'policy_blocked' | 'skipped';

export interface NodeExecutionState {
  nodeId: string;
  status: NodeExecutionStatus;
  attempts: number;
  outputProvenance: Array<{ outputRef: string; runId: string; artifactId?: string }>;
  failureCategory?: AgentFailureCategory;
  reason?: string;
}

export class OrchestrationCoordinator {
  private readonly states = new Map<string, NodeExecutionState>();
  private readonly resolvedGates = new Set<string>();

  constructor(readonly validated: ValidatedOrchestrationPlan) {
    for (const node of validated.plan.nodes) {
      this.states.set(node.id, { nodeId: node.id, status: 'pending', attempts: 0, outputProvenance: [] });
    }
  }

  resolveGate(nodeId: string, gate: OrchestrationGate): void {
    if (!this.states.has(nodeId)) throw new Error('orchestration_node_unknown');
    this.resolvedGates.add(`${nodeId}:${gate}`);
  }

  readyNodes(): OrchestrationNode[] {
    return this.validated.plan.nodes.filter((node) => {
      const state = this.states.get(node.id);
      if (state?.status !== 'pending') return false;
      if (!node.gates.every((gate) => this.resolvedGates.has(`${node.id}:${gate}`))) return false;
      return node.dependsOn.every((dependency) => this.states.get(dependency)?.status === 'succeeded');
    }).map((node) => structuredClone(node));
  }

  start(nodeId: string): NodeExecutionState {
    const state = this.requireState(nodeId);
    if (!this.readyNodes().some((node) => node.id === nodeId)) throw new Error('orchestration_node_not_ready');
    state.status = 'running';
    state.attempts += 1;
    return structuredClone(state);
  }

  retry(nodeId: string): NodeExecutionState {
    const state = this.requireRunning(nodeId);
    const node = this.node(nodeId);
    if (state.attempts >= node.retry.maxAttempts) throw new Error('orchestration_node_attempt_limit');
    state.attempts += 1;
    return structuredClone(state);
  }

  complete(nodeId: string, runId: string, artifacts: Readonly<Record<string, string | undefined>> = {}): NodeExecutionState {
    const state = this.requireRunning(nodeId);
    const node = this.node(nodeId);
    state.status = 'succeeded';
    state.outputProvenance = node.outputRefs.map((outputRef) => ({ outputRef, runId, artifactId: artifacts[outputRef] }));
    return structuredClone(state);
  }

  fail(nodeId: string, status: Extract<NodeExecutionStatus, 'failed' | 'cancelled' | 'policy_blocked'>, category: AgentFailureCategory, reason: string): NodeExecutionState {
    const state = this.requireRunning(nodeId);
    const node = this.node(nodeId);
    state.status = status;
    state.failureCategory = category;
    state.reason = reason;
    if (node.failureStrategy === 'fail_fast') {
      for (const candidate of this.states.values()) {
        if (candidate.status === 'pending') {
          candidate.status = 'skipped';
          candidate.reason = `fail_fast:${nodeId}`;
        }
      }
    } else {
      this.skipDependents(nodeId, new Set());
    }
    return structuredClone(state);
  }

  snapshot(): NodeExecutionState[] {
    return this.validated.topologicalOrder.map((id) => structuredClone(this.requireState(id)));
  }

  assertProviderDeclared(providerId: string): void {
    if (!this.validated.plan.allowedProviders.includes(providerId)) throw new Error('orchestration_undeclared_child_provider');
  }

  private skipDependents(nodeId: string, visited: Set<string>): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    for (const node of this.validated.plan.nodes.filter((candidate) => candidate.dependsOn.includes(nodeId))) {
      const state = this.requireState(node.id);
      if (state.status === 'pending') {
        state.status = 'skipped';
        state.reason = `dependency_failed:${nodeId}`;
      }
      this.skipDependents(node.id, visited);
    }
  }

  private requireState(nodeId: string): NodeExecutionState {
    const state = this.states.get(nodeId);
    if (!state) throw new Error('orchestration_node_unknown');
    return state;
  }

  private requireRunning(nodeId: string): NodeExecutionState {
    const state = this.requireState(nodeId);
    if (state.status !== 'running') throw new Error('orchestration_node_not_running');
    return state;
  }

  private node(nodeId: string): OrchestrationNode {
    const node = this.validated.plan.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error('orchestration_node_unknown');
    return node;
  }
}

export interface AgentResultVariant<T> {
  nodeId: string;
  runId: string;
  providerId: string;
  value: T;
  sources: readonly string[];
}

export type FanInResult<T> =
  | { state: 'equivalent'; value: T; variants: AgentResultVariant<T>[] }
  | { state: 'conflict'; variants: AgentResultVariant<T>[]; requiresDomainResolution: true };

/** Equal normalized results may merge; disagreement is retained, never voted away. */
export function fanInWithoutMajority<T>(variants: readonly AgentResultVariant<T>[]): FanInResult<T> {
  if (variants.length === 0) throw new Error('fan_in_requires_results');
  const normalized = variants.map((variant) => canonicalJson(variant.value));
  if (normalized.every((value) => value === normalized[0])) {
    return { state: 'equivalent', value: structuredClone(variants[0]!.value), variants: structuredClone([...variants]) };
  }
  return { state: 'conflict', variants: structuredClone([...variants]), requiresDomainResolution: true };
}
