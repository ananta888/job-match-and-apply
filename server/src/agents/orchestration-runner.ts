import {
  BudgetTracker,
  OrchestrationCoordinator,
  decideRetry,
  validateOrchestrationPlan,
  type AgentFailureCategory,
  type BudgetUsage,
  type OrchestrationGate,
  type OrchestrationNode,
  type OrchestrationPlan,
  type NodeExecutionState
} from './security-orchestration.js';

export interface OrchestrationNodeExecutionRequest {
  workflowId: string;
  workflowVersion: string;
  node: OrchestrationNode;
  attempt: number;
  inputs: Readonly<Record<string, { source: 'workflow_input' | 'node_output'; runId?: string; artifactId?: string }>>;
  signal: AbortSignal;
}

export interface OrchestrationNodeExecutionResult {
  status: 'succeeded' | 'failed' | 'cancelled' | 'policy_blocked';
  runId: string;
  artifacts?: Readonly<Record<string, string | undefined>>;
  usage?: Partial<BudgetUsage>;
  failureCategory?: AgentFailureCategory;
  reason?: string;
}

export interface OrchestrationNodeExecutor {
  execute(request: OrchestrationNodeExecutionRequest): Promise<OrchestrationNodeExecutionResult>;
}

export interface OrchestrationRunOptions {
  resolvedGates?: readonly { nodeId: string; gate: OrchestrationGate }[];
  signal?: AbortSignal;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  authorizeRetry?: (input: { node: OrchestrationNode; attempt: number; category: AgentFailureCategory }) => Promise<{
    hasFreshApproval: boolean;
    secureIdempotencyCheckPassed: boolean;
  }>;
}

export interface OrchestrationExecutionReport {
  workflowId: string;
  workflowVersion: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'waiting_for_gate';
  nodes: NodeExecutionState[];
  budget: BudgetUsage;
  unresolvedGates: Array<{ nodeId: string; gate: OrchestrationGate }>;
}

function noDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('orchestration_cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('orchestration_cancelled')); }, { once: true });
  });
}

function safeReason(value: string | undefined): string {
  return value && /^[a-z][a-z0-9_.:-]{0,239}$/i.test(value) ? value : 'node_execution_failed';
}

/**
 * Executes only the predeclared DAG. Every node has a separate execution call,
 * parallelism follows validated levels, and retries cannot silently replay a
 * side effect or introduce another provider.
 */
export class OrchestrationRunner {
  constructor(private readonly executor: OrchestrationNodeExecutor) {}

