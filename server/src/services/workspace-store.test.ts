import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SearchRun } from '../domain/models.js';
import { defaultConfig } from '../config/defaults.js';
import { JsonWorkspaceStore } from './workspace-store.js';

let directory = '';
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = ''; });

describe('JsonWorkspaceStore', () => {
  it('serializes concurrent atomic updates without losing search runs', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'workspace-store-'));
    const store = new JsonWorkspaceStore(resolve(directory, 'workspace.json'));
    const run = (id: string): SearchRun => ({
      id, createdAt: '2026-08-13T00:00:00.000Z', profile: structuredClone(defaultConfig.searchProfile), sourceIds: [], matches: []
    });
    await Promise.all([store.saveSearchRun(run('one')), store.saveSearchRun(run('two'))]);
    expect((await store.listSearchRuns()).map((item) => item.id).sort()).toEqual(['one', 'two']);
  });
  it('detects corrupt data and never silently overwrites it', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'workspace-corrupt-'));
    const path = resolve(directory, 'workspace.json');
    await writeFile(path, '{broken', 'utf8');
    const store = new JsonWorkspaceStore(path);
    await expect(store.listSearchRuns()).rejects.toThrow();
    await expect(store.saveSearchRun({ id: 'new', createdAt: '2026-01-01T00:00:00Z', profile: structuredClone(defaultConfig.searchProfile), sourceIds: [], matches: [] })).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });
});
