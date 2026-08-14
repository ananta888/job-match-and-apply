import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentEvent, type AgentRun } from '../ports/agent-runner.js';
import { EncryptedAgentRunStore, StaticAgentVaultKeyProvider } from './encrypted-run-store.js';
import { JsonAgentRunStore, MemoryAgentRunStore } from './run-store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const run: AgentRun = {
  schemaVersion: AGENT_CONTRACT_VERSION, id: 'encrypted-run', provider: 'fake', state: 'queued', requestedAt: '2026-08-13T00:00:00Z', updatedAt: '2026-08-13T00:00:00Z', currentSequence: 0,
  request: { provider: 'fake', task: 'private task', workspaceRoot: 'C:/safe', runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' }
};

describe('EncryptedAgentRunStore', () => {
  it('encrypts classified persisted fields and authenticates reads', async () => {
    const inner = new MemoryAgentRunStore();
    const store = new EncryptedAgentRunStore(inner, new StaticAgentVaultKeyProvider(randomBytes(32)));
    await store.create(run);
    expect((await inner.get(run.id))?.request.task).toMatch(/^agent-vault:v1:/);
    expect((await store.get(run.id))?.request.task).toBe('private task');
    const event: AgentEvent = { schemaVersion: AGENT_CONTRACT_VERSION, runId: run.id, provider: 'fake', sequence: 1, timestamp: '2026-08-13T00:00:01Z', correlationId: 'c1', kind: 'agent_message_completed', data: { text: 'private answer', safeCode: 'ok' } };
    await store.append(event);
    await expect(store.append(event)).resolves.toBe('duplicate');
    await expect(store.append({ ...event, data: { text: 'changed' } })).rejects.toThrow('Widersprüchliches');
    expect((await inner.events(run.id))[0]?.data.text).toMatch(/^agent-vault:v1:/);
    expect((await store.events(run.id))[0]?.data).toEqual({ text: 'private answer', safeCode: 'ok' });
    expect((await store.export(run.id)).events[0]?.data.text).toBe('[REDACTED]');
  });

  it('fails closed with a different key', async () => {
    const inner = new MemoryAgentRunStore();
    const first = new EncryptedAgentRunStore(inner, new StaticAgentVaultKeyProvider(randomBytes(32)));
    await first.create(run);
    const wrong = new EncryptedAgentRunStore(inner, new StaticAgentVaultKeyProvider(randomBytes(32)));
    await expect(wrong.get(run.id)).rejects.toThrow('agent_vault_authentication_failed');
  });

  it('keeps a terminal failure readable without crossing encryption contexts', async () => {
    const inner = new MemoryAgentRunStore();
    const store = new EncryptedAgentRunStore(inner, new StaticAgentVaultKeyProvider(randomBytes(32)));
    const failing = structuredClone(run); failing.id = 'failure-run'; failing.state = 'running'; failing.startedAt = failing.requestedAt;
    await store.create(failing);
    await store.append({ schemaVersion: AGENT_CONTRACT_VERSION, runId: failing.id, provider: 'fake', sequence: 1, timestamp: '2026-08-13T00:00:01Z', correlationId: 'c1', kind: 'run_completed', data: { state: 'failed', failure: { code: 'synthetic', message: 'private failure detail', retryable: false } } });
    const loaded = await store.get(failing.id);
    expect(loaded?.state).toBe('failed');
    expect(loaded?.failure).toEqual({ code: 'synthetic', message: 'private failure detail', retryable: false });
    expect((await store.events(failing.id))[0]?.data).toMatchObject({ state: 'failed', failure: { message: 'private failure detail' } });
  });

  it('never writes prompt or response canaries to the disk index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'encrypted-agent-store-')); roots.push(root);
    const store = new EncryptedAgentRunStore(new JsonAgentRunStore(join(root, 'runs')), new StaticAgentVaultKeyProvider(randomBytes(32)));
    const canaryRun = structuredClone(run); canaryRun.id = 'disk-canary'; canaryRun.request.task = 'CANARY_PRIVATE_PROMPT_92FD';
    canaryRun.request.metadata = { userPrompt: 'CANARY_CAMELCASE_PROMPT_4C21' };
    await store.create(canaryRun);
    await store.append({ schemaVersion: AGENT_CONTRACT_VERSION, runId: canaryRun.id, provider: 'fake', sequence: 1, timestamp: '2026-08-13T00:00:01Z', correlationId: 'c1', kind: 'agent_message_completed', data: { text: 'CANARY_PRIVATE_RESPONSE_A01C', state: 'safe' } });
    const persisted = `${await readFile(join(root, 'runs', canaryRun.id, 'run.json'), 'utf8')}\n${await readFile(join(root, 'runs', canaryRun.id, 'events.jsonl'), 'utf8')}`;
    expect(persisted).not.toContain('CANARY_PRIVATE_PROMPT_92FD');
    expect(persisted).not.toContain('CANARY_CAMELCASE_PROMPT_4C21');
    expect(persisted).not.toContain('CANARY_PRIVATE_RESPONSE_A01C');
    expect((await store.get(canaryRun.id))?.request.task).toBe('CANARY_PRIVATE_PROMPT_92FD');
    expect((await store.get(canaryRun.id))?.request.metadata?.userPrompt).toBe('CANARY_CAMELCASE_PROMPT_4C21');
  });

  it('migrates formerly unclassified camelCase prompt metadata during recovery', async () => {
    const inner = new MemoryAgentRunStore();
    const key = new StaticAgentVaultKeyProvider(randomBytes(32));
    const legacy = structuredClone(run); legacy.id = 'legacy-run'; legacy.request.metadata = { userPrompt: 'LEGACY_CANARY_71BE' };
    await inner.create(legacy);
    const store = new EncryptedAgentRunStore(inner, key);
    await store.recover();
    expect((await inner.get(legacy.id))?.request.metadata?.userPrompt).toMatch(/^agent-vault:v1:/);
    expect((await store.get(legacy.id))?.request.metadata?.userPrompt).toBe('LEGACY_CANARY_71BE');
  });

  it('repairs a legacy event-AAD failure copied into the run snapshot', async () => {
    const inner = new MemoryAgentRunStore();
    const store = new EncryptedAgentRunStore(inner, new StaticAgentVaultKeyProvider(randomBytes(32)));
    const failing = structuredClone(run); failing.id = 'legacy-failure'; failing.state = 'running'; failing.startedAt = failing.requestedAt;
    await store.create(failing);
    await store.append({ schemaVersion: AGENT_CONTRACT_VERSION, runId: failing.id, provider: 'fake', sequence: 1, timestamp: '2026-08-13T00:00:01Z', correlationId: 'c1', kind: 'run_completed', data: { state: 'failed', failure: { code: 'legacy', message: 'recoverable detail', retryable: false } } });
    const rawRun = (await inner.get(failing.id))!;
    const rawEvent = (await inner.events(failing.id))[0]!;
    rawRun.failure = (rawEvent.data as { failure: AgentRun['failure'] }).failure;
    await inner.update(rawRun);
    await expect(store.get(failing.id)).rejects.toThrow('agent_vault_authentication_failed');
    expect((await store.recover()).errors).toEqual([]);
    await expect(store.get(failing.id)).resolves.toMatchObject({ failure: { code: 'legacy', message: 'recoverable detail' } });
  });
});
