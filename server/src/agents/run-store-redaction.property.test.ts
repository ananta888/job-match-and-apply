import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentEvent, type AgentRun } from '../ports/agent-runner.js';
import { EncryptedAgentRunStore, StaticAgentVaultKeyProvider } from './encrypted-run-store.js';
import { MemoryAgentRunStore } from './run-store.js';

function run(): AgentRun {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION, id: 'redaction-property', provider: 'fake', state: 'queued', currentSequence: 0,
    requestedAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
    request: {
      provider: 'fake', task: 'PRIVATE_TASK_VALUE', workspaceRoot: 'C:/PRIVATE_WORKSPACE_VALUE', runtimeTarget: 'windows',
      sandbox: 'read-only', network: 'disabled', approvalMode: 'deny', metadata: {
        userPrompt: 'PRIVATE_CAMEL_PROMPT', user_prompt: 'PRIVATE_SNAKE_PROMPT',
        accessToken: 'PRIVATE_CAMEL_TOKEN', access_token: 'PRIVATE_SNAKE_TOKEN',
        runtimeExecutable: 'C:/PRIVATE_EXECUTABLE', password: 'PRIVATE_PASSWORD', safeCode: 'visible',
      },
    },
  };
}

function event(fixture: AgentRun): AgentEvent {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION, runId: fixture.id, provider: fixture.provider, sequence: 1,
    timestamp: '2026-08-14T00:00:01.000Z', correlationId: 'redaction-property-event', kind: 'agent_message_completed', data: {
      userPrompt: 'PRIVATE_EVENT_CAMEL', user_prompt: 'PRIVATE_EVENT_SNAKE',
      accessToken: 'PRIVATE_EVENT_TOKEN_CAMEL', access_token: 'PRIVATE_EVENT_TOKEN_SNAKE',
      stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR', inputTokens: 7, input_tokens: 8, safeCode: 'visible',
    },
  };
}

describe('run-store redaction and encryption properties', () => {
  it('redacts camelCase and snake_case secrets while preserving token counters and safe fields', async () => {
    const store = new MemoryAgentRunStore();
    const fixture = run();
    await store.create(fixture); await store.append(event(fixture));
    const exported = await store.export(fixture.id);
    const data = exported.events[0]!.data as Record<string, unknown>;
    for (const key of ['userPrompt', 'user_prompt', 'accessToken', 'access_token', 'stdout', 'stderr']) {
      expect(data[key], key).toBe('[REDACTED]');
    }
    expect(data).toMatchObject({ inputTokens: 7, input_tokens: 8, safeCode: 'visible' });
    expect(exported.run.request.task).toBe('[REDACTED]');
    expect(exported.run.request.workspaceRoot).toBe('[REDACTED]');
    expect(exported.run.request.metadata).toBe('[REDACTED]');
  });

  it('encrypts every classified run/event field before the inner store and reveals only through the vault', async () => {
    const inner = new MemoryAgentRunStore();
    const store = new EncryptedAgentRunStore(inner, new StaticAgentVaultKeyProvider(randomBytes(32)));
    const fixture = run();
    await store.create(fixture); await store.append(event(fixture));

    const persistedRun = (await inner.get(fixture.id))!;
    const persistedMetadata = persistedRun.request.metadata as Record<string, unknown>;
    for (const value of [
      persistedRun.request.task, persistedRun.request.workspaceRoot,
      persistedMetadata.userPrompt, persistedMetadata.user_prompt, persistedMetadata.accessToken,
      persistedMetadata.access_token, persistedMetadata.runtimeExecutable, persistedMetadata.password,
    ]) expect(value).toMatch(/^agent-vault:v1:/);
    expect(persistedMetadata.safeCode).toBe('visible');

    const persistedData = (await inner.events(fixture.id))[0]!.data as Record<string, unknown>;
    for (const key of ['userPrompt', 'user_prompt', 'accessToken', 'access_token', 'stdout', 'stderr']) {
      expect(persistedData[key], key).toMatch(/^agent-vault:v1:/);
    }
    expect(persistedData).toMatchObject({ inputTokens: 7, input_tokens: 8, safeCode: 'visible' });
    expect((await store.get(fixture.id))?.request).toEqual(fixture.request);
    expect((await store.events(fixture.id))[0]?.data).toEqual(event(fixture).data);

    const redacted = await store.export(fixture.id);
    expect(redacted.run.request.workspaceRoot).toBe('[REDACTED]');
    expect((redacted.events[0]!.data as Record<string, unknown>).accessToken).toBe('[REDACTED]');
  });
});