  async run(plan: OrchestrationPlan, options: OrchestrationRunOptions = {}): Promise<OrchestrationExecutionReport> {
    const validated = validateOrchestrationPlan(plan);
    const coordinator = new OrchestrationCoordinator(validated);
    const budget = new BudgetTracker(plan.totalBudget);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
    const resolved = new Set<string>();
    for (const gate of options.resolvedGates ?? []) {
      coordinator.resolveGate(gate.nodeId, gate.gate);
      resolved.add(`${gate.nodeId}:${gate.gate}`);
    }
    const outputs = new Map<string, { runId: string; artifactId?: string }>();
    const delay = options.delay ?? noDelay;

    try {
      while (true) {
        if (controller.signal.aborted) return this.report(plan, coordinator, budget, resolved, 'cancelled');
        const ready = coordinator.readyNodes();
        if (ready.length === 0) {
          const snapshot = coordinator.snapshot();
          const pending = snapshot.filter((state) => state.status === 'pending');
          if (pending.length > 0) return this.report(plan, coordinator, budget, resolved, 'waiting_for_gate');
          const status = snapshot.every((state) => state.status === 'succeeded') ? 'succeeded'
            : snapshot.some((state) => state.status === 'cancelled') ? 'cancelled' : 'failed';
          return this.report(plan, coordinator, budget, resolved, status);
        }
        await Promise.all(ready.map((node) => this.executeNode(
          plan, node, coordinator, budget, outputs, controller.signal, delay, options.authorizeRetry
        )));
      }
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }

  private async executeNode(
    plan: OrchestrationPlan,
    node: OrchestrationNode,
    coordinator: OrchestrationCoordinator,
    totalBudget: BudgetTracker,
    outputs: Map<string, { runId: string; artifactId?: string }>,
    signal: AbortSignal,
    delay: (milliseconds: number, signal: AbortSignal) => Promise<void>,
    authorizeRetry: OrchestrationRunOptions['authorizeRetry']
  ): Promise<void> {
    coordinator.assertProviderDeclared(node.providerId);
    const nodeBudget = new BudgetTracker(node.budget);
    let attempt = coordinator.start(node.id).attempts;
    while (true) {
      if (signal.aborted) { coordinator.fail(node.id, 'cancelled', 'cancelled', 'orchestration_cancelled'); return; }
      try {
        nodeBudget.consume({ iterations: 1 });
        totalBudget.consume({ iterations: 1 });
      } catch {
        coordinator.fail(node.id, 'policy_blocked', 'policy_blocked', 'budget_exceeded:iterations');
        return;
      }
      const inputs = Object.fromEntries(node.inputRefs.map((reference) => {
        const produced = outputs.get(reference);
        return [reference, produced
          ? { source: 'node_output' as const, runId: produced.runId, artifactId: produced.artifactId }
          : { source: 'workflow_input' as const }];
      }));
      let result: OrchestrationNodeExecutionResult;
      try {
        result = await this.executor.execute({
          workflowId: plan.id, workflowVersion: plan.version, node: structuredClone(node), attempt,
          inputs, signal
        });
      } catch {
        result = { status: 'failed', runId: `failed-${node.id}-${attempt}`, failureCategory: 'unknown', reason: 'executor_rejected' };
      }
      const usage = { ...result.usage };
      delete usage.iterations;
      try {
        nodeBudget.consume(usage);
        totalBudget.consume(usage);
      } catch {
        coordinator.fail(node.id, 'policy_blocked', 'policy_blocked', 'budget_exceeded:usage');
        return;
      }
      if (result.status === 'succeeded') {
        const artifacts = result.artifacts ?? {};
        if (Object.keys(artifacts).some((key) => !node.outputRefs.includes(key))) {
          coordinator.fail(node.id, 'policy_blocked', 'validation', 'undeclared_output_ref');
          return;
        }
        coordinator.complete(node.id, result.runId, artifacts);
        for (const reference of node.outputRefs) outputs.set(reference, { runId: result.runId, artifactId: artifacts[reference] });
        return;
      }
      if (result.status === 'cancelled' || result.status === 'policy_blocked') {
        coordinator.fail(node.id, result.status, result.failureCategory ?? result.status, safeReason(result.reason));
        return;
      }
      const category = result.failureCategory ?? 'unknown';
      const authorization = node.sideEffect === 'none' ? undefined : await authorizeRetry?.({ node: structuredClone(node), attempt, category });
      const retry = decideRetry({
        node, category, attempt,
        hasFreshApproval: authorization?.hasFreshApproval,
        secureIdempotencyCheckPassed: authorization?.secureIdempotencyCheckPassed
      });
      if (!retry.retry || !nodeBudget.canStart(node.sideEffect, { iterations: 1 }) || !totalBudget.canStart(node.sideEffect, { iterations: 1 })) {
        coordinator.fail(node.id, 'failed', category, safeReason(result.reason ?? retry.reason));
        return;
      }
      try { await delay(retry.delayMs, signal); }
      catch { coordinator.fail(node.id, 'cancelled', 'cancelled', 'orchestration_cancelled'); return; }
      attempt = coordinator.retry(node.id).attempts;
    }
  }

  private report(
    plan: OrchestrationPlan,
    coordinator: OrchestrationCoordinator,
    budget: BudgetTracker,
    resolved: Set<string>,
    status: OrchestrationExecutionReport['status']
  ): OrchestrationExecutionReport {
    return {
      workflowId: plan.id,
      workflowVersion: plan.version,
      status,
      nodes: coordinator.snapshot(),
      budget: budget.snapshot(),
      unresolvedGates: plan.nodes.flatMap((node) => node.gates
        .filter((gate) => !resolved.has(`${node.id}:${gate}`))
        .map((gate) => ({ nodeId: node.id, gate })))
    };
  }
}
