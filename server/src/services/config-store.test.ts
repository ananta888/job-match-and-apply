import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config/defaults.js';
import { JsonConfigStore } from './config-store.js';

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
    await store.save(loaded);
    const persisted = await readFile(path, 'utf8');
    expect(JSON.parse(persisted).schemaVersion).toBe(2);
    expect(persisted).not.toContain(defaultConfig.identities[0]!.email);
    expect((await store.load()).identities).toEqual(defaultConfig.identities);
  });

  it('prefills a validated local MCP launch contract without activating stdio', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'config-store-'));
    const path = resolve(directory, 'config.json');
    const executable = resolve(directory, 'wsl.exe');
    await writeFile(resolve(directory, 'job-search-mcp-launch.json'), JSON.stringify({
      contractVersion: '1.0', executionIsolation: 'trusted-host', runtimeTarget: 'wsl', distribution: 'Ubuntu', command: executable,
      args: ['-d', 'Ubuntu', '--', '/workspace/.venv-wsl/bin/job-search-mcp'], env: { ALLOW_EXTERNAL_PORTALS: '0' }
    }), 'utf8');
    const loaded = await new JsonConfigStore(path, resolve(directory, 'identity.key')).load();
    expect(loaded.mcp).toMatchObject({
      mode: 'demo', executionIsolation: 'trusted-host', runtimeTarget: 'wsl', distribution: 'Ubuntu',
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
});
