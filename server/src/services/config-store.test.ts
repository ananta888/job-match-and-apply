import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config/defaults.js';
import { JsonConfigStore, MemoryConfigStore } from './config-store.js';

let directory = '';
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = ''; });

describe('JsonConfigStore', () => {
  it('migrates a legacy config and encrypts identities at rest', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'config-store-'));
    const path = resolve(directory, 'config.json');
    await writeFile(path, JSON.stringify(defaultConfig), 'utf8');
    const store = new JsonConfigStore(path, resolve(directory, 'identity.key'));
    const loaded = await store.load();
    expect(loaded.searchProfile.name).toBe(defaultConfig.searchProfile.name);
    await store.update(() => loaded);
    const persisted = await readFile(path, 'utf8');
    expect(JSON.parse(persisted)).toMatchObject({ schemaVersion: 3, revision: 1 });
    expect(persisted).not.toContain(defaultConfig.identities[0]!.email);
    expect((await store.load()).identities).toEqual(defaultConfig.identities);
  });

  it('prefills a validated local MCP launch contract without activating stdio', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'config-store-'));
    const path = resolve(directory, 'config.json');
    const executable = resolve(directory, 'wsl.exe');
    await writeFile(resolve(directory, 'job-search-mcp-launch.json'), JSON.stringify({
      contractVersion: '1.0', executionIsolation: 'trusted-host', runtimeTarget: 'wsl', distribution: 'Ubuntu', command: executable,
      args: ['-d', 'Ubuntu', '--', '/workspace/.venv-wsl/bin/job-search-mcp'], env: {
        ALLOW_EXTERNAL_PORTALS: '0', JOB_MCP_STATE_DIR: '/workspace/mcp-state',
        WSLENV: 'ALLOW_EXTERNAL_PORTALS:JOB_MCP_STATE_DIR'
      }
    }), 'utf8');
    const loaded = await new JsonConfigStore(path, resolve(directory, 'identity.key')).load();
    expect(loaded.mcp).toMatchObject({
      mode: 'stdio', executionIsolation: 'trusted-host', runtimeTarget: 'wsl', distribution: 'Ubuntu',
      command: executable, env: { ALLOW_EXTERNAL_PORTALS: '0' }
    });
  });

  it('ignores an unsafe MCP launch contract', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'config-store-'));
    const path = resolve(directory, 'config.json');
    await writeFile(resolve(directory, 'job-search-mcp-launch.json'), JSON.stringify({
      contractVersion: '1.0', command: 'relative-command', args: [], env: { 'BAD-NAME': 'x' }
    }), 'utf8');
    expect((await new JsonConfigStore(path, resolve(directory, 'identity.key')).load()).mcp).toEqual(defaultConfig.mcp);
  });

  it('rejects an unknown storage version', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'config-store-'));
    const path = resolve(directory, 'config.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 99, config: defaultConfig }), 'utf8');
    await expect(new JsonConfigStore(path, resolve(directory, 'identity.key')).load()).rejects.toThrow('Nicht unterstützte Konfigurationsversion');
  });

  it('serializes compare-and-save and advances a persisted monotonic revision', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'config-store-'));
    const path = resolve(directory, 'config.json');
    const store = new JsonConfigStore(path, resolve(directory, 'identity.key'));
    const initial = await store.loadSnapshot();
    expect(initial.revision).toBe(0);

    const candidates = await Promise.allSettled([
      store.compareAndSave(0, (config) => ({
        ...config, searchProfile: { ...config.searchProfile, name: 'Erster CAS-Schreibvorgang' }
      })),
      store.compareAndSave(0, (config) => ({
        ...config, searchProfile: { ...config.searchProfile, name: 'Zweiter CAS-Schreibvorgang' }
      }))
    ]);

    expect(candidates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const conflict = candidates.find((result) => result.status === 'rejected');
    expect(conflict).toMatchObject({ reason: { message: 'config_revision_conflict', statusCode: 409 } });
    const persisted = await new JsonConfigStore(path, resolve(directory, 'identity.key')).loadSnapshot();
    expect(persisted.revision).toBe(1);
    expect(['Erster CAS-Schreibvorgang', 'Zweiter CAS-Schreibvorgang']).toContain(persisted.config.searchProfile.name);
  });
});

describe('MemoryConfigStore', () => {
  it('does not use wall-clock timestamps as the compare-and-save revision', async () => {
    const store = new MemoryConfigStore();
    const first = await store.compareAndSave(0, (config) => config);
    const second = await store.compareAndSave(1, (config) => config);
    expect([first.revision, second.revision]).toEqual([1, 2]);
  });
});
