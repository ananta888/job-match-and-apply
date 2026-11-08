import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentControlCenter } from './agent-control-center.js';
import { AgentArtifactStore } from './artifact-store.js';
import { ApplicationAgentOrchestrationService } from './application-orchestration-service.js';
import { MemoryApplicationOrchestrationStore } from './application-orchestration-store.js';
import { FakeAgentProvider, type FakeAgentScript } from './fake-agent-provider.js';
import { MemoryAgentRunStore } from './run-store.js';
import { OpenRouterHttpAgentAdapter, OPENROUTER_DEFAULT_MODEL, type OpenRouterReasoning } from './openrouter-http-adapter.js';
import type { AgentRunnerPort, ProviderRunContext } from '../ports/agent-runner.js';
import type { ApplicationCase } from '../domain/models.js';

/**
 * Reproducible synthetic benchmark for the five-role evidence chain. Offline by
 * default (scripted fake provider, no costs); live model runs require an
 * explicit opt-in and a budget. Unknown costs stay unknown and are never
 * reported as zero. Quality (expected facts in the final document) and speed
 * are judged separately. Missing real measurements stay visibly open.
 */
export interface BenchmarkExpectedFacts {
  mustContain: readonly string[];
  mustNotContain: readonly string[];
}

export interface BenchmarkCase {
  id: string;
  documentType: 'cv' | 'cover_letter';
  job: ApplicationCase['job'];
  /** Content the synthetic finalizer produces for the offline path. */
  finalHtml: string;
  expected: BenchmarkExpectedFacts;
}

const SYNTHETIC_CASES: readonly BenchmarkCase[] = [
  {
    id: 'synthetic-cv',
    documentType: 'cv',
    job: {
      id: 'job-bench-1', sourceId: 'benchmark', title: 'Synthetische Stelle', company: 'Benchmark GmbH',
      location: 'Berlin', workModel: 'remote', employmentType: 'full_time', description: 'Synthetische Beschreibung', skills: ['Synthetic'],
    } as ApplicationCase['job'],
    finalHtml: '<!doctype html><html lang="de"><head><title>CV</title></head><body data-result="final-agent-html"><h1>Max Mustermann</h1><p>Station: Benchmark GmbH</p></body></html>',
    expected: {
      mustContain: ['Benchmark GmbH', '<!doctype html>'],
      mustNotContain: ['Erika Private', '<script'],
    },
  },
  {
    id: 'synthetic-cover-letter',
    documentType: 'cover_letter',
    job: {
      id: 'job-bench-2', sourceId: 'benchmark', title: 'Synthetische Anschreibenstelle', company: 'Brief GmbH',
      location: 'München', workModel: 'hybrid', employmentType: 'full_time', description: 'Synthetische Anforderung', skills: ['Synthetic'],
    } as ApplicationCase['job'],
    finalHtml: '<!doctype html><html lang="de"><head><title>Anschreiben</title></head><body data-result="final-agent-html"><p>Sehr geehrte Damen und Herren, meine Station bei der Brief GmbH …</p></body></html>',
    expected: {
      mustContain: ['Brief GmbH', '<!doctype html>'],
      mustNotContain: ['Erfunden', '<iframe'],
    },
  },
];

export interface BenchmarkRow {
  caseId: string;
  documentType: string;
  provider: string;
  model: string;
  requestedReasoning: string;
  effectiveReasoning: string | null;
  repeat: number;
  status: string;
  contractSuccess: boolean;
  qualitySuccess: boolean;
  qualityGaps: string[];
  questionsAsked: number;
  attemptsTotal: number;
  latenciesMs: { total: number; perNode: Record<string, number> };
  nodeStates: Record<string, { status: string; attempts: number; failureCategory?: string; reason?: string }>;
  tokens: { input: number; output: number; total: number } | null;
  cost: { micros: number; estimated: boolean } | null;
  costKnown: boolean;
  modelCheck?: { exists: boolean; reasoningSupported: boolean | null; note: string };
  error?: string;
}

