import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JsonVersionApprovalStore, MemoryVersionApprovalStore, VersionApprovalConflictError,
  VersionApprovalNotFoundError, isVersionApproved, parseVersionApprovalKey,
  type VersionApprovalKey,
} from './version-approvals.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const key: VersionApprovalKey = {
  provider: 'opencode',
  executable: 'C:\\tools\\opencode.exe',
  runtimeTarget: 'windows',
  version: '1.15.7',
};

describe('version approvals', () => {
  it('matches only the exact installation the user approved', () => {
    const approvals = [{ ...key, approvedAt: '2026-11-03T10:00:00.000Z' }];
    expect(isVersionApproved(approvals, key)).toBe(true);
    expect(isVersionApproved(approvals, { ...key, version: '1.15.8' })).toBe(false);
    expect(isVersionApproved(approvals, { ...key, provider: 'claude-cli' })).toBe(false);
    expect(isVersionApproved(approvals, { ...key, runtimeTarget: 'wsl' })).toBe(false);
    expect(isVersionApproved(approvals, { ...key, executable: 'C:/tools/opencode.exe' })).toBe(true);
  });

  it('rejects keys with unknown fields or unsafe values', () => {
    expect(() => parseVersionApprovalKey({ ...key, confirmed: true })).toThrow('version_approval_unknown_field');
    expect(() => parseVersionApprovalKey({ ...key, version: '' })).toThrow('version_approval_invalid_version');
    expect(() => parseVersionApprovalKey({ ...key, executable: 'bad\nname' })).toThrow('version_approval_invalid_executable');
    expect(() => parseVersionApprovalKey({ ...key, runtimeTarget: 'container' })).toThrow('version_approval_invalid_runtime');
  });

  it('persists approvals with compare-and-save and revokes them again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'version-approvals-'));
    roots.push(root);
    const store = new JsonVersionApprovalStore(join(root, 'approvals.json'));

    expect(await store.load()).toEqual({ schemaVersion: 1, updatedAt: null, approvals: [] });
    const first = await store.approve(key, null);
    expect(first.approvals).toHaveLength(1);
    expect(first.updatedAt).toBeTruthy();

    await expect(store.approve(key, null)).rejects.toBeInstanceOf(VersionApprovalConflictError);
    const second = await store.approve({ ...key, version: '1.15.8' }, first.updatedAt);
    expect(second.approvals).toHaveLength(2);

    const reopened = new JsonVersionApprovalStore(join(root, 'approvals.json'));
    const loaded = await reopened.load();
    expect(loaded.approvals).toEqual(second.approvals);
    expect(loaded.updatedAt).toBe(second.updatedAt);

    const revoked = await reopened.revoke(key, second.updatedAt);
    expect(revoked.approvals).toHaveLength(1);
    expect(revoked.approvals[0]?.version).toBe('1.15.8');
    const revokedSecond = await reopened.revoke({ ...key, version: '1.15.8' }, revoked.updatedAt);
    expect(revokedSecond.approvals).toHaveLength(0);
    await expect(reopened.revoke(key, revokedSecond.updatedAt)).rejects.toBeInstanceOf(VersionApprovalNotFoundError);

    const mode = (await stat(join(root, 'approvals.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('keeps the memory store on the same contract', async () => {
    const store = new MemoryVersionApprovalStore();
    const approved = await store.approve(key, null);
    expect(await isVersionApproved((await store.load()).approvals, key)).toBe(true);
    await expect(store.approve(key, null)).rejects.toBeInstanceOf(VersionApprovalConflictError);
    const revoked = await store.revoke(key, approved.updatedAt);
    expect(revoked.approvals).toHaveLength(0);
  });
});
