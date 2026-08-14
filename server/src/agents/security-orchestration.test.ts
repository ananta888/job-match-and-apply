import { describe, expect, it } from 'vitest';
import {
  BudgetTracker,
  decideRetry,
  fanInWithoutMajority,
  OrchestrationCoordinator,
  type OrchestrationNode,
  type OrchestrationPlan,
  validateOrchestrationPlan,
} from './security-orchestration.js';

const budget = { wallTimeMs: 10_000, tokens: 1_000, costMicros: 100, toolCalls: 10, iterations: 2 };
const retry = { maxAttempts: 2, initialBackoffMs: 100, maxBackoffMs: 1_000, transientCategories: ['rate_limit', 'transport_interrupted'] as const };

function node(overrides: Partial<OrchestrationNode> & Pick<OrchestrationNode, 'id'>): OrchestrationNode {
  const { id, ...rest } = overrides;
  return {
    id, role: 'reviewer', providerId: 'fake', dependsOn: [], inputRefs: ['job'], outputRefs: [`${id}-out`], gates: [],
    contextIsolationKey: `ctx-${id}`, declaredIndependentAgent: false, sideEffect: 'none', budget, retry,
    failureStrategy: 'continue_unrelated', ...rest,
  };
}

function plan(nodes: OrchestrationNode[]): OrchestrationPlan {
  return {
    id: 'application-review', version: '1.0.0', allowedProviders: ['fake'], inputRefs: ['job'],
    totalBudget: { wallTimeMs: 100_000, tokens: 20_000, costMicros: 10_000, toolCalls: 100, iterations: 20 }, nodes,
  };
}

describe('orchestration plan validation', () => {
  it('builds deterministic parallel levels and provenance-safe dependencies', () => {
    const validated = validateOrchestrationPlan(plan([
      node({ id: 'author', declaredIndependentAgent: true }),
      node({ id: 'evidence', declaredIndependentAgent: true }),
      node({ id: 'finalizer', dependsOn: ['author', 'evidence'], inputRefs: ['author-out', 'evidence-out'] }),
    ]));
    expect(validated.parallelLevels).toEqual([['author', 'evidence'], ['finalizer']]);
    expect(validated.independentAgentNodeIds).toEqual(['author', 'evidence']);
  });

  it('rejects cycles, undeclared providers/inputs and hidden child-provider use', () => {
    expect(() => validateOrchestrationPlan(plan([
      node({ id: 'a', dependsOn: ['b'] }),
      node({ id: 'b', dependsOn: ['a'] }),
    ]))).toThrow('dependency_cycle');
    expect(() => validateOrchestrationPlan(plan([node({ id: 'a', providerId: 'undeclared' })]))).toThrow('provider_undeclared');
    expect(() => validateOrchestrationPlan(plan([node({ id: 'a', inputRefs: ['missing'] })]))).toThrow('input_ref_missing');
    const coordinator = new OrchestrationCoordinator(validateOrchestrationPlan(plan([node({ id: 'a' })])));
    expect(() => coordinator.assertProviderDeclared('other')).toThrow('undeclared_child_provider');
  });

  it('only labels truly isolated root contexts as independent agents', () => {
    expect(() => validateOrchestrationPlan(plan([
      node({ id: 'a', declaredIndependentAgent: true, contextIsolationKey: 'shared' }),
      node({ id: 'b', declaredIndependentAgent: true, contextIsolationKey: 'shared' }),
    ]))).toThrow('independent_agent_context_reused');
    expect(() => validateOrchestrationPlan(plan([
      node({ id: 'a' }),
      node({ id: 'b', dependsOn: ['a'], inputRefs: ['a-out'], declaredIndependentAgent: true }),
    ]))).toThrow('independent_agent_has_dependency');
  });

  it('rejects non-idempotent retries without a declared idempotency key', () => {
    expect(() => validateOrchestrationPlan(plan([node({ id: 'send', sideEffect: 'non_idempotent' })])))
      .toThrow('non_idempotent_retry_without_idempotency_key');
  });
});