export interface BenchmarkReport {
  contract: 'application-benchmark-report';
  contractVersion: '1.0';
  generatedAt: string;
  mode: 'offline-fake' | 'live-http';
  rows: BenchmarkRow[];
  summary: {
    runs: number;
    contractSuccesses: number;
    qualitySuccesses: number;
    qualityFailures: number;
    unknownCostRuns: number;
    medianTotalLatencyMs: number | null;
    note: string;
  };
}

export interface BenchmarkOptions {
  provider: 'fake' | 'openrouter';
  model?: string;
  reasoningVariants: readonly OpenRouterReasoning[];
  repeats: number;
  budgetMicros?: number;
  allowLive: boolean;
  caseIds?: readonly string[];
  /** Test seam: replaces the scripted fake provider factory. */
  providerFactory?: (caseItem: BenchmarkCase) => AgentRunnerPort;
  artifactRoot: string;
  now?: () => Date;
}

/** Per-role scripted offline provider: the finalizer emits the case's synthetic HTML. */
class BenchmarkFakeProvider extends FakeAgentProvider {
  private readonly caseItem: BenchmarkCase;

  constructor(caseItem: BenchmarkCase) {
    super({ steps: [{ kind: 'agent_message_completed', data: { text: 'offline synthetic output' } }], outcome: { state: 'succeeded' } }, 'fake');
    this.caseItem = caseItem;
  }

  override async start(context: ProviderRunContext) {
    const role = /Node: ([a-z0-9-]+);/.exec(context.request.task)?.[1] ?? 'unknown';
    const script: FakeAgentScript = role === 'finalizer'
      ? { steps: [{ kind: 'agent_message_completed', data: { text: this.caseItem.finalHtml } }], outcome: { state: 'succeeded' } }
      : { steps: [{ kind: 'agent_message_completed', data: { text: `{"synthetic":"${role}"}` } }], outcome: { state: 'succeeded' } };
    const delegate = new FakeAgentProvider(script, 'fake');
    return delegate.start(context);
  }
}

export async function runApplicationBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const now = options.now ?? (() => new Date());
  const live = options.provider === 'openrouter';
  if (live && !options.allowLive) {
    throw new Error('benchmark_live_requires_explicit_opt_in');
  }
  if (live && options.budgetMicros === undefined) {
    throw new Error('benchmark_live_requires_budget');
  }
  const caseItems = SYNTHETIC_CASES.filter((item) => !options.caseIds || options.caseIds.includes(item.id));
  if (!caseItems.length) throw new Error('benchmark_no_cases');
  await mkdir(options.artifactRoot, { recursive: true, mode: 0o700 });
  const rows: BenchmarkRow[] = [];
  let spentMicros = 0;
  for (const caseItem of caseItems) {
    for (const reasoning of options.reasoningVariants) {
      for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
        if (live && options.budgetMicros !== undefined && spentMicros >= options.budgetMicros) {
          rows.push({
            caseId: caseItem.id, documentType: caseItem.documentType, provider: options.provider,
            model: options.model ?? OPENROUTER_DEFAULT_MODEL,
            requestedReasoning: reasoning, effectiveReasoning: null, repeat,
            status: 'budget_exhausted', contractSuccess: false, qualitySuccess: false,
            qualityGaps: ['Budget erreicht; Lauf wurde nicht gestartet.'], questionsAsked: 0, attemptsTotal: 0,
            latenciesMs: { total: 0, perNode: {} }, nodeStates: {}, tokens: null, cost: null, costKnown: false,
          });
          continue;
        }
        rows.push(await runSingleBenchmarkCase(caseItem, options, reasoning, repeat, now, (micros) => { spentMicros += micros; }));
      }
    }
  }
  const latencies = rows.filter((row) => row.status === 'succeeded').map((row) => row.latenciesMs.total).sort((a, b) => a - b);
  const report: BenchmarkReport = {
    contract: 'application-benchmark-report',
    contractVersion: '1.0',
    generatedAt: now().toISOString(),
    mode: live ? 'live-http' : 'offline-fake',
    rows,
    summary: {
      runs: rows.length,
      contractSuccesses: rows.filter((row) => row.contractSuccess).length,
      qualitySuccesses: rows.filter((row) => row.qualitySuccess).length,
      qualityFailures: rows.filter((row) => !row.qualitySuccess).length,
      unknownCostRuns: rows.filter((row) => !row.costKnown).length,
      medianTotalLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null,
      note: live
        ? 'Live-Lauf gegen den Anbieter; Kosten gemäß gemeldeter Nutzung, unbekannte Kosten bleiben unbekannt.'
        : 'Offline-Synthetic-Lauf ohne Modellqualitätsaussage. Echte Modellqualität bleibt offen, bis ein Opt-in-Lauf erfolgt.',
    },
  };
  return report;
}

