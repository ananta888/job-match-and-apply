import { describe, expect, it } from 'vitest';
import { AgentTelemetry } from './telemetry.js';

describe('AgentTelemetry', () => {
  it('reports local provider-neutral counters without content fields', () => {
    const metrics = new AgentTelemetry();
    metrics.setQueueDepth(2);
    metrics.runStarted('fake');
    metrics.approvalResolved(1200);
    metrics.streamReconnected();
    metrics.observeStreamLag(25);
    metrics.errorObserved();
    metrics.recordUsage('run-1', { provider: 'fake', source: 'provider', capturedAt: '2026-08-13T00:00:00Z', totalTokens: 42 });
    metrics.runTerminal('succeeded');
    const snapshot = metrics.snapshot(new Date('2026-08-13T00:01:00Z'));
    expect(snapshot).toMatchObject({ queueDepth: 2, activeRuns: 0, totals: { started: 1, terminal: { succeeded: 1 }, approvals: 1, streamReconnects: 1, streamLagMs: { last: 25, max: 25 }, errors: 1 }, providerRuns: { fake: 1 } });
    expect(JSON.stringify(snapshot)).not.toMatch(/prompt|message|content|token.*42/i);
    expect(metrics.usageFor('run-1')).toMatchObject({ totalTokens: 42, source: 'provider' });
  });

  it('normalizes every measurement with unit, source, timestamp, and explicit provider-version unknowns', () => {
    const metrics = new AgentTelemetry();
    metrics.recordUsage('run-points', { provider: 'fake', source: 'estimated', capturedAt: '2026-08-14T00:00:00Z', totalTokens: 12 });
    const points = metrics.metricPointsFor('run-points');
    expect(points).toContainEqual({ name: 'total_tokens', value: 12, unit: 'tokens', source: 'estimated', capturedAt: '2026-08-14T00:00:00Z', provider: 'fake', providerVersion: 'unknown' });
    expect(points).toContainEqual({ name: 'tool_calls', value: null, unit: 'calls', source: 'unknown', capturedAt: '2026-08-14T00:00:00Z', provider: 'fake', providerVersion: 'unknown' });
    expect(points).toContainEqual({ name: 'reported_cost', value: null, unit: 'currency_micros', currency: undefined, source: 'unknown', capturedAt: '2026-08-14T00:00:00Z', provider: 'fake', providerVersion: 'unknown' });
    expect(() => metrics.recordUsage('invalid-time', { provider: 'fake', source: 'unknown', capturedAt: 'later' })).toThrow('telemetry_captured_at_invalid');
  });

  it('rejects unbounded values and unsafe provider labels', () => {
    const metrics = new AgentTelemetry();
    expect(() => metrics.runStarted('../shell')).toThrow();
    expect(() => metrics.setQueueDepth(-1)).toThrow();
  });

  it('marks unknown values instead of inventing cost and evaluates hard/warning limits with units and source', () => {
    const metrics = new AgentTelemetry();
    metrics.recordUsage('run-budget', {
      provider: 'fake', providerVersion: '1.0.0', source: 'provider', capturedAt: '2026-08-14T00:00:00Z',
      totalTokens: 800, toolCalls: 4, runDurationMs: 1_500,
      reportedCost: { amountMicros: 250_000, currency: 'EUR', source: 'estimated' }
    });
    expect(metrics.evaluateBudget('missing', { maxTotalTokens: 100 })).toMatchObject({ state: 'unknown', checks: [] });
    expect(metrics.evaluateBudget('run-budget', {
      maxTotalTokens: 1_000, maxToolCalls: 3, maxRunDurationMs: 2_000,
      maxCostMicros: { amountMicros: 500_000, currency: 'EUR' }, warningAtPercent: 80
    })).toMatchObject({
      state: 'exceeded',
      checks: expect.arrayContaining([
        expect.objectContaining({ metric: 'tokens', state: 'warning', unit: 'tokens', source: 'provider' }),
        expect.objectContaining({ metric: 'tool_calls', state: 'exceeded', unit: 'calls', source: 'provider' }),
        expect.objectContaining({ metric: 'cost', state: 'ok', unit: 'micros:EUR', source: 'estimated' })
      ])
    });
  });

  it('builds bounded provider/template/workflow trends while retaining unknown and estimated markers', () => {
    const metrics = new AgentTelemetry();
    metrics.recordUsage('run-1', { provider: 'fake', source: 'provider', capturedAt: '2026-08-14T00:00:00Z', templateId: 'job-research', workflowId: 'guided-job-analysis', totalTokens: 100, toolCalls: 1, runDurationMs: 50, reportedCost: { amountMicros: 1_000, currency: 'EUR', source: 'provider' } });
    metrics.recordUsage('run-2', { provider: 'fake', source: 'unknown', capturedAt: '2026-08-14T00:01:00Z', templateId: 'job-research', workflowId: 'guided-job-analysis' });
    expect(metrics.usageTrend('template')).toEqual({
      groupBy: 'template', groups: [{ key: 'job-research', runs: 2, known: { tokens: 100, toolCalls: 1, durationMs: 50 }, unknown: { tokens: 1, toolCalls: 1, durationMs: 1, cost: 1 }, costs: [{ currency: 'EUR', amountMicros: 1_000, providerReportedRuns: 1, estimatedRuns: 0 }] }]
    });
  });

  it('keeps private CV structuring runs out of generic usage projections', () => {
    const metrics = new AgentTelemetry();
    metrics.markPrivateRun('private-cv-run');
    metrics.recordUsage('private-cv-run', {
      provider: 'fake', source: 'provider', capturedAt: '2026-08-14T00:00:00Z',
      workflowId: 'cv-ai-structuring', totalTokens: 999,
    });
    expect(metrics.isPrivateRun('private-cv-run')).toBe(true);
    expect(metrics.usageFor('private-cv-run')).toBeUndefined();
    expect(metrics.usageTrend('workflow').groups).toEqual([]);
    metrics.forgetRun('private-cv-run');
    expect(metrics.isPrivateRun('private-cv-run')).toBe(false);
  });
});
