import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { domainCommandHash, JsonDomainCommandExecutionStore } from './domain-command-execution-store.js';

const keyHash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const identity = (hash: string) => ({
  commandId: 'cmd-command-1', applicationCaseId: 'case-1', expectedRevision: 3, idempotencyKeySha256: hash,
});
const command = {
  commandId: 'cmd-command-1', proposalId: 'proposal-1', proposalPayloadHash: 'x'.repeat(43),
  applicationCaseId: 'case-1', expectedRevision: 3, idempotencyKeySha256: keyHash('idem-restart-1'),
  prepared: {
    kind: 'follow_up_reminder', execution: 'local_write', applicationCaseId: 'case-1',
    proposalId: 'proposal-1', proposalPayloadHash: 'x'.repeat(43), dueAt: '2029-02-01T09:00:00.000Z',
    timeZone: 'Europe/Berlin', note: 'Nachfassen',
  },
  dryRun: { action: 'follow_up_reminder' },
};

describe('durable domain command execution store', () => {
  it('replays a completed result after restart without persisting the raw idempotency key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domain-command-restart-'));
    const hash = keyHash('idem-restart-1');
    const first = new JsonDomainCommandExecutionStore(root);
    const confirmed = await first.confirm({ ...identity(hash), command });
    expect(confirmed.commandSha256).toBe(domainCommandHash(command));
    expect(JSON.stringify(confirmed)).not.toContain('idem-restart-1');
    const claim = await first.begin(identity(hash));
    if (claim.outcome !== 'execute') throw new Error('expected execute claim');
    await first.complete({
      idempotencyKeySha256: hash, leaseToken: claim.leaseToken,
      result: { revision: 3, result: { reminderId: 'reminder-1' } },
    });

    const restarted = new JsonDomainCommandExecutionStore(root);
    await expect(restarted.begin(identity(hash))).resolves.toMatchObject({
      outcome: 'duplicate', result: { revision: 3, result: { reminderId: 'reminder-1' } },
    });
  });

  it('binds an idempotency key to the exact command and coalesces concurrent execution claims', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domain-command-conflict-'));
    const hash = keyHash('idem-conflict-1');
    const store = new JsonDomainCommandExecutionStore(root);
    await store.confirm({ ...identity(hash), command: { ...command, idempotencyKeySha256: hash } });
    await expect(store.confirm({
      ...identity(hash), command: { ...command, idempotencyKeySha256: hash, dryRun: { changed: true } },
    })).rejects.toThrow('idempotency_key_reused_for_different_command');

    const claims = await Promise.allSettled([store.begin(identity(hash)), store.begin(identity(hash))]);
    expect(claims.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(String((claims.find((item) => item.status === 'rejected') as PromiseRejectedResult).reason))
      .toContain('execution_in_progress');
  });

  it('allows a crashed execution lease to resume only after expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domain-command-lease-'));
    let current = new Date('2029-01-01T00:00:00.000Z');
    const hash = keyHash('idem-lease-1');
    const store = new JsonDomainCommandExecutionStore(root, () => current, 1_000);
    await store.confirm({ ...identity(hash), command: { ...command, idempotencyKeySha256: hash } });
    await expect(store.begin(identity(hash))).resolves.toMatchObject({ outcome: 'execute', resumed: false });
    await expect(store.begin(identity(hash))).rejects.toThrow('execution_in_progress');
    current = new Date('2029-01-01T00:00:01.001Z');
    await expect(new JsonDomainCommandExecutionStore(root, () => current, 1_000).begin(identity(hash)))
      .resolves.toMatchObject({ outcome: 'execute', resumed: true });
  });
});