async function runSingleBenchmarkCase(
  caseItem: BenchmarkCase,
  options: BenchmarkOptions,
  reasoning: OpenRouterReasoning,
  repeat: number,
  now: () => Date,
  onCost: (micros: number) => void,
): Promise<BenchmarkRow> {
  const provider = options.providerFactory
    ? options.providerFactory(caseItem)
    : options.provider === 'fake'
      ? new BenchmarkFakeProvider(caseItem)
      : new OpenRouterHttpAgentAdapter({ defaultModel: options.model ?? OPENROUTER_DEFAULT_MODEL });
  const artifacts = new AgentArtifactStore(join(options.artifactRoot, 'artifacts'));
  const center = new AgentControlCenter(new MemoryAgentRunStore(), [provider], {
    maxParallel: 4, maxParallelPerProvider: 4, allowedWorkspaceRoots: [options.artifactRoot],
  });
  const service = new ApplicationAgentOrchestrationService(
    center,
    artifacts,
    new MemoryApplicationOrchestrationStore(),
    {
      evidenceComplete: async () => ({ complete: true, bindingSha256: 'a'.repeat(64) }),
      verifyRevisionConfirmation: async () => ({ valid: true, bindingSha256: 'b'.repeat(64) }),
    },
    {
      resolve: async ({ reference }: { reference: string }) => ({
        content: JSON.stringify({ reference, synthetic: true, documentType: caseItem.documentType }),
      }),
    },
    { runPersistenceProtection: 'ephemeral', pollIntervalMs: 5 },
  );
  const row: BenchmarkRow = {
    caseId: caseItem.id, documentType: caseItem.documentType, provider: options.provider,
    model: options.model ?? OPENROUTER_DEFAULT_MODEL,
    requestedReasoning: reasoning, effectiveReasoning: reasoning, repeat,
    status: 'running', contractSuccess: false, qualitySuccess: false, qualityGaps: [],
    questionsAsked: 0, attemptsTotal: 0,
    latenciesMs: { total: 0, perNode: {} }, nodeStates: {}, tokens: null, cost: null, costKnown: false,
  };
  const started = Date.now();
  try {
    const record = await service.create({
      workflowId: 'evidence-application-package',
      providerId: provider.provider,
      workspaceRoot: options.artifactRoot,
      runtimeTarget: 'linux',
      model: options.model ?? OPENROUTER_DEFAULT_MODEL,
      ownerId: 'benchmark',
      prompt: `Benchmark ${caseItem.id} (synthetic).`,
      scope: {
        applicationCaseId: 'case-benchmark-1',
        applicationCaseRevision: 1,
        jobId: caseItem.job.id,
        companyKey: 'benchmark-gmbh',
        workspaceRootId: 'benchmark',
        identityMode: 'real',
      },
      claimIds: ['claim-benchmark-1'],
      confirmations: [],
    });
    let current = record;
    // Offline fake chains settle in seconds; live HTTP chains may need minutes.
    const deadline = Date.now() + (options.provider === 'openrouter' ? 15 * 60_000 : 60_000);
    while (!['succeeded', 'failed', 'cancelled', 'orphaned'].includes(current.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, options.provider === 'openrouter' ? 2_000 : 25));
      current = (await service.get(record.id)) ?? current;
    }
    row.status = current.status;
    row.attemptsTotal = current.nodes.reduce((sum: number, node: { attempts: number }) => sum + node.attempts, 0);
    for (const node of current.nodes) {
      row.nodeStates[node.nodeId] = {
        status: node.status, attempts: node.attempts,
        ...(node.failureCategory ? { failureCategory: node.failureCategory } : {}),
        ...(node.reason ? { reason: node.reason } : {}),
      };
    }
    for (const node of current.nodes) {
      const durations = await Promise.all(node.runIds.map(async (runId: string) => {
        const run = await center.get(runId);
        return run?.startedAt && run?.finishedAt
          ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : 0;
      }));
      row.latenciesMs.perNode[node.nodeId] = durations.reduce((sum: number, duration: number) => sum + duration, 0);
    }
    row.latenciesMs.total = Date.now() - started;
    row.questionsAsked = current.finalizerQuestions?.questions.length ?? 0;
    const tokens = current.budget.tokens;
    if (tokens > 0) row.tokens = { input: 0, output: 0, total: tokens };
    if (current.budget.costMicros > 0) {
      row.cost = { micros: current.budget.costMicros, estimated: true };
      row.costKnown = true;
      onCost(current.budget.costMicros);
    } else {
      row.costKnown = false;
    }
    const finalRef = current.artifactRefs.find((reference: { outputRef: string }) => reference.outputRef === 'final_html');
    if (current.status === 'succeeded' && finalRef) {
      const artifact = await artifacts.read(finalRef.artifactId);
      const content = artifact.content.toString('utf8');
      row.contractSuccess = /^<!doctype html>/i.test(content);
      const gaps = [
        ...caseItem.expected.mustContain.filter((value) => !content.includes(value)).map((value) => `fehlt: ${value}`),
        ...caseItem.expected.mustNotContain.filter((value) => content.includes(value)).map((value) => `unerwünscht: ${value}`),
      ];
      row.qualityGaps = gaps;
      row.qualitySuccess = row.contractSuccess && gaps.length === 0;
    } else {
      row.qualityGaps = [`status=${current.status}`];
    }
  } catch (error) {
    row.status = 'benchmark_error';
    row.error = error instanceof Error ? error.message : String(error);
  }
  return row;
}

