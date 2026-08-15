import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentEvent, type AgentRun } from '../ports/agent-runner.js';
import { EncryptedAgentRunStore, StaticAgentVaultKeyProvider } from './encrypted-run-store.js';
import { JsonAgentRunStore } from './run-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function cvRun(id: string, canary: string): AgentRun {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION,
    id,
    provider: 'fake',
    state: 'queued',
    requestedAt: '2026-08-15T08:00:00.000Z',
    updatedAt: '2026-08-15T08:00:00.000Z',
    currentSequence: 0,
    request: {
      provider: 'fake',
      task: `CV source text: ${canary}`,
      workspaceRoot: 'C:/private/cv-ai-workspace',
      runtimeTarget: 'windows',
      sandbox: 'read-only',
      network: 'disabled',
      approvalMode: 'deny',
      metadata: {
        workflowId: 'cv-ai-structuring',
        cvAiStructuringRunId: id,
        cvImportId: '11111111-1111-4111-8111-111111111111',
        requiredRootMcpTools: [],
        providerToolMode: 'none',
        sourceSha256: 'a'.repeat(64),
        expiresAt: '2026-08-16T08:00:00.000Z',
      },
    },
  };
}

function event(run: AgentRun, sequence: number, kind: string, data: Record<string, unknown>): AgentEvent {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION,
    runId: run.id,
    provider: run.provider,
    sequence,
    timestamp: `2026-08-15T08:00:0${sequence}.000Z`,
    correlationId: `${run.id}-correlation`,
    kind,
    data,
  };
}

async function appendCreated(store: EncryptedAgentRunStore, run: AgentRun): Promise<void> {
  await store.create(run);
  await store.append(event(run, 1, 'run_created', {
    request: run.request,
    requestedAt: run.requestedAt,
  }));
}

async function appendStarted(store: EncryptedAgentRunStore, run: AgentRun): Promise<void> {
  await store.update({ ...(await store.get(run.id))!, state: 'starting' });
  await store.append(event(run, 2, 'process_started', { pid: 4242 }));
}

async function persistedText(root: string, runId: string): Promise<string> {
  return `${await readFile(join(root, runId, 'run.json'), 'utf8')}\n${await readFile(join(root, runId, 'events.jsonl'), 'utf8')}`;
}

