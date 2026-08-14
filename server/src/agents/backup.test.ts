import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentBackupBundle, createAgentBackupManifest, migrateAgentBackupManifest,
  readAgentBackupManifest, restoreAgentBackupBundle, validateAgentBackup, validateAgentBackupBundle,
  type AgentBackupManifest
} from './backup.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ root: string; source: string; bundle: string; target: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-backup-')); roots.push(root);
  const source = join(root, 'source');
  await mkdir(join(source, 'agent-runs'), { recursive: true });
  await mkdir(join(source, 'keys'), { recursive: true });
  await writeFile(join(source, 'agent-runs', 'run.json'), '{"synthetic":true}');
  await writeFile(join(source, 'keys', 'vault.key'), 'synthetic-key-material');
  return { root, source, bundle: join(root, 'backup-001'), target: join(root, 'restored') };
}

const files = [
  { path: 'agent-runs/run.json', classification: 'personal' as const },
  { path: 'keys/vault.key', classification: 'secret' as const }
];

describe('agent backup manifests', () => {
  it('hashes a consistent synthetic backup and detects tampering', async () => {
    const { source } = await fixture();
    const manifest = await createAgentBackupManifest(source, files, new Date('2026-08-13T00:00:00Z'));
    expect(manifest).toMatchObject({ contractVersion: '1.1', requiresKeyMaterial: true, keyMaterialPaths: ['keys/vault.key'] });
    expect(await validateAgentBackup(source, manifest)).toMatchObject({ valid: true, checked: 2 });
    await writeFile(join(source, 'agent-runs', 'run.json'), 'tampered');
    expect(await validateAgentBackup(source, manifest)).toMatchObject({ valid: false, errors: [{ path: 'agent-runs/run.json', reason: 'size_mismatch' }] });
  });

  it('rejects paths outside the backup root, duplicates and unknown versions', async () => {
    const { source } = await fixture();
    await expect(createAgentBackupManifest(source, [{ path: '../secret', classification: 'secret' }])).rejects.toThrow('backup_path_is_not_safe');
    await expect(createAgentBackupManifest(source, [files[0]!, files[0]!])).rejects.toThrow('duplicate_backup_entry');
    expect(await validateAgentBackup(source, { contract: 'agent-control-backup', contractVersion: '2.0' as '1.0', createdAt: '', entries: [], requiresKeyMaterial: true })).toMatchObject({ valid: false, errors: [{ reason: 'unsupported_backup_contract' }] });
  });

  it('migrates 1.0 metadata deterministically without changing source data', async () => {
    const { source } = await fixture();
    const current = await createAgentBackupManifest(source, files, new Date('2026-08-13T00:00:00Z'));
    const legacy: AgentBackupManifest = {
      contract: 'agent-control-backup', contractVersion: '1.0', createdAt: current.createdAt,
      entries: current.entries, requiresKeyMaterial: true
    };
    const first = migrateAgentBackupManifest(legacy);
    const second = migrateAgentBackupManifest(legacy);
    expect(first).toMatchObject({ changed: true, fromVersion: '1.0', toVersion: '1.1' });
    expect(first.manifest.backupId).toBe(second.manifest.backupId);
    expect(first.manifest).toMatchObject({ keyMaterialPaths: ['keys/vault.key'] });
    expect(migrateAgentBackupManifest(first.manifest)).toMatchObject({ changed: false });
  });
});

