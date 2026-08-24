import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AgentConfigProfileStore, migrateAgentConfigProfile, safeDefaultAgentConfigProfile, type AgentConfigProfile } from './config-profile-store.js';

describe('AgentConfigProfileStore', () => {
  it('uses fail-closed defaults and rejects secret-bearing or dangerous profiles before writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-config-'));
    const store = new AgentConfigProfileStore(root);
    const safe = await store.reset(new Date('2026-08-14T00:00:00Z'));
    expect(safe.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'fake', enabled: true, sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' }),
      expect.objectContaining({ provider: 'codex-exec', enabled: true, sandbox: 'read-only', network: 'disabled', approvalMode: 'explicit' }),
      expect.objectContaining({ provider: 'opencode', enabled: true, runtimeTarget: 'wsl', sandbox: 'read-only', network: 'disabled' }),
      expect.objectContaining({ provider: 'claude-cli', enabled: true, runtimeTarget: 'wsl', sandbox: 'read-only', network: 'disabled' }),
      expect.objectContaining({ provider: 'acp', enabled: true, sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' }),
    ]));
    expect(safe.features).toEqual({
      multiAgentExperimental: true,
      realtimeWebSocketExperimental: false,
      rawProviderLogs: false,
    });
    const before = await readFile(join(root, 'profile.json'), 'utf8');
    await expect(store.save({ ...safe, api_token: 'CONFIG-CANARY' })).rejects.toThrow('agent_config_secret_field_forbidden');
    await expect(store.save({ ...safe, nested: { apiToken: 'CAMEL-CASE-CANARY' } })).rejects.toThrow('agent_config_secret_field_forbidden');
    await expect(store.save({ ...safe, providers: [{ ...safe.providers[0], network: 'enabled' }] })).rejects.toThrow('agent_config_provider_invalid');
    await expect(store.save({ ...safe, budgets: { ...safe.budgets, maxCostMicros: { amountMicros: 1, currency: 'eur' } } }))
      .rejects.toThrow('agent_config_cost_budget_invalid');
    expect(await readFile(join(root, 'profile.json'), 'utf8')).toBe(before);
    expect(before).not.toContain('CONFIG-CANARY');
  });

  it('falls back to last-known-good after primary corruption without accepting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-config-'));
    const store = new AgentConfigProfileStore(root);
    await store.save({ ...safeDefaultAgentConfigProfile(new Date('2026-08-14T00:00:00Z')), profileId: 'operations' });
    await writeFile(join(root, 'profile.json'), '{broken', 'utf8');
    await expect(new AgentConfigProfileStore(root).load()).resolves.toMatchObject({
      source: 'last_known_good', primaryError: 'agent_config_json_invalid', profile: { profileId: 'operations' }
    });
  });

  it('performs compare-and-save atomically and assigns a monotonic server revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-config-'));
    const store = new AgentConfigProfileStore(root);
    const initial = await store.reset(new Date('2026-08-14T00:00:00.000Z'));
    const candidate = { ...initial, profileId: 'strict-local' };
    const results = await Promise.allSettled([
      store.compareAndSave(initial.updatedAt, candidate, new Date('2026-08-14T00:00:00.000Z')),
      store.compareAndSave(initial.updatedAt, { ...candidate, profileId: 'racing-write' }, new Date('2026-08-14T00:00:00.000Z')),
    ]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<AgentConfigProfile> => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ message: 'agent_config_revision_conflict' });
    expect(Date.parse(fulfilled[0]!.value.updatedAt)).toBeGreaterThan(Date.parse(initial.updatedAt));
    await expect(store.load()).resolves.toMatchObject({ profile: { profileId: fulfilled[0]!.value.profileId } });
  });

  it('migrates legacy profiles with only the suggestion-only multi-agent workflow enabled', () => {
    const migrated = migrateAgentConfigProfile({
      schemaVersion: 1, profileId: 'legacy', updatedAt: '2026-08-14T00:00:00Z', warningAtPercent: 75,
      providers: [{ provider: 'codex', enabled: false, runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' }]
    });
    expect(migrated).toMatchObject({ migratedFrom: 1, profile: { schemaVersion: 3, budgets: { warningAtPercent: 75 }, features: { multiAgentExperimental: true } } });
  });

  it('drops the retired Codex app-server flag from a version 2 profile and keeps every other choice', () => {
    // Key validation is exact, so a stored version 2 profile would otherwise be
    // rejected outright as agent_config_feature_unknown.
    const stored = {
      schemaVersion: 2, profileId: 'operations', updatedAt: '2026-08-17T09:00:00Z',
      providers: [{ provider: 'claude-cli', enabled: true, runtimeTarget: 'wsl', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' }],
      budgets: { warningAtPercent: 80, maxTotalTokens: 100_000, maxToolCalls: 100, maxRunDurationMs: 1_800_000 },
      features: {
        codexAppServerExperimental: true, multiAgentExperimental: true,
        realtimeWebSocketExperimental: false, rawProviderLogs: false,
      },
    };
    const migrated = migrateAgentConfigProfile(stored);
    expect(migrated.migratedFrom).toBe(2);
    expect(migrated.profile.schemaVersion).toBe(3);
    expect(migrated.profile.features).toEqual({
      multiAgentExperimental: true, realtimeWebSocketExperimental: false, rawProviderLogs: false,
    });
    expect(migrated.profile).toMatchObject({
      profileId: 'operations',
      providers: [expect.objectContaining({ provider: 'claude-cli', runtimeTarget: 'wsl' })],
      budgets: { warningAtPercent: 80 },
    });
  });

  it('adds newly published default providers on load without rewriting the stored file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-config-'));
    const store = new AgentConfigProfileStore(root);
    const baseline = safeDefaultAgentConfigProfile(new Date('2026-08-17T00:00:00Z'));
    const withoutAcp = {
      ...baseline,
      providers: baseline.providers.filter((entry) => entry.provider !== 'acp'),
    };
    await store.save(withoutAcp);
    const loaded = await new AgentConfigProfileStore(root).load();
    expect(loaded.profile.providers.some((entry) => entry.provider === 'acp' && entry.enabled)).toBe(true);
    const disk = JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')) as AgentConfigProfile;
    expect(disk.providers.some((entry) => entry.provider === 'acp')).toBe(false);
  });
});
