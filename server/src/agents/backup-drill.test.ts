import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION } from '../ports/agent-runner.js';
import { AgentArtifactStore } from './artifact-store.js';
import { createAgentBackupBundle, restoreAgentBackupBundle, validateAgentBackupBundle } from './backup.js';
import { buildPortableAgentBackupInventory, runPortableAgentBackupDrill } from './backup-drill.js';
import { JsonAgentRunStore } from './run-store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function localDataFixture() {
  const root = await mkdtemp(join(tmpdir(), 'portable-agent-backup-')); roots.push(root);
  const localData = join(root, '.local-data'); await mkdir(localData);
  const runs = new JsonAgentRunStore(join(localData, 'agent-runs'));
  await runs.create({
    schemaVersion: AGENT_CONTRACT_VERSION, id: 'synthetic-run', provider: 'fake', state: 'succeeded', currentSequence: 0,
    requestedAt: '2026-08-14T00:00:00Z', updatedAt: '2026-08-14T00:01:00Z', finishedAt: '2026-08-14T00:01:00Z',
    request: { provider: 'fake', task: 'synthetic-only', workspaceRoot: '.', runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' }
  });
  const artifacts = new AgentArtifactStore(join(localData, 'agent-artifacts'));
  const artifact = await artifacts.create({
    kind: 'report', content: 'artifact-backed recovery canary', mediaType: 'text/plain', relativePath: 'reports/result.txt',
    provenance: { runId: 'synthetic-run', provider: 'fake', providerVersion: '1.0.0', adapterVersion: '1.0.0', templateId: 'synthetic', templateVersion: '1.0.0', identityMode: 'none' }
  });
  await mkdir(join(localData, 'keys')); await writeFile(join(localData, 'keys', 'agent-run-vault.key'), 'synthetic-key-material');
  return { root, localData, artifact };
}

describe('portable agent backup drill', () => {
  it('backs up real run/artifact/key layouts and verifies the restored content-addressed artifact', async () => {
    const { root, localData, artifact } = await localDataFixture();
    const bundle = join(root, 'bundle'); const restored = join(root, 'restored');
    const result = await runPortableAgentBackupDrill({
      localDataRoot: localData, bundleRoot: bundle, restoreTarget: restored, now: new Date('2026-08-14T00:00:00Z'),
      verifyRestored: async (target) => {
        const value = await new AgentArtifactStore(join(target, 'agent-artifacts')).read(artifact.id);
        expect(value.content.toString('utf8')).toBe('artifact-backed recovery canary');
        expect(await new JsonAgentRunStore(join(target, 'agent-runs')).get('synthetic-run')).toMatchObject({ state: 'succeeded' });
      }
    });
    expect(result.inventory.roots).toEqual(['agent-artifacts', 'agent-runs', 'keys']);
    expect(result.manifest.requiresKeyMaterial).toBe(true);
    expect(result.restoredFiles).toBe(result.inventory.files.length);
  });

  it('fails closed when portable key material is lost before restore', async () => {
    const { root, localData } = await localDataFixture();
    const bundle = join(root, 'bundle'); const restored = join(root, 'restored');
    const inventory = await buildPortableAgentBackupInventory(localData);
    await createAgentBackupBundle(localData, bundle, inventory.files);
    await rm(join(bundle, 'files', 'keys', 'agent-run-vault.key'));
    expect(await validateAgentBackupBundle(bundle)).toMatchObject({ valid: false, errors: [expect.objectContaining({ reason: 'key_material_missing' })] });
    await expect(restoreAgentBackupBundle(bundle, restored, { approvedTargetRoot: restored })).rejects.toThrow('backup_not_recoverable:key_material_missing');
  });

  it('cleans an unpublished bundle after deterministic disk-full injection', async () => {
    const { root, localData } = await localDataFixture();
    const bundle = join(root, 'bundle'); const inventory = await buildPortableAgentBackupInventory(localData);
    await expect(createAgentBackupBundle(localData, bundle, inventory.files, new Date(), {
      afterFileWrite: (phase, _path, index) => {
        if (phase === 'backup' && index === 1) throw Object.assign(new Error('synthetic_disk_full'), { code: 'ENOSPC' });
      }
    })).rejects.toMatchObject({ message: 'synthetic_disk_full', code: 'ENOSPC' });
    await expect(readFile(bundle)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).some((name) => name.includes('.bundle.staging-'))).toBe(false);
  });

  it('rolls an overwritten target back when publication fails after the old target was moved', async () => {
    const { root, localData } = await localDataFixture();
    const bundle = join(root, 'bundle'); const target = join(root, 'restored');
    const inventory = await buildPortableAgentBackupInventory(localData);
    await createAgentBackupBundle(localData, bundle, inventory.files);
    await mkdir(target); await writeFile(join(target, 'old.txt'), 'rollback-sentinel');
    await expect(restoreAgentBackupBundle(bundle, target, {
      approvedTargetRoot: target, allowOverwrite: true,
      faultInjector: { beforePublish: (phase) => { if (phase === 'restore') throw new Error('synthetic_publish_failure'); } }
    })).rejects.toThrow('synthetic_publish_failure');
    expect(await readFile(join(target, 'old.txt'), 'utf8')).toBe('rollback-sentinel');
    expect((await readdir(root)).some((name) => name.includes('.restored.rollback-') || name.includes('.restored.restore-'))).toBe(false);
  });
});
