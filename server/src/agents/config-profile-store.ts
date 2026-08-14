import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const SAFE_ID = /^[a-z][a-z0-9._-]{1,127}$/;
const VERSION = 2 as const;
const SECRET_KEY = /(?:^|[_-])(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key)(?:$|[_-])/i;

export interface AgentProviderProfile {
  provider: string;
  enabled: boolean;
  runtimeTarget: 'windows' | 'wsl' | 'linux' | 'darwin';
  wslDistribution?: string;
  sandbox: 'read-only' | 'workspace-write';
  network: 'disabled' | 'restricted';
  approvalMode: 'deny' | 'explicit';
  model?: string;
}

export interface AgentConfigProfile {
  schemaVersion: typeof VERSION;
  profileId: string;
  updatedAt: string;
  providers: AgentProviderProfile[];
  budgets: {
    warningAtPercent: number;
    maxTotalTokens?: number;
    maxToolCalls?: number;
    maxRunDurationMs?: number;
    maxCostMicros?: { amountMicros: number; currency: string };
  };
  features: {
    codexAppServerExperimental: boolean;
    multiAgentExperimental: boolean;
    realtimeWebSocketExperimental: boolean;
    rawProviderLogs: boolean;
  };
}

interface LegacyAgentConfigProfile {
  schemaVersion: 1;
  profileId: string;
  updatedAt: string;
  providers?: AgentProviderProfile[];
  warningAtPercent?: number;
}

export interface AgentConfigLoadResult {
  profile: AgentConfigProfile;
  source: 'primary' | 'last_known_good';
  migratedFrom?: 1;
  primaryError?: string;
}

function ensureContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('agent_config_path_escape');
}

function assertNoSecretFields(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('agent_config_cycle');
  seen.add(value);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (SECRET_KEY.test(normalizedKey)) throw new Error(`agent_config_secret_field_forbidden:${key}`);
    assertNoSecretFields(entry, seen);
  }
  seen.delete(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(code);
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('agent_config_budget_invalid');
  return value as number;
}

function optionalCostLimit(value: unknown): AgentConfigProfile['budgets']['maxCostMicros'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('agent_config_cost_budget_invalid');
  const cost = value as Record<string, unknown>;
  assertExactKeys(cost, ['amountMicros', 'currency'], 'agent_config_cost_budget_unknown_field');
  if (!Number.isSafeInteger(cost.amountMicros) || (cost.amountMicros as number) < 0
    || typeof cost.currency !== 'string' || !/^[A-Z]{3}$/.test(cost.currency)) throw new Error('agent_config_cost_budget_invalid');
  return { amountMicros: cost.amountMicros as number, currency: cost.currency };
}

function validateProvider(value: unknown): AgentProviderProfile {
  if (!value || typeof value !== 'object') throw new Error('agent_config_provider_invalid');
  const input = value as Record<string, unknown>;
  assertExactKeys(input, ['provider', 'enabled', 'runtimeTarget', 'wslDistribution', 'sandbox', 'network', 'approvalMode', 'model'], 'agent_config_provider_unknown_field');
  if (typeof input.provider !== 'string' || !SAFE_ID.test(input.provider) || typeof input.enabled !== 'boolean'
    || !['windows', 'wsl', 'linux', 'darwin'].includes(String(input.runtimeTarget))
    || !['read-only', 'workspace-write'].includes(String(input.sandbox))
    || !['disabled', 'restricted'].includes(String(input.network))
    || !['deny', 'explicit'].includes(String(input.approvalMode))) throw new Error('agent_config_provider_invalid');
  if (input.wslDistribution !== undefined && (input.runtimeTarget !== 'wsl' || typeof input.wslDistribution !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.wslDistribution))) throw new Error('agent_config_provider_invalid');
  if (input.model !== undefined && (typeof input.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.model))) {
    throw new Error('agent_config_provider_invalid');
  }
  return structuredClone(input) as unknown as AgentProviderProfile;
}

