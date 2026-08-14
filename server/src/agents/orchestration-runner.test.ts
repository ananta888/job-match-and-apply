import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationNode, OrchestrationPlan } from './security-orchestration.js';
import { OrchestrationRunner, type OrchestrationNodeExecutor } from './orchestration-runner.js';

const budget = { wallTimeMs: 10_000, tokens: 1_000, costMicros: 1_000, toolCalls: 10, iterations: 2 };
const retry = { maxAttempts: 2, initialBackoffMs: 10, maxBackoffMs: 20, transientCategories: ['transport_interrupted'] as const };
function node(id: string, overrides: Partial<OrchestrationNode> = {}): OrchestrationNode {
  return { id, role: id, providerId: 'fake', dependsOn: [], inputRefs: ['source'], outputRefs: [`${id}-out`], gates: [], contextIsolationKey: id, declaredIndependentAgent: true, sideEffect: 'none', budget, retry, failureStrategy: 'continue_unrelated', ...overrides };
}
function plan(nodes: OrchestrationNode[]): OrchestrationPlan {
  return { id: 'flow', version: '1.0.0', allowedProviders: ['fake'], inputRefs: ['source'], totalBudget: { wallTimeMs: 60_000, tokens: 5_000, costMicros: 5_000, toolCalls: 50, iterations: 10 }, nodes };
}

describe('OrchestrationRunner', () => {
  it('runs independent roots in parallel and passes only declared provenance to a dependent node', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let active = 0; let maximum = 0;
    const executor: OrchestrationNodeExecutor = { async execute(request) {
      active += 1; maximum = Math.max(maximum, active);
      if (active === 2) release();
      if (request.node.id !== 'final') await barrier;
      active -= 1;
      if (request.node.id === 'final') {
        expect(request.inputs).toMatchObject({ 'a-out': { source: 'node_output', runId: 'run-a' }, 'b-out': { source: 'node_output', runId: 'run-b' } });
      }
      return { status: 'succeeded', runId: `run-${request.node.id}`, artifacts: Object.fromEntries(request.node.outputRefs.map((ref) => [ref, `artifact-${ref}`])), usage: { tokens: 10 } };
    } };
    const report = await new OrchestrationRunner(executor).run(plan([
      node('a'), node('b'), node('final', { dependsOn: ['a', 'b'], inputRefs: ['a-out', 'b-out'], declaredIndependentAgent: false })
    ]));
    expect(maximum).toBe(2);
    expect(report.status).toBe('succeeded');
    expect(report.nodes.find((entry) => entry.nodeId === 'final')?.outputProvenance[0]).toMatchObject({ runId: 'run-final' });
  });

  it('waits for unresolved gates without starting a provider', async () => {
    const execute = vi.fn();
    const gated = node('gated', { gates: ['user_input'] });
    const waiting = await new OrchestrationRunner({ execute }).run(plan([gated]));
    expect(waiting).toMatchObject({ status: 'waiting_for_gate', unresolvedGates: [{ nodeId: 'gated', gate: 'user_input' }] });
    expect(execute).not.toHaveBeenCalled();
  });

  it('retries only classified transient reads and rejects undeclared outputs', async () => {
    let calls = 0;
    const report = await new OrchestrationRunner({ async execute(request) {
      calls += 1;
      if (calls === 1) return { status: 'failed', runId: 'run-1', failureCategory: 'transport_interrupted', reason: 'transport_interrupted' };
      return { status: 'succeeded', runId: 'run-2', artifacts: { unexpected: 'artifact' } };
    } }).run(plan([node('read')]), { delay: async () => undefined });
    expect(calls).toBe(2);
    expect(report.status).toBe('failed');
    expect(report.nodes[0]).toMatchObject({ status: 'policy_blocked', reason: 'undeclared_output_ref', attempts: 2 });
  });

  it('may retry a classified idempotent local action within its attempt budget', async () => {
    const execute = vi.fn(async () => ({ status: 'failed' as const, runId: 'run', failureCategory: 'transport_interrupted' as const }));
    const sideEffect = node('write', { sideEffect: 'idempotent_local', declaredIndependentAgent: false });
    const report = await new OrchestrationRunner({ execute }).run(plan([sideEffect]), { delay: async () => undefined });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(report.status).toBe('failed');
  });
});