describe('orchestration execution', () => {
  it('requires gates, tracks provenance and propagates policy blocks to dependents only', () => {
    const validated = validateOrchestrationPlan(plan([
      node({ id: 'a', gates: ['evidence_complete'] }),
      node({ id: 'b', dependsOn: ['a'], inputRefs: ['a-out'] }),
      node({ id: 'unrelated' }),
    ]));
    const coordinator = new OrchestrationCoordinator(validated);
    expect(coordinator.readyNodes().map((entry) => entry.id)).toEqual(['unrelated']);
    coordinator.resolveGate('a', 'evidence_complete');
    expect(coordinator.readyNodes().map((entry) => entry.id).sort()).toEqual(['a', 'unrelated']);
    coordinator.start('a');
    coordinator.fail('a', 'policy_blocked', 'policy_blocked', 'incognito');
    expect(coordinator.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'b', status: 'skipped', reason: 'dependency_failed:a' }),
      expect.objectContaining({ nodeId: 'unrelated', status: 'pending' }),
    ]));
    coordinator.start('unrelated');
    coordinator.complete('unrelated', 'run-u', { 'unrelated-out': 'artifact-u' });
    expect(coordinator.snapshot().find((state) => state.nodeId === 'unrelated')?.outputProvenance)
      .toEqual([{ outputRef: 'unrelated-out', runId: 'run-u', artifactId: 'artifact-u' }]);
  });
});

describe('budget, retry and conflicts', () => {
  it('atomically refuses budget overruns and blocks further side effects', () => {
    const tracker = new BudgetTracker({ wallTimeMs: 100, tokens: 10, costMicros: 10, toolCalls: 2, iterations: 2 });
    tracker.consume({ tokens: 8, toolCalls: 1 });
    expect(() => tracker.consume({ tokens: 3 })).toThrow('budget_exceeded:tokens');
    expect(tracker.snapshot().tokens).toBe(8);
    expect(tracker.canStart('non_idempotent')).toBe(false);
  });

  it('retries only declared transient failures and protects non-idempotent actions', () => {
    const readNode = node({ id: 'read' });
    expect(decideRetry({ node: readNode, category: 'rate_limit', attempt: 1 })).toMatchObject({ retry: true, delayMs: 100 });
    expect(decideRetry({ node: readNode, category: 'validation', attempt: 1 })).toMatchObject({ retry: false, reason: 'non_transient_failure' });
    const sendNode = node({ id: 'send', sideEffect: 'non_idempotent', idempotencyKey: 'idem-1' });
    expect(decideRetry({ node: sendNode, category: 'transport_interrupted', attempt: 1 })).toMatchObject({ retry: false, requiresNewApproval: true });
    expect(decideRetry({ node: sendNode, category: 'transport_interrupted', attempt: 1, hasFreshApproval: true, secureIdempotencyCheckPassed: true }))
      .toMatchObject({ retry: true, requiresNewApproval: true });
  });

  it('merges only equivalent results and retains contradictory variants without majority fiction', () => {
    const equivalent = fanInWithoutMajority([
      { nodeId: 'a', runId: 'run-a', providerId: 'p1', value: { answer: 1 }, sources: ['s1'] },
      { nodeId: 'b', runId: 'run-b', providerId: 'p2', value: { answer: 1 }, sources: ['s2'] },
    ]);
    expect(equivalent.state).toBe('equivalent');
    const conflict = fanInWithoutMajority([
      { nodeId: 'a', runId: 'run-a', providerId: 'p1', value: { status: 'yes' }, sources: ['s1'] },
      { nodeId: 'b', runId: 'run-b', providerId: 'p2', value: { status: 'no' }, sources: ['s2'] },
      { nodeId: 'c', runId: 'run-c', providerId: 'p3', value: { status: 'yes' }, sources: ['s3'] },
    ]);
    expect(conflict).toMatchObject({ state: 'conflict', requiresDomainResolution: true });
    expect(conflict.variants).toHaveLength(3);
  });
});
