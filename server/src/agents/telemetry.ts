import type { AgentRunState, UsageSnapshot } from '../ports/agent-runner.js';

export interface AgentUsageMeasurement extends UsageSnapshot {
  provider: string;
  providerVersion?: string;
  source: 'provider' | 'estimated' | 'unknown';
  capturedAt: string;
  runDurationMs?: number;
  toolCalls?: number;
  templateId?: string;
  workflowId?: string;
  /** Integer micros avoid presenting floating point estimates as exact money. */
  reportedCost?: { amountMicros: number; currency: string; source: 'provider' | 'estimated' };
}

export interface AgentUsageBudgetLimits {
  maxTotalTokens?: number;
  maxToolCalls?: number;
  maxRunDurationMs?: number;
  maxCostMicros?: { amountMicros: number; currency: string };
  warningAtPercent?: number;
}

export interface AgentUsageBudgetEvaluation {
  state: 'ok' | 'warning' | 'exceeded' | 'unknown';
  checks: Array<{ metric: 'tokens' | 'tool_calls' | 'duration' | 'cost'; value: number; limit: number; unit: string; source: AgentUsageMeasurement['source'] | 'provider' | 'estimated'; state: 'ok' | 'warning' | 'exceeded' }>;
  unknownMetrics: Array<'tokens' | 'tool_calls' | 'duration' | 'cost'>;
}

export interface AgentUsageTrend {
  groupBy: 'provider' | 'template' | 'workflow';
  groups: Array<{
    key: string;
    runs: number;
    known: { tokens: number; toolCalls: number; durationMs: number };
    unknown: { tokens: number; toolCalls: number; durationMs: number; cost: number };
    costs: Array<{ currency: string; amountMicros: number; providerReportedRuns: number; estimatedRuns: number }>;
  }>;
}

export interface AgentUsageMetricPoint {
  name: 'input_tokens' | 'cached_input_tokens' | 'output_tokens' | 'reasoning_tokens' | 'total_tokens' | 'tool_calls' | 'run_duration' | 'reported_cost';
  value: number | null;
  unit: 'tokens' | 'calls' | 'milliseconds' | 'currency_micros';
  currency?: string;
  source: 'provider' | 'estimated' | 'unknown';
  capturedAt: string;
  provider: string;
  providerVersion: string | 'unknown';
}

export interface AgentTelemetrySnapshot {
  generatedAt: string;
  queueDepth: number;
  activeRuns: number;
  totals: {
    started: number;
    terminal: Record<Extract<AgentRunState, 'succeeded' | 'failed' | 'timed_out' | 'cancelled'>, number>;
    approvals: number;
    approvalWaitMs: number;
    streamReconnects: number;
    streamLagMs?: { last: number; max: number };
    recoveries: number;
    errors?: number;
  };
  providerRuns: Record<string, number>;
}

const SAFE_PROVIDER = /^[a-z][a-z0-9-]{0,63}$/;

/** Local, bounded, metadata-only metrics. It intentionally accepts no prompts or event payloads. */
export class AgentTelemetry {
  private queueDepth = 0;
  private activeRuns = 0;
  private started = 0;
  private readonly terminal = { succeeded: 0, failed: 0, timed_out: 0, cancelled: 0 };
  private approvals = 0;
  private approvalWaitMs = 0;
  private streamReconnects = 0;
  private streamLagLastMs = 0;
  private streamLagMaxMs = 0;
  private recoveries = 0;
  private errors = 0;
  private readonly providerRuns = new Map<string, number>();
  private readonly usage = new Map<string, AgentUsageMeasurement>();

  setQueueDepth(value: number): void { this.queueDepth = boundedInteger(value, 0, 100_000); }

  runStarted(provider: string): void {
    if (!SAFE_PROVIDER.test(provider)) throw new Error('telemetry_provider_invalid');
    this.started += 1;
    this.activeRuns += 1;
    this.providerRuns.set(provider, (this.providerRuns.get(provider) ?? 0) + 1);
  }

  runTerminal(state: keyof typeof this.terminal): void {
    this.terminal[state] += 1;
    this.activeRuns = Math.max(0, this.activeRuns - 1);
  }

  approvalResolved(waitMs: number): void { this.approvals += 1; this.approvalWaitMs += boundedInteger(waitMs, 0, 365 * 24 * 60 * 60_000); }
  streamReconnected(): void { this.streamReconnects += 1; }
  observeStreamLag(value: number): void {
    const lag = boundedInteger(value, 0, 24 * 60 * 60_000);
    this.streamLagLastMs = lag; this.streamLagMaxMs = Math.max(this.streamLagMaxMs, lag);
  }
  recovered(): void { this.recoveries += 1; }
  errorObserved(): void { this.errors += 1; }