export async function writeBenchmarkReport(report: BenchmarkReport, outRoot: string): Promise<{ dir: string; jsonPath: string; mdPath: string }> {
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const dir = join(outRoot, stamp);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const jsonPath = join(dir, 'report.json');
  const mdPath = join(dir, 'report.md');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(mdPath, renderBenchmarkMarkdown(report), { mode: 0o600 });
  return { dir, jsonPath, mdPath };
}

export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const lines = [
    `# Anwendungsbenchmark (${report.mode})`,
    '',
    `Erzeugt: ${report.generatedAt}`,
    report.summary.note,
    '',
    '| Fall | Modell | Reasoning (gewünscht/wirksam) | Wdh. | Status | Vertrag | Qualität | Fragen | Versuche | Laufzeit | Tokens | Kosten |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of report.rows) {
    lines.push(
      `| ${row.caseId} | ${row.model} | ${row.requestedReasoning}/${row.effectiveReasoning ?? '–'} | ${row.repeat} | ${row.status} | `
      + `${row.contractSuccess ? 'erfüllt' : 'nein'} | ${row.qualitySuccess ? 'erfüllt' : row.qualityGaps.join('; ') || 'nein'} | `
      + `${row.questionsAsked} | ${row.attemptsTotal} | ${row.latenciesMs.total} ms | `
      + `${row.tokens?.total ?? 'unbekannt'} | ${row.cost ? `${row.cost.micros} µ${row.cost.estimated ? ' (geschätzt)' : ''}` : 'unbekannt'} |`,
    );
  }
  lines.push('', `Läufe: ${report.summary.runs} · Vertrag: ${report.summary.contractSuccesses} · Qualität: ${report.summary.qualitySuccesses} · Unbekannte Kosten: ${report.summary.unknownCostRuns}`);
  return `${lines.join('\n')}\n`;
}
