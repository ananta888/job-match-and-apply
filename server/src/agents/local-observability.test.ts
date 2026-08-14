import { mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AgentLocalObservability, assertLocalObservabilityPath } from './local-observability.js';

describe('AgentLocalObservability', () => {
  it('correlates layers without writing raw IDs, prompts, mail, identity, or error messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-observability-'));
    const path = join(root, 'events.jsonl');
    const log = new AgentLocalObservability(path, root);
    await log.record({
      level: 'error', component: 'provider-adapter', operation: 'run.start', code: 'provider_failed',
      correlationId: 'CORRELATION-CANARY', runId: 'RUN-CANARY', provider: 'fake', providerVersion: '1.0.0',
      durationMs: 25, eventSequence: 4, errorClass: 'provider_exit'
    }, new Date('2026-08-14T00:00:00Z'));
    const serialized = await readFile(path, 'utf8');
    expect(serialized).not.toMatch(/CORRELATION-CANARY|RUN-CANARY|prompt|mail|identity|message/i);
    expect(await log.readLocal()).toEqual([expect.objectContaining({ component: 'provider-adapter', operation: 'run.start', code: 'provider_failed', correlationHash: expect.stringMatching(/^sha256:/) })]);
  });

  it('rejects arbitrary debug detail fields instead of attempting best-effort redaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-observability-'));
    const log = new AgentLocalObservability(join(root, 'events.jsonl'), root);
    await expect(log.record({ level: 'debug', component: 'api', operation: 'request', code: 'debug', message: 'PRIVATE-MAIL-CANARY' } as never)).rejects.toThrow('observability_field_not_allowed');
  });

  it('requires configured logs to remain below the dedicated local-data root', () => {
    const root = resolve('C:/synthetic/local-data');
    expect(() => assertLocalObservabilityPath(root, resolve(root, 'logs/events.jsonl'))).not.toThrow();
    expect(() => assertLocalObservabilityPath(root, resolve(root, '../tracked/events.jsonl'))).toThrow('observability_path_outside_local_data');
  });
});
