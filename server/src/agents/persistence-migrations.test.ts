import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentEvent, type AgentRun } from '../ports/agent-runner.js';
import {
  AGENT_PERSISTENCE_VERSION,
  AgentPersistenceMigrationError,
  PersistenceMigrationRegistry,
  decodeAgentEventSnapshot,
  decodeAgentRunSnapshot,
} from './persistence-migrations.js';
import { JsonAgentRunStore } from './run-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function fixtureRun(id = 'migration-run'): AgentRun {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION,
    id,
    provider: 'fake',
    state: 'queued',
    currentSequence: 0,
    requestedAt: '2026-08-14T10:00:00.000Z',
    updatedAt: '2026-08-14T10:00:00.000Z',
    request: {
      provider: 'fake', task: 'migration fixture', workspaceRoot: 'C:/fixture',
      runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny',
    },
  };
}

function fixtureEvent(run: AgentRun): AgentEvent {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION, runId: run.id, sequence: 1,
    timestamp: '2026-08-14T10:00:01.000Z', provider: run.provider,
    correlationId: 'migration-correlation', kind: 'run_created',
    data: { request: run.request, requestedAt: run.requestedAt },
  };
}

describe('agent persistence migration registry', () => {
  it('migrates the explicitly supported unversioned legacy shape without leaking storage fields', () => {
    const run = fixtureRun();
    const event = fixtureEvent(run);
    expect(decodeAgentRunSnapshot(run)).toEqual({ value: run, migrated: true });
    expect(decodeAgentEventSnapshot(event)).toEqual({ value: event, migrated: true });
    expect(decodeAgentRunSnapshot({ ...run, persistenceVersion: AGENT_PERSISTENCE_VERSION })).toEqual({ value: run, migrated: false });
  });

  it('fails closed for future versions, malformed declarations and missing steps', () => {
    const run = fixtureRun();
    expect(() => decodeAgentRunSnapshot({ ...run, persistenceVersion: 999 }))
      .toThrowError(AgentPersistenceMigrationError);
    expect(() => decodeAgentRunSnapshot({ ...run, persistenceVersion: '1' }))
      .toThrow('version_invalid');

    const incomplete = new PersistenceMigrationRegistry('fixture', 2);
    incomplete.register(0, 1, (record) => ({ ...record, persistenceVersion: 1 }));
    expect(() => incomplete.migrate({ value: true })).toThrow('migration_missing');
  });

  it('writes the current version and rewrites legacy logs during restart recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-persistence-migration-'));
    roots.push(root);
    const original = fixtureRun('legacy-on-disk');
    const directory = join(root, original.id);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'run.json'), `${JSON.stringify(original)}\n`, 'utf8');
    await writeFile(join(directory, 'events.jsonl'), `${JSON.stringify(fixtureEvent(original))}\n`, 'utf8');

    const store = new JsonAgentRunStore(root);
    const result = await store.recover();

    expect(result.errors).toEqual([]);
    expect((await store.get(original.id))?.state).toBe('orphaned');
    expect(JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')).persistenceVersion).toBe(AGENT_PERSISTENCE_VERSION);
    const persistedEvent = JSON.parse((await readFile(join(directory, 'events.jsonl'), 'utf8')).trim());
    expect(persistedEvent.persistenceVersion).toBe(AGENT_PERSISTENCE_VERSION);
  });

  it('does not downgrade or overwrite a readable future snapshot during recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-persistence-future-'));
    roots.push(root);
    const original = fixtureRun('future-on-disk');
    const store = new JsonAgentRunStore(root);
    await store.create(original);
    await store.append(fixtureEvent(original));
    const path = join(root, original.id, 'run.json');
    const future = { ...original, persistenceVersion: 99, futureOnly: { semantic: 'must-survive' } };
    await writeFile(path, `${JSON.stringify(future)}\n`, 'utf8');

    const result = await store.recover();

    expect(result.errors).toEqual([expect.objectContaining({ runId: original.id, message: expect.stringContaining('version_unsupported') })]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(future);
  });
});