describe('EncryptedAgentRunStore disk restart recovery', () => {
  it('recovers encrypted run_created timelines by plaintext identity and keeps terminal CV runs selectively purgeable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'encrypted-run-restart-'));
    roots.push(root);
    const key = new StaticAgentVaultKeyProvider(randomBytes(32));
    const first = new EncryptedAgentRunStore(new JsonAgentRunStore(root), key);
    const active = cvRun('cv-ai-active-restart', 'PRIVATE-CV-ACTIVE-CANARY-83D1');
    const terminal = cvRun('cv-ai-terminal-restart', 'PRIVATE-CV-TERMINAL-CANARY-40B7');

    await appendCreated(first, active);
    await appendStarted(first, active);
    await appendCreated(first, terminal);
    await appendStarted(first, terminal);
    await first.append(event(terminal, 3, 'run_completed', { state: 'succeeded' }));

    const beforeRestart = `${await persistedText(root, active.id)}\n${await persistedText(root, terminal.id)}`;
    expect(beforeRestart).not.toContain('PRIVATE-CV-ACTIVE-CANARY-83D1');
    expect(beforeRestart).not.toContain('PRIVATE-CV-TERMINAL-CANARY-40B7');

    const restarted = new EncryptedAgentRunStore(new JsonAgentRunStore(root), key);
    const recovery = await restarted.recover();

    expect(recovery.errors).toEqual([]);
    expect(recovery.recovered).toEqual([active.id]);
    await expect(restarted.get(active.id)).resolves.toMatchObject({
      id: active.id,
      state: 'orphaned',
      currentSequence: 2,
      request: {
        task: expect.stringContaining('PRIVATE-CV-ACTIVE-CANARY-83D1'),
        metadata: { workflowId: 'cv-ai-structuring', requiredRootMcpTools: [], expiresAt: '2026-08-16T08:00:00.000Z' },
      },
    });
    await expect(restarted.get(terminal.id)).resolves.toMatchObject({
      id: terminal.id,
      state: 'succeeded',
      currentSequence: 3,
      request: {
        task: expect.stringContaining('PRIVATE-CV-TERMINAL-CANARY-40B7'),
        metadata: { workflowId: 'cv-ai-structuring', requiredRootMcpTools: [], expiresAt: '2026-08-16T08:00:00.000Z' },
      },
    });
    expect((await restarted.events(terminal.id))[0]?.data).toMatchObject({
      request: { task: expect.stringContaining('PRIVATE-CV-TERMINAL-CANARY-40B7') },
    });

    await expect(restarted.deleteRuns([terminal.id], { dryRun: true })).resolves.toEqual([
      { runId: terminal.id, events: 3 },
    ]);
    expect(await restarted.get(terminal.id)).toBeDefined();
    await expect(restarted.deleteRuns([terminal.id])).resolves.toEqual([{ runId: terminal.id, events: 3 }]);
    expect(await restarted.get(terminal.id)).toBeUndefined();

    const afterRestart = await persistedText(root, active.id);
    expect(afterRestart).not.toContain('PRIVATE-CV-ACTIVE-CANARY-83D1');
  });

  it.each([
    ['unknown envelope version', (text: string) => text.replace('agent-vault:v1:', 'agent-vault:v9:opaque.')],
    ['malformed v1 envelope', (text: string) => text.replace(/agent-vault:v1:[^"\\]+/, 'agent-vault:v1:malformed')],
  ])('fails closed for an %s without rewriting the encrypted event log', async (_label, mutate) => {
    const root = await mkdtemp(join(tmpdir(), 'encrypted-run-malformed-'));
    roots.push(root);
    const key = new StaticAgentVaultKeyProvider(randomBytes(32));
    const run = cvRun('cv-ai-malformed-restart', 'PRIVATE-CV-MALFORMED-CANARY-2F9A');
    const first = new EncryptedAgentRunStore(new JsonAgentRunStore(root), key);
    await appendCreated(first, run);
    const eventPath = join(root, run.id, 'events.jsonl');
    const mutated = mutate(await readFile(eventPath, 'utf8'));
    await writeFile(eventPath, mutated, 'utf8');

    const restarted = new EncryptedAgentRunStore(new JsonAgentRunStore(root), key);
    const recovery = await restarted.recover();

    expect(recovery.recovered).toEqual([]);
    expect(recovery.errors).toEqual([
      expect.objectContaining({ runId: run.id, message: expect.stringMatching(/^agent_vault_(?:version_unsupported|ciphertext_malformed)$/) }),
    ]);
    expect(await readFile(eventPath, 'utf8')).toBe(mutated);
    expect(mutated).not.toContain('PRIVATE-CV-MALFORMED-CANARY-2F9A');
  });

  it('fails closed with the wrong restart key and leaves all encrypted bytes untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'encrypted-run-wrong-key-'));
    roots.push(root);
    const run = cvRun('cv-ai-wrong-key-restart', 'PRIVATE-CV-WRONG-KEY-CANARY-C153');
    const first = new EncryptedAgentRunStore(
      new JsonAgentRunStore(root),
      new StaticAgentVaultKeyProvider(randomBytes(32)),
    );
    await appendCreated(first, run);
    const before = await persistedText(root, run.id);

    const restarted = new EncryptedAgentRunStore(
      new JsonAgentRunStore(root),
      new StaticAgentVaultKeyProvider(randomBytes(32)),
    );
    const recovery = await restarted.recover();

    expect(recovery.recovered).toEqual([]);
    expect(recovery.errors).toEqual([
      expect.objectContaining({ runId: run.id, message: 'agent_vault_authentication_failed' }),
    ]);
    expect(await persistedText(root, run.id)).toBe(before);
    expect(before).not.toContain('PRIVATE-CV-WRONG-KEY-CANARY-C153');
  });

  it('rejects valid ciphertext copied from run AAD into the run_created event context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'encrypted-run-aad-swap-'));
    roots.push(root);
    const key = new StaticAgentVaultKeyProvider(randomBytes(32));
    const run = cvRun('cv-ai-aad-swap-restart', 'PRIVATE-CV-AAD-CANARY-0D6E');
    const first = new EncryptedAgentRunStore(new JsonAgentRunStore(root), key);
    await appendCreated(first, run);

    const runPath = join(root, run.id, 'run.json');
    const eventPath = join(root, run.id, 'events.jsonl');
    const runSnapshot = JSON.parse(await readFile(runPath, 'utf8')) as { request: { task: string } };
    const eventSnapshot = JSON.parse((await readFile(eventPath, 'utf8')).trim()) as {
      data: { request: { task: string } };
    };
    eventSnapshot.data.request.task = runSnapshot.request.task;
    await writeFile(eventPath, `${JSON.stringify(eventSnapshot)}\n`, 'utf8');
    const tampered = await persistedText(root, run.id);

    const restarted = new EncryptedAgentRunStore(new JsonAgentRunStore(root), key);
    const recovery = await restarted.recover();

    expect(recovery.recovered).toEqual([]);
    expect(recovery.errors).toEqual([
      expect.objectContaining({ runId: run.id, message: 'agent_vault_authentication_failed' }),
    ]);
    expect(await persistedText(root, run.id)).toBe(tampered);
    expect(tampered).not.toContain('PRIVATE-CV-AAD-CANARY-0D6E');
  });
});