describe('atomic backup and restore workflow', () => {
  it('creates a self-validating bundle and performs a write-free restore dry run', async () => {
    const { source, bundle, target } = await fixture();
    const created = await createAgentBackupBundle(source, bundle, files, new Date('2026-08-13T00:00:00Z'));
    expect(created.bundleRoot).toBe(await realpath(bundle));
    expect(await validateAgentBackupBundle(bundle)).toMatchObject({ valid: true, checked: 2 });
    expect((await readAgentBackupManifest(bundle)).manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(restoreAgentBackupBundle(bundle, target, { approvedTargetRoot: target, dryRun: true })).resolves.toMatchObject({ status: 'planned', files: 2, overwrite: false });
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not create a missing target parent during dry-run', async () => {
    const { root, source, bundle } = await fixture();
    await createAgentBackupBundle(source, bundle, files);
    const target = join(root, 'missing-parent', 'restored');
    await expect(restoreAgentBackupBundle(bundle, target, { approvedTargetRoot: target, dryRun: true })).rejects.toThrow('restore_target_parent_missing');
    await expect(readFile(join(root, 'missing-parent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores all files by atomic directory publication and writes the migrated manifest', async () => {
    const { source, bundle, target } = await fixture();
    await createAgentBackupBundle(source, bundle, files);
    await expect(restoreAgentBackupBundle(bundle, target, { approvedTargetRoot: target })).resolves.toMatchObject({ status: 'restored', files: 2 });
    expect(await readFile(join(target, 'agent-runs', 'run.json'), 'utf8')).toBe('{"synthetic":true}');
    expect(await readFile(join(target, 'keys', 'vault.key'), 'utf8')).toBe('synthetic-key-material');
    expect(JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))).toMatchObject({ contractVersion: '1.1' });
  });

  it('migrates a legacy 1.0 bundle during preflight and publishes only version 1.1', async () => {
    const { source, bundle, target } = await fixture();
    const { manifest } = await createAgentBackupBundle(source, bundle, files, new Date('2026-08-13T00:00:00Z'));
    const legacy: AgentBackupManifest = {
      contract: 'agent-control-backup', contractVersion: '1.0', createdAt: manifest.createdAt,
      entries: manifest.entries, requiresKeyMaterial: true
    };
    await writeFile(join(bundle, 'manifest.json'), `${JSON.stringify(legacy)}\n`);
    await expect(restoreAgentBackupBundle(bundle, target, { approvedTargetRoot: target, dryRun: true })).resolves.toMatchObject({ status: 'planned', migrated: true });
    await restoreAgentBackupBundle(bundle, target, { approvedTargetRoot: target });
    expect(JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))).toMatchObject({ contractVersion: '1.1', keyMaterialPaths: ['keys/vault.key'] });
  });

  it('requires exact target approval and explicit overwrite', async () => {
    const { root, source, bundle, target } = await fixture();
    await createAgentBackupBundle(source, bundle, files);
    await expect(restoreAgentBackupBundle(bundle, target, { approvedTargetRoot: join(root, 'other') })).rejects.toThrow('restore_target_not_explicitly_approved');
    await mkdir(target); await writeFile(join(target, 'old.txt'), 'old');
    await expect(restoreAgentBackupBundle(bundle, target, { approvedTargetRoot: target })).rejects.toThrow('restore_target_exists');
    await expect(restoreAgentBackupBundle(bundle, target, { approvedTargetRoot: target, allowOverwrite: true })).resolves.toMatchObject({ overwrite: true });
    await expect(readFile(join(target, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on tampering and missing key material before touching the target', async () => {
    const { source, bundle, target } = await fixture();
    await createAgentBackupBundle(source, bundle, files);
    await rm(join(bundle, 'files', 'keys', 'vault.key'));
    expect(await validateAgentBackupBundle(bundle)).toMatchObject({ valid: false, errors: [{ path: 'keys/vault.key', reason: 'key_material_missing' }] });
    await expect(restoreAgentBackupBundle(bundle, target, { approvedTargetRoot: target })).rejects.toThrow('backup_not_recoverable:key_material_missing');
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects manifest tampering independently of file hashes', async () => {
    const { source, bundle } = await fixture();
    await createAgentBackupBundle(source, bundle, files);
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')) as AgentBackupManifest;
    manifest.createdAt = '2026-08-14T00:00:00.000Z';
    await writeFile(join(bundle, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    expect(await validateAgentBackupBundle(bundle)).toMatchObject({ valid: false, checked: 0, errors: [{ reason: 'manifest_hash_mismatch' }] });
  });

  it('rejects symlinked backup entries where the platform supports symlinks', async () => {
    const { root, source } = await fixture();
    const outside = join(root, 'outside.txt'); await writeFile(outside, 'outside');
    const link = join(source, 'agent-runs', 'linked.json');
    try { await symlink(outside, link, 'file'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expect(createAgentBackupManifest(source, [{ path: 'agent-runs/linked.json', classification: 'personal' }])).rejects.toThrow('backup_entry_symlink_forbidden');
  });
});
