import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runApplicationBenchmark, writeBenchmarkReport,
  type BenchmarkCase, type BenchmarkOptions,
} from './application-benchmark.js';
import { FakeAgentProvider, type FakeAgentScript } from './fake-agent-provider.js';
import type { ProviderRunContext } from '../ports/agent-runner.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-')); roots.push(root);
  return root;
}

class PoorQualityProvider extends FakeAgentProvider {
  override async start(context: ProviderRunContext) {
    const role = /Node: ([a-z0-9-]+);/.exec(context.request.task)?.[1] ?? 'unknown';
    const script: FakeAgentScript = role === 'finalizer'
      ? { steps: [{ kind: 'agent_message_completed', data: { text: '<!doctype html><html><head><title>x</title></head><body data-result="final-agent-html"><p>Erika Private</p><script>x</script></body></html>' } }], outcome: { state: 'succeeded' } }
      : { steps: [{ kind: 'agent_message_completed', data: { text: '{"synthetic":true}' } }], outcome: { state: 'succeeded' } };
    return new FakeAgentProvider(script, 'fake').start(context);
  }
}

const baseOptions = async (overrides: Partial<BenchmarkOptions> = {}): Promise<BenchmarkOptions> => ({
  provider: 'fake',
  reasoningVariants: ['off'],
  repeats: 1,
  allowLive: false,
  artifactRoot: await artifactRoot(),
  ...overrides,
});

describe('synthetic application benchmark', () => {
  it('runs offline, separates quality from speed and never invents costs', async () => {
    const options = await baseOptions({ reasoningVariants: ['off', 'low'], repeats: 2 });
    const report = await runApplicationBenchmark(options);
    expect(report.mode).toBe('offline-fake');
    expect(report.rows).toHaveLength(8); // 2 cases × 2 variants × 2 repeats
    for (const row of report.rows) {
      expect(row.status).toBe('succeeded');
      expect(row.contractSuccess).toBe(true);
      expect(row.qualitySuccess).toBe(true);
      expect(row.costKnown).toBe(false);
      expect(row.cost).toBeNull();
      expect(row.latenciesMs.total).toBeGreaterThanOrEqual(0);
      expect(row.attemptsTotal).toBeGreaterThan(0);
    }
    expect(report.summary.qualitySuccesses).toBe(8);
    expect(report.summary.unknownCostRuns).toBe(8);
    expect(report.summary.note).toContain('ohne Modellqualitätsaussage');
    const md = await (async () => {
      const written = await writeBenchmarkReport(report, options.artifactRoot);
      return readFile(written.mdPath, 'utf8');
    })();
    expect(md).toContain('| synthetic-cv |');
    expect(md).toContain('unbekannt');
  });

  it('reports quality gaps honestly for a poor final document', async () => {
    const options = await baseOptions({
      caseIds: ['synthetic-cv'],
      providerFactory: () => new PoorQualityProvider(),
    });
    const report = await runApplicationBenchmark(options);
    const row = report.rows[0]!;
    expect(row.contractSuccess).toBe(true);
    expect(row.qualitySuccess).toBe(false);
    // The final-HTML normalizer strips active tags before storage; the visible
    // fact violation is what the quality check reports.
    expect(row.qualityGaps.join(' ')).toContain('unerwünscht: Erika Private');
    expect(report.summary.qualityFailures).toBe(1);
  });

  it('keeps live runs behind explicit opt-in and budget and marks exhausted budgets', async () => {
    const root = await artifactRoot();
    const withoutOptIn: BenchmarkOptions = {
      provider: 'openrouter', reasoningVariants: ['off'], repeats: 1, allowLive: false, artifactRoot: root,
    };
    await expect(runApplicationBenchmark(withoutOptIn)).rejects.toThrow('benchmark_live_requires_explicit_opt_in');
    const withoutBudget: BenchmarkOptions = { ...withoutOptIn, allowLive: true };
    await expect(runApplicationBenchmark(withoutBudget)).rejects.toThrow('benchmark_live_requires_budget');

    const zeroBudget: BenchmarkOptions = {
      ...withoutBudget, budgetMicros: 0, caseIds: ['synthetic-cv'],
      providerFactory: () => new FakeAgentProvider({
        steps: [{ kind: 'agent_message_completed', data: { text: 'unused' } }], outcome: { state: 'succeeded' },
      }, 'fake'),
    };
    const report = await runApplicationBenchmark(zeroBudget);
    expect(report.mode).toBe('live-http');
    expect(report.rows[0]!.status).toBe('budget_exhausted');
    expect(report.rows[0]!.contractSuccess).toBe(false);
    expect(report.rows[0]!.costKnown).toBe(false);
  });
});
