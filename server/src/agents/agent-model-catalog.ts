import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { RuntimeTarget } from '../ports/agent-runner.js';
import {
  type DiscoveryCommandExecutor,
  SpawnDiscoveryCommandExecutor,
  defaultWslHostExecutable,
  isSafeWslDistribution,
} from './runtime-discovery.js';

/**
 * Reads the *currently selectable* models straight from each tool's own state
 * rather than a hand-maintained list:
 *   - codex-exec : ~/.codex/models_cache.json (server-fetched catalog) + the
 *                  configured `model` from config.toml.
 *   - claude-cli : ~/.claude/stats-cache.json modelUsage (the account's real
 *                  models) plus the convenient CLI aliases and settings.json.
 *   - opencode   : `opencode models` (live provider enumeration).
 * Every provider still accepts a free-text override, because the tools accept
 * arbitrary `--model` values the caches may not enumerate yet.
 */
export interface ModelCatalogEntry {
  id: string;
  label?: string;
  note?: string;
}

export interface ProviderModelCatalog {
  providerId: string;
  runtimeTarget: RuntimeTarget;
  wslDistribution?: string;
  source: 'codex-models-cache' | 'claude-stats-cache' | 'opencode-cli' | 'none';
  models: ModelCatalogEntry[];
  currentModel?: string;
  supportsCustom: boolean;
  note?: string;
}

export interface ModelCatalogDeps {
  executor?: DiscoveryCommandExecutor;
  readLocalFile?: (path: string) => Promise<string>;
  homeDir?: string;
  wslHostExecutable?: string;
  env?: NodeJS.ProcessEnv;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID_WITH_SLASH = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const MAX_MODELS = 100;
const FILE_READ_TIMEOUT_MS = 15_000;
const OPENCODE_MODELS_TIMEOUT_MS = 45_000;

/** Claude Code accepts these convenient aliases in addition to full model ids. */
const CLAUDE_MODEL_ALIASES: readonly ModelCatalogEntry[] = [
  { id: 'default', label: 'Standard (Kontostandard)' },
  { id: 'opus', label: 'Opus (neuestes)' },
  { id: 'sonnet', label: 'Sonnet (neuestes)' },
  { id: 'haiku', label: 'Haiku (neuestes)' },
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseCodexModelsCache(text: string): ModelCatalogEntry[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return []; }
  const models = record(data)?.models;
  if (!Array.isArray(models)) return [];
  const out: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const entry of models) {
    const model = record(entry);
    const slug = model?.slug;
    if (typeof slug !== 'string' || !MODEL_ID.test(slug) || seen.has(slug)) continue;
    if (model?.visibility === 'hide') continue;
    seen.add(slug);
    const label = typeof model?.display_name === 'string' ? model.display_name : undefined;
    const note = model?.supported_in_api === false ? 'nur über codex exec (nicht OpenAI-API)' : undefined;
    out.push({ id: slug, ...(label ? { label } : {}), ...(note ? { note } : {}) });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/** The active model is a top-level key that appears before any `[section]`. */
export function parseCodexConfigModel(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const match = /^model\s*=\s*"([^"]+)"/.exec(line);
    if (match && MODEL_ID.test(match[1]!)) return match[1];
  }
  return undefined;
}

export function parseClaudeStatsModels(text: string): string[] {
  try {
    const usage = record(JSON.parse(text))?.modelUsage;
    return Object.keys(record(usage) ?? {}).filter((key) => MODEL_ID.test(key)).slice(0, MAX_MODELS);
  } catch { return []; }
}

export function parseClaudeSettingsModel(text: string): string | undefined {
  try {
    const model = record(JSON.parse(text))?.model;
    return typeof model === 'string' && MODEL_ID.test(model) ? model : undefined;
  } catch { return undefined; }
}

export function parseOpencodeModels(stdout: string): ModelCatalogEntry[] {
  const out: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line) || !MODEL_ID_WITH_SLASH.test(line)) continue;
    seen.add(line);
    out.push({ id: line });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