export function safeDefaultAgentConfigProfile(now = new Date()): AgentConfigProfile {
  const localTarget: AgentProviderProfile['runtimeTarget'] = process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'darwin' : 'linux';
  return {
    schemaVersion: VERSION,
    profileId: 'safe-default',
    updatedAt: now.toISOString(),
    providers: [
      { provider: 'fake', enabled: true, runtimeTarget: localTarget, sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' },
      { provider: 'fake-interactive', enabled: true, runtimeTarget: localTarget, sandbox: 'read-only', network: 'disabled', approvalMode: 'explicit' },
      { provider: 'codex-exec', enabled: true, runtimeTarget: localTarget, sandbox: 'read-only', network: 'disabled', approvalMode: 'explicit' },
      { provider: 'opencode', enabled: true, runtimeTarget: 'wsl', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' },
      { provider: 'claude-cli', enabled: true, runtimeTarget: 'wsl', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' },
    ],
    budgets: { warningAtPercent: 80, maxTotalTokens: 100_000, maxToolCalls: 100, maxRunDurationMs: 30 * 60_000 },
    features: {
      codexAppServerExperimental: false, multiAgentExperimental: true,
      realtimeWebSocketExperimental: false, rawProviderLogs: false
    }
  };
}

export function validateAgentConfigProfile(value: unknown): AgentConfigProfile {
  assertNoSecretFields(value);
  if (!value || typeof value !== 'object') throw new Error('agent_config_invalid');
  const input = value as Record<string, unknown>;
  assertExactKeys(input, ['schemaVersion', 'profileId', 'updatedAt', 'providers', 'budgets', 'features'], 'agent_config_unknown_field');
  if (input.schemaVersion !== VERSION || typeof input.profileId !== 'string' || !SAFE_ID.test(input.profileId)
    || typeof input.updatedAt !== 'string' || !Number.isFinite(Date.parse(input.updatedAt))
    || !Array.isArray(input.providers) || !input.budgets || typeof input.budgets !== 'object'
    || !input.features || typeof input.features !== 'object') throw new Error('agent_config_invalid');
  const providers = input.providers.map(validateProvider);
  if (new Set(providers.map((entry) => entry.provider)).size !== providers.length) throw new Error('agent_config_provider_duplicate');
  const budgets = input.budgets as Record<string, unknown>;
  assertExactKeys(budgets, ['warningAtPercent', 'maxTotalTokens', 'maxToolCalls', 'maxRunDurationMs', 'maxCostMicros'], 'agent_config_budget_unknown_field');
  if (!Number.isSafeInteger(budgets.warningAtPercent) || (budgets.warningAtPercent as number) < 1 || (budgets.warningAtPercent as number) > 100) {
    throw new Error('agent_config_budget_invalid');
  }
  const features = input.features as Record<string, unknown>;
  const featureNames = ['codexAppServerExperimental', 'multiAgentExperimental', 'realtimeWebSocketExperimental', 'rawProviderLogs'] as const;
  assertExactKeys(features, featureNames, 'agent_config_feature_unknown');
  if (featureNames.some((name) => typeof features[name] !== 'boolean')) throw new Error('agent_config_feature_invalid');
  return {
    schemaVersion: VERSION, profileId: input.profileId, updatedAt: input.updatedAt,
    providers,
    budgets: {
      warningAtPercent: budgets.warningAtPercent as number,
      maxTotalTokens: optionalLimit(budgets.maxTotalTokens), maxToolCalls: optionalLimit(budgets.maxToolCalls),
      maxRunDurationMs: optionalLimit(budgets.maxRunDurationMs),
      maxCostMicros: optionalCostLimit(budgets.maxCostMicros),
    },
    features: Object.fromEntries(featureNames.map((name) => [name, features[name]])) as unknown as AgentConfigProfile['features']
  };
}

export function migrateAgentConfigProfile(value: unknown): { profile: AgentConfigProfile; migratedFrom?: 1 } {
  if (value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 1) {
    assertNoSecretFields(value);
    const legacy = value as LegacyAgentConfigProfile;
    if (!SAFE_ID.test(legacy.profileId) || !Number.isFinite(Date.parse(legacy.updatedAt))) throw new Error('agent_config_legacy_invalid');
    const profile = safeDefaultAgentConfigProfile(new Date(legacy.updatedAt));
    profile.profileId = legacy.profileId;
    profile.providers = (legacy.providers ?? []).map(validateProvider);
    profile.budgets.warningAtPercent = legacy.warningAtPercent ?? 80;
    return { profile: validateAgentConfigProfile(profile), migratedFrom: 1 };
  }
  return { profile: validateAgentConfigProfile(value) };
}

/** Versioned local profiles with strict fields and a durable last-known-good copy. */
export class AgentConfigProfileStore {
  private readonly primary: string;
  private readonly lastGood: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly root = resolve(process.cwd(), '.local-data', 'agent-config')) {
    this.primary = resolve(root, 'profile.json');
    this.lastGood = resolve(root, 'profile.last-known-good.json');
    ensureContained(root, this.primary); ensureContained(root, this.lastGood);
  }

  async load(): Promise<AgentConfigLoadResult> {
    try {
      const migrated = migrateAgentConfigProfile(await this.read(this.primary));
      return { ...migrated, source: 'primary' };
    } catch (primaryError) {
      try {
        const migrated = migrateAgentConfigProfile(await this.read(this.lastGood));
        return { ...migrated, source: 'last_known_good', primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError) };
      } catch {
        throw primaryError;
      }
    }
  }

  async save(value: unknown): Promise<AgentConfigProfile> {
    const profile = validateAgentConfigProfile(value);
    return this.serialized(async () => {
      return this.persist(profile);
    });
  }

  /**
   * Atomically compares the browser-visible revision and publishes a new,
   * server-timestamped profile. The comparison runs inside the same serialized
   * critical section as both atomic file replacements.
   */
  async compareAndSave(expectedUpdatedAt: string, value: unknown, now = new Date()): Promise<AgentConfigProfile> {
    if (!Number.isFinite(Date.parse(expectedUpdatedAt))) throw new Error('agent_config_revision_invalid');
    return this.serialized(async () => {
      const current = (await this.load()).profile;
      if (current.updatedAt !== expectedUpdatedAt) throw new Error('agent_config_revision_conflict');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('agent_config_invalid');
      const nextUpdatedAt = new Date(Math.max(now.getTime(), Date.parse(current.updatedAt) + 1)).toISOString();
      const profile = validateAgentConfigProfile({
        ...(value as Record<string, unknown>),
        schemaVersion: VERSION,
        updatedAt: nextUpdatedAt,
      });
      return this.persist(profile);
    });
  }

  async reset(now = new Date()): Promise<AgentConfigProfile> {
    return this.save(safeDefaultAgentConfigProfile(now));
  }

  private async assertRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('agent_config_root_not_plain_directory');
  }

  private async read(path: string): Promise<unknown> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('agent_config_not_plain_file');
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('agent_config_json_invalid'); }
  }

  private async atomicWrite(path: string, profile: AgentConfigProfile): Promise<void> {
    const temporary = resolve(this.root, `.${randomUUID()}.tmp`); ensureContained(this.root, temporary);
    await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  private async persist(profile: AgentConfigProfile): Promise<AgentConfigProfile> {
    await this.assertRoot();
    await this.atomicWrite(this.primary, profile);
    await this.atomicWrite(this.lastGood, profile);
    return structuredClone(profile);
  }

  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try { return await action(); } finally { release(); }
  }
}
