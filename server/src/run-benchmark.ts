#!/usr/bin/env node
/**
 * Reproducible synthetic application benchmark. Offline by default (scripted
 * fake provider, no model costs). Live model runs need --provider openrouter,
 * --allow-live and --budget-micros; no live run ever starts without both.
 * Real model quality stays explicitly open until such an opted-in run exists.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  runApplicationBenchmark, writeBenchmarkReport,
  type BenchmarkOptions,
} from './agents/application-benchmark.js';
import type { OpenRouterReasoning } from './agents/openrouter-http-adapter.js';

const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'fake' },
    model: { type: 'string' },
    reasoning: { type: 'string', default: 'off' },
    repeats: { type: 'string', default: '1' },
    'budget-micros': { type: 'string' },
    'allow-live': { type: 'boolean', default: false },
    case: { type: 'string', multiple: true },
    out: { type: 'string', default: '.local-data/benchmarks' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log('Aufruf: npm run benchmark -- [--provider fake|openrouter] [--model id] [--reasoning off,low,medium,high] [--repeats n] [--case id] [--out dir] [--allow-live --budget-micros n]');
  process.exit(0);
}
const provider = values.provider === 'openrouter' ? 'openrouter' as const : 'fake' as const;
const reasoningVariants = String(values.reasoning).split(',').map((value) => value.trim()).filter(Boolean) as OpenRouterReasoning[];
for (const variant of reasoningVariants) {
  if (!['default', 'off', 'low', 'medium', 'high'].includes(variant)) {
    console.error(`Unbekannte Reasoning-Stufe: ${variant}`);
    process.exit(2);
  }
}
const repeats = Number(values.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) {
  console.error('--repeats muss 1..20 sein.');
  process.exit(2);
}
const options: BenchmarkOptions = {
  provider,
  ...(values.model ? { model: values.model } : {}),
  reasoningVariants,
  repeats,
  ...(values['budget-micros'] ? { budgetMicros: Number(values['budget-micros']) } : {}),
  allowLive: values['allow-live'] === true,
  ...(values.case?.length ? { caseIds: values.case } : {}),
  artifactRoot: resolve(process.cwd(), '.local-data', 'benchmark-work'),
};

try {
  const report = await runApplicationBenchmark(options);
  const written = await writeBenchmarkReport(report, resolve(process.cwd(), String(values.out)));
  console.log(`Benchmark (${report.mode}): ${report.summary.runs} Lauf/Läufe`);
  console.log(`Vertrag erfüllt: ${report.summary.contractSuccesses} · Qualität erfüllt: ${report.summary.qualitySuccesses} · Unbekannte Kosten: ${report.summary.unknownCostRuns}`);
  console.log(`Ergebnisse: ${written.dir}`);
  if (report.mode === 'offline-fake') {
    console.log('Hinweis: Offline-Synthetic ohne Modellqualitätsaussage; echte Qualität bleibt offen.');
  }
} catch (error) {
  console.error(`Benchmark fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
