import { describe, expect, it, vi } from 'vitest';
import {
  discoverProviderModelCatalog,
  parseClaudeSettingsModel,
  parseClaudeStatsModels,
  parseCodexConfigModel,
  parseCodexModelsCache,
  parseOpencodeModels,
  type ModelCatalogDeps,
} from './agent-model-catalog.js';
import type { DiscoveryCommandResult } from './runtime-discovery.js';

const CODEX_CACHE = JSON.stringify({
  fetched_at: '2026-08-16T08:28:16Z', etag: 'W/"abc"', client_version: '0.147.0',
  models: [
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', supported_in_api: true },
    { slug: 'gpt-5.3-codex-spark', display_name: 'GPT-5.3-Codex-Spark', visibility: 'list', supported_in_api: false },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', supported_in_api: true },
    { slug: 'bad slug!', display_name: 'Invalid', visibility: 'list' },
  ],
});

describe('provider model catalog parsers', () => {
  it('maps visible codex models and flags API-only unavailability', () => {
    const models = parseCodexModelsCache(CODEX_CACHE);
    expect(models.map((model) => model.id)).toEqual(['gpt-5.6-sol', 'gpt-5.3-codex-spark']);
    expect(models[0]).toEqual({ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' });
    expect(models[1]).toEqual({ id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark', note: 'nur über codex exec (nicht OpenAI-API)' });
    expect(parseCodexModelsCache('not json')).toEqual([]);
  });

  it('reads the active codex model only from the top-level config key', () => {
    const toml = 'model = "gpt-5.3-codex-spark"\nmodel_reasoning_effort = "high"\n[projects."/x"]\nmodel = "should-not-win"\n';
    expect(parseCodexConfigModel(toml)).toBe('gpt-5.3-codex-spark');
    expect(parseCodexConfigModel('[tui]\nmodel = "late"')).toBeUndefined();
  });

  it('extracts claude account models and current setting', () => {
    expect(parseClaudeStatsModels(JSON.stringify({ modelUsage: { 'claude-opus-5': {}, 'claude-sonnet-5': {}, 'bad key!': {} } })))
      .toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(parseClaudeSettingsModel(JSON.stringify({ model: 'opus' }))).toBe('opus');
    expect(parseClaudeSettingsModel('{}')).toBeUndefined();
  });

  it('parses opencode model lines, dedupes and allows provider/slug ids', () => {
    expect(parseOpencodeModels('opencode/big-pickle\nlmstudio/qwen/qwen3-coder-30b\n\nopencode/big-pickle\n bad id ')
      .map((model) => model.id)).toEqual(['opencode/big-pickle', 'lmstudio/qwen/qwen3-coder-30b']);
  });
});

describe('discoverProviderModelCatalog', () => {
  const noExec = { run: vi.fn(async (): Promise<DiscoveryCommandResult> => ({ exitCode: 1, stdout: '', stderr: '' })) };

  it('combines the codex cache with the configured model as current (native)', async () => {
    const deps: ModelCatalogDeps = {
      executor: noExec, env: {}, homeDir: 'C:\\home',
      readLocalFile: async (path) => path.endsWith('models_cache.json') ? CODEX_CACHE
        : path.endsWith('config.toml') ? 'model = "gpt-5.3-codex-spark"\n' : Promise.reject(new Error('missing')),
    };
    const catalog = await discoverProviderModelCatalog({ providerId: 'codex-exec', runtimeTarget: 'windows' }, deps);
    expect(catalog.source).toBe('codex-models-cache');
    expect(catalog.currentModel).toBe('gpt-5.3-codex-spark');
    expect(catalog.models.some((model) => model.id === 'gpt-5.3-codex-spark')).toBe(true);
    expect(catalog.supportsCustom).toBe(true);
  });

  it('prepends a config-only codex model that is absent from the cache', async () => {
    const deps: ModelCatalogDeps = {
      executor: noExec, env: {}, homeDir: 'C:\\home',
      readLocalFile: async (path) => path.endsWith('models_cache.json') ? JSON.stringify({ models: [] })
        : 'model = "gpt-private-preview"\n',
    };
    const catalog = await discoverProviderModelCatalog({ providerId: 'codex-exec', runtimeTarget: 'windows' }, deps);
    expect(catalog.models[0]).toEqual({ id: 'gpt-private-preview', note: 'aktuell in config.toml' });
  });

  it('offers claude aliases plus account models with the current selection', async () => {
    const deps: ModelCatalogDeps = {
      executor: noExec, env: {}, homeDir: 'C:\\home',
      readLocalFile: async (path) => path.endsWith('stats-cache.json') ? JSON.stringify({ modelUsage: { 'claude-opus-5': {} } })
        : JSON.stringify({ model: 'opus' }),
    };
    const catalog = await discoverProviderModelCatalog({ providerId: 'claude-cli', runtimeTarget: 'windows' }, deps);
    expect(catalog.models.map((model) => model.id)).toEqual(['default', 'opus', 'sonnet', 'haiku', 'claude-opus-5']);
    expect(catalog.currentModel).toBe('opus');
    expect(catalog.source).toBe('claude-stats-cache');
  });

  it('runs opencode models through the wsl distribution', async () => {
    const run = vi.fn(async (): Promise<DiscoveryCommandResult> => ({ exitCode: 0, stdout: 'opencode/big-pickle\nopencode/hy3-free\n', stderr: '' }));
    const catalog = await discoverProviderModelCatalog(
      { providerId: 'opencode', runtimeTarget: 'wsl', wslDistribution: 'Ubuntu', executable: '/usr/local/bin/opencode' },
      { executor: { run }, wslHostExecutable: 'C:\\Windows\\System32\\wsl.exe' },
    );
    expect(catalog.models.map((model) => model.id)).toEqual(['opencode/big-pickle', 'opencode/hy3-free']);
    expect(run).toHaveBeenCalledWith('C:\\Windows\\System32\\wsl.exe',
      ['-d', 'Ubuntu', '--', '/usr/local/bin/opencode', 'models'], expect.any(Number));
  });

  it('reads codex config from the guest home when the runtime is wsl', async () => {
    const run = vi.fn(async (_exe: string, args: readonly string[]): Promise<DiscoveryCommandResult> =>
      args.join(' ').includes('models_cache.json') ? { exitCode: 0, stdout: CODEX_CACHE, stderr: '' }
        : { exitCode: 0, stdout: 'model = "gpt-5.3-codex-spark"\n', stderr: '' });
    const catalog = await discoverProviderModelCatalog(
      { providerId: 'codex-exec', runtimeTarget: 'wsl', wslDistribution: 'Ubuntu' },
      { executor: { run }, wslHostExecutable: 'C:\\Windows\\System32\\wsl.exe' },
    );
    expect(catalog.models.some((model) => model.id === 'gpt-5.6-sol')).toBe(true);
    expect(run.mock.calls.every((call) => call[0] === 'C:\\Windows\\System32\\wsl.exe'
      && (call[1] as string[]).includes('sh') && (call[1] as string[]).includes('-d'))).toBe(true);
  });

  it('degrades to free-text when nothing is found', async () => {
    const catalog = await discoverProviderModelCatalog(
      { providerId: 'codex-exec', runtimeTarget: 'windows' },
      { executor: noExec, env: {}, homeDir: 'C:\\home', readLocalFile: async () => Promise.reject(new Error('missing')) },
    );
    expect(catalog.source).toBe('none');
    expect(catalog.models).toEqual([]);
    expect(catalog.supportsCustom).toBe(true);
    expect(catalog.note).toContain('frei');
  });
});
