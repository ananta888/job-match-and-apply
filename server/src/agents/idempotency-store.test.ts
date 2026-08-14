import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { agentIdempotencyFingerprint, JsonAgentIdempotencyStore } from './idempotency-store.js';

describe('JsonAgentIdempotencyStore', () => {
  it('survives restart, binds parameters, and persists no request payload or raw key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-idempotency-'));
    const request = { provider: 'fake', task: 'PRIVATE-CANARY', options: { sandbox: 'read-only' } };
    const fingerprint = agentIdempotencyFingerprint(request);
    const first = new JsonAgentIdempotencyStore(root, () => new Date('2026-08-14T00:00:00Z'));
    const claim = await first.claim({ namespace: 'agent-run', key: 'user-key-with-private-name', requestFingerprint: fingerprint });
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error('claim expected');
    await first.complete({ namespace: 'agent-run', key: 'user-key-with-private-name', requestFingerprint: fingerprint, leaseToken: claim.leaseToken, result: { resourceType: 'agent-run', resourceId: 'run-42' } });

    const restarted = new JsonAgentIdempotencyStore(root, () => new Date('2026-08-14T00:01:00Z'));
    await expect(restarted.claim({ namespace: 'agent-run', key: 'user-key-with-private-name', requestFingerprint: fingerprint })).resolves.toEqual({
      status: 'replay', result: { resourceType: 'agent-run', resourceId: 'run-42' }, completedAt: '2026-08-14T00:00:00.000Z'
    });
    await expect(restarted.claim({ namespace: 'agent-run', key: 'user-key-with-private-name', requestFingerprint: agentIdempotencyFingerprint({ ...request, provider: 'other' }) })).rejects.toThrow('idempotency_key_conflict');
    const serialized = (await Promise.all((await readdir(root)).map((name) => readFile(join(root, name), 'utf8')))).join('');
    expect(serialized).not.toContain('PRIVATE-CANARY');
    expect(serialized).not.toContain('user-key-with-private-name');
  });

  it('does not let another lease complete a pending claim and reclaims only after expiry', async () => {
    let now = new Date('2026-08-14T00:00:00Z');
    const root = await mkdtemp(join(tmpdir(), 'agent-idempotency-'));
    const store = new JsonAgentIdempotencyStore(root, () => now);
    const fingerprint = agentIdempotencyFingerprint({ action: 'start' });
    const claim = await store.claim({ namespace: 'run', key: 'same', requestFingerprint: fingerprint, ttlMs: 1_000 });
    if (claim.status !== 'claimed') throw new Error('claim expected');
    expect(await store.claim({ namespace: 'run', key: 'same', requestFingerprint: fingerprint })).toMatchObject({ status: 'in_progress' });
    await expect(store.complete({ namespace: 'run', key: 'same', requestFingerprint: fingerprint, leaseToken: 'wrong', result: { resourceType: 'run', resourceId: 'one' } })).rejects.toThrow('idempotency_lease_mismatch');
    now = new Date('2026-08-14T00:00:02Z');
    expect(await store.claim({ namespace: 'run', key: 'same', requestFingerprint: fingerprint })).toMatchObject({ status: 'claimed' });
    expect(await store.pruneExpired()).toEqual({ matched: 0, removed: 0 });
  });

  it('canonicalizes object key order and rejects cycles', () => {
    expect(agentIdempotencyFingerprint({ b: 2, a: 1 })).toBe(agentIdempotencyFingerprint({ a: 1, b: 2 }));
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => agentIdempotencyFingerprint(cyclic)).toThrow('idempotency_fingerprint_cycle');
  });
});