export async function discoverProviderModelCatalog(
  input: { providerId: string; runtimeTarget: RuntimeTarget; wslDistribution?: string; executable?: string },
  deps: ModelCatalogDeps = {},
): Promise<ProviderModelCatalog> {
  const executor = deps.executor ?? new SpawnDiscoveryCommandExecutor();
  const readLocalFile = deps.readLocalFile ?? ((path) => readFile(path, 'utf8'));
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  const wslHost = deps.wslHostExecutable ?? defaultWslHostExecutable(env);
  const base = {
    providerId: input.providerId,
    runtimeTarget: input.runtimeTarget,
    ...(input.wslDistribution ? { wslDistribution: input.wslDistribution } : {}),
    supportsCustom: true,
  } as const;

  // Reads a config file for the selected runtime. On WSL the path is expanded by
  // the guest shell so per-user home resolution stays inside the distribution.
  const readForRuntime = async (nativePath: string, wslShellPath: string): Promise<string | undefined> => {
    if (input.runtimeTarget === 'wsl') {
      if (!input.wslDistribution || !isSafeWslDistribution(input.wslDistribution)) return undefined;
      const result = await executor.run(
        wslHost, ['-d', input.wslDistribution, '--', 'sh', '-c', `cat ${wslShellPath}`], FILE_READ_TIMEOUT_MS,
      );
      return result.exitCode === 0 && result.stdout ? result.stdout : undefined;
    }
    try { return await readLocalFile(nativePath); } catch { return undefined; }
  };

  if (input.providerId === 'codex-exec') {
    const codexHome = env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(home, '.codex');
    const [cacheText, configText] = await Promise.all([
      readForRuntime(join(codexHome, 'models_cache.json'), '"${CODEX_HOME:-$HOME/.codex}/models_cache.json"'),
      readForRuntime(join(codexHome, 'config.toml'), '"${CODEX_HOME:-$HOME/.codex}/config.toml"'),
    ]);
    const models = cacheText ? parseCodexModelsCache(cacheText) : [];
    const currentModel = configText ? parseCodexConfigModel(configText) : undefined;
    if (currentModel && !models.some((model) => model.id === currentModel)) {
      models.unshift({ id: currentModel, note: 'aktuell in config.toml' });
    }
    return {
      ...base,
      source: models.length ? 'codex-models-cache' : 'none',
      models: models.slice(0, MAX_MODELS),
      ...(currentModel ? { currentModel } : {}),
      ...(cacheText ? {} : { note: 'models_cache.json nicht gefunden – Modellname frei eingeben.' }),
    };
  }

  if (input.providerId === 'claude-cli') {
    const claudeHome = env.CLAUDE_CONFIG_DIR && isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : join(home, '.claude');
    const [statsText, settingsText] = await Promise.all([
      readForRuntime(join(claudeHome, 'stats-cache.json'), '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/stats-cache.json"'),
      readForRuntime(join(claudeHome, 'settings.json'), '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"'),
    ]);
    const accountModels = statsText ? parseClaudeStatsModels(statsText) : [];
    const currentModel = settingsText ? parseClaudeSettingsModel(settingsText) : undefined;
    const seen = new Set<string>();
    const models: ModelCatalogEntry[] = [];
    for (const entry of [...CLAUDE_MODEL_ALIASES, ...accountModels.map((id) => ({ id, note: 'Kontomodell' as const }))]) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      models.push(entry);
      if (models.length >= MAX_MODELS) break;
    }
    return {
      ...base,
      source: accountModels.length ? 'claude-stats-cache' : 'none',
      models,
      ...(currentModel ? { currentModel } : {}),
      ...(accountModels.length ? {} : { note: 'stats-cache.json nicht gefunden – Aliase + Freitext verfügbar.' }),
    };
  }

  if (input.providerId === 'opencode') {
    if (!input.executable) {
      return { ...base, source: 'none', models: [], note: 'OpenCode-Installation nicht gefunden.' };
    }
    const result = input.runtimeTarget === 'wsl'
      ? (input.wslDistribution && isSafeWslDistribution(input.wslDistribution)
        ? await executor.run(wslHost, ['-d', input.wslDistribution, '--', input.executable, 'models'], OPENCODE_MODELS_TIMEOUT_MS)
        : undefined)
      : await executor.run(input.executable, ['models'], OPENCODE_MODELS_TIMEOUT_MS);
    const models = result?.exitCode === 0 ? parseOpencodeModels(result.stdout) : [];
    return {
      ...base,
      source: models.length ? 'opencode-cli' : 'none',
      models,
      ...(models.length ? {} : { note: 'opencode models lieferte keine Liste – Modellname frei eingeben.' }),
    };
  }

  return { ...base, source: 'none', models: [], note: 'Für diesen Provider ist keine Modellauswahl hinterlegt.' };
}