  recordUsage(runId: string, measurement: AgentUsageMeasurement): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || !SAFE_PROVIDER.test(measurement.provider)) throw new Error('telemetry_usage_identity_invalid');
    if (!['provider', 'estimated', 'unknown'].includes(measurement.source)) throw new Error('telemetry_usage_source_invalid');
    if (!measurement.capturedAt || !Number.isFinite(Date.parse(measurement.capturedAt))) throw new Error('telemetry_captured_at_invalid');
    for (const value of [measurement.inputTokens, measurement.cachedInputTokens, measurement.outputTokens, measurement.reasoningTokens, measurement.totalTokens, measurement.runDurationMs, measurement.toolCalls]) {
      if (value !== undefined) boundedInteger(value, 0, Number.MAX_SAFE_INTEGER);
    }
    if (measurement.providerVersion !== undefined && !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(measurement.providerVersion)) throw new Error('telemetry_provider_version_invalid');
    for (const dimension of [measurement.templateId, measurement.workflowId]) {
      if (dimension !== undefined && !/^[a-z][a-z0-9._-]{1,127}$/.test(dimension)) throw new Error('telemetry_dimension_invalid');
    }
    if (measurement.reportedCost) {
      boundedInteger(measurement.reportedCost.amountMicros, 0, Number.MAX_SAFE_INTEGER);
      if (!/^[A-Z]{3}$/.test(measurement.reportedCost.currency)) throw new Error('telemetry_currency_invalid');
      if (!['provider', 'estimated'].includes(measurement.reportedCost.source)) throw new Error('telemetry_usage_source_invalid');
    }
    this.usage.set(runId, structuredClone(measurement));
    if (this.usage.size > 2_000) this.usage.delete(this.usage.keys().next().value as string);
  }

  usageFor(runId: string): AgentUsageMeasurement | undefined { const value = this.usage.get(runId); return value && structuredClone(value); }

  /** Normalized points always carry unit, source, timestamp and provider version, including unknowns. */
  metricPointsFor(runId: string): AgentUsageMetricPoint[] {
    const measurement = this.usage.get(runId);
    if (!measurement) return [];
    const base = {
      capturedAt: measurement.capturedAt, provider: measurement.provider,
      providerVersion: measurement.providerVersion ?? 'unknown' as const
    };
    const point = (name: AgentUsageMetricPoint['name'], value: number | undefined, unit: AgentUsageMetricPoint['unit']): AgentUsageMetricPoint => ({
      name, value: value ?? null, unit, source: value === undefined ? 'unknown' : measurement.source, ...base
    });
    const points = [
      point('input_tokens', measurement.inputTokens, 'tokens'), point('cached_input_tokens', measurement.cachedInputTokens, 'tokens'),
      point('output_tokens', measurement.outputTokens, 'tokens'), point('reasoning_tokens', measurement.reasoningTokens, 'tokens'),
      point('total_tokens', measurement.totalTokens, 'tokens'), point('tool_calls', measurement.toolCalls, 'calls'),
      point('run_duration', measurement.runDurationMs, 'milliseconds')
    ];
    points.push({
      name: 'reported_cost', value: measurement.reportedCost?.amountMicros ?? null, unit: 'currency_micros',
      currency: measurement.reportedCost?.currency,
      source: measurement.reportedCost?.source ?? 'unknown', ...base
    });
    return points;
  }

  evaluateBudget(runId: string, limits: AgentUsageBudgetLimits): AgentUsageBudgetEvaluation {
    const measurement = this.usage.get(runId);
    if (!measurement) return { state: 'unknown', checks: [], unknownMetrics: ['tokens', 'tool_calls', 'duration', 'cost'] };
    const warningAtPercent = limits.warningAtPercent ?? 80;
    if (!Number.isSafeInteger(warningAtPercent) || warningAtPercent < 1 || warningAtPercent > 100) throw new Error('telemetry_warning_threshold_invalid');
    const checks: AgentUsageBudgetEvaluation['checks'] = [];
    const unknownMetrics: AgentUsageBudgetEvaluation['unknownMetrics'] = [];
    const add = (
      metric: AgentUsageBudgetEvaluation['checks'][number]['metric'], value: number | undefined,
      limit: number | undefined, unit: string, source: AgentUsageBudgetEvaluation['checks'][number]['source'],
    ) => {
      if (limit === undefined) return;
      boundedInteger(limit, 0, Number.MAX_SAFE_INTEGER);
      if (value === undefined) { unknownMetrics.push(metric); return; }
      const state = value > limit ? 'exceeded' : value * 100 >= limit * warningAtPercent ? 'warning' : 'ok';
      checks.push({ metric, value, limit, unit, source, state });
    };
    add('tokens', measurement.totalTokens, limits.maxTotalTokens, 'tokens', measurement.source);
    add('tool_calls', measurement.toolCalls, limits.maxToolCalls, 'calls', measurement.source);
    add('duration', measurement.runDurationMs, limits.maxRunDurationMs, 'ms', measurement.source);
    if (limits.maxCostMicros) {
      if (!/^[A-Z]{3}$/.test(limits.maxCostMicros.currency)) throw new Error('telemetry_currency_invalid');
      if (measurement.reportedCost && measurement.reportedCost.currency !== limits.maxCostMicros.currency) unknownMetrics.push('cost');
      else add('cost', measurement.reportedCost?.amountMicros, limits.maxCostMicros.amountMicros, `micros:${limits.maxCostMicros.currency}`, measurement.reportedCost?.source ?? measurement.source);
    }
    const state = checks.some((entry) => entry.state === 'exceeded') ? 'exceeded'
      : checks.some((entry) => entry.state === 'warning') ? 'warning'
        : unknownMetrics.length > 0 && checks.length === 0 ? 'unknown' : 'ok';
    return { state, checks, unknownMetrics };
  }

  usageTrend(groupBy: AgentUsageTrend['groupBy']): AgentUsageTrend {
    const grouped = new Map<string, AgentUsageMeasurement[]>();
    for (const measurement of this.usage.values()) {
      const key = groupBy === 'provider' ? measurement.provider
        : groupBy === 'template' ? measurement.templateId ?? 'unknown'
          : measurement.workflowId ?? 'unknown';
      const entries = grouped.get(key) ?? []; entries.push(measurement); grouped.set(key, entries);
    }
    return {
      groupBy,
      groups: [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, entries]) => {
        const costs = new Map<string, { currency: string; amountMicros: number; providerReportedRuns: number; estimatedRuns: number }>();
        for (const entry of entries) if (entry.reportedCost) {
          const aggregate = costs.get(entry.reportedCost.currency) ?? { currency: entry.reportedCost.currency, amountMicros: 0, providerReportedRuns: 0, estimatedRuns: 0 };
          aggregate.amountMicros += entry.reportedCost.amountMicros;
          aggregate[entry.reportedCost.source === 'provider' ? 'providerReportedRuns' : 'estimatedRuns'] += 1;
          costs.set(entry.reportedCost.currency, aggregate);
        }
        return {
          key, runs: entries.length,
          known: {
            tokens: entries.reduce((sum, entry) => sum + (entry.totalTokens ?? 0), 0),
            toolCalls: entries.reduce((sum, entry) => sum + (entry.toolCalls ?? 0), 0),
            durationMs: entries.reduce((sum, entry) => sum + (entry.runDurationMs ?? 0), 0),
          },
          unknown: {
            tokens: entries.filter((entry) => entry.totalTokens === undefined).length,
            toolCalls: entries.filter((entry) => entry.toolCalls === undefined).length,
            durationMs: entries.filter((entry) => entry.runDurationMs === undefined).length,
            cost: entries.filter((entry) => entry.reportedCost === undefined).length,
          },
          costs: [...costs.values()].sort((left, right) => left.currency.localeCompare(right.currency)),
        };
      })
    };
  }

  snapshot(now = new Date()): AgentTelemetrySnapshot {
    return {
      generatedAt: now.toISOString(), queueDepth: this.queueDepth, activeRuns: this.activeRuns,
      totals: { started: this.started, terminal: { ...this.terminal }, approvals: this.approvals, approvalWaitMs: this.approvalWaitMs, streamReconnects: this.streamReconnects, streamLagMs: { last: this.streamLagLastMs, max: this.streamLagMaxMs }, recoveries: this.recoveries, errors: this.errors },
      providerRuns: Object.fromEntries([...this.providerRuns.entries()].sort(([left], [right]) => left.localeCompare(right)))
    };
  }
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('telemetry_value_invalid');
  return value;
}
