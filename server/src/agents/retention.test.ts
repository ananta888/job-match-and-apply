import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentRun } from '../ports/agent-runner.js';
import { AgentArtifactStore, type AgentArtifactProvenance } from './artifact-store.js';
import { MemoryAgentRunStore } from './run-store.js';
import { AgentRetentionCoordinator, AgentRetentionJournal, FileAgentRawLogRetentionPort } from './retention.js';

function run(id: string, applicationCaseId = `case-${id}`): AgentRun {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION, id, provider: 'fake', state: 'succeeded', currentSequence: 0,
    requestedAt: '2026-08-13T00:00:00Z', updatedAt: '2026-08-13T00:01:00Z', finishedAt: '2026-08-13T00:01:00Z',
    request: { provider: 'fake', task: 'synthetic', workspaceRoot: '.', runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny', applicationCaseId }
  };
}

function provenance(runId: string): AgentArtifactProvenance {
  return {
    runId, provider: 'fake', providerVersion: '1.0.0', adapterVersion: '1.0.0',
    templateId: 'application-draft', templateVersion: '1.0.0', applicationCaseId: `case-${runId}`,
    applicationCaseRevision: 1, jobId: `job-${runId}`, companyKey: `company-${runId}`,
    identityMode: 'real'
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-retention-'));
  const rawRoot = join(root, 'raw-logs'); await mkdir(rawRoot);
  const runs = new MemoryAgentRunStore();
  const artifacts = new AgentArtifactStore(join(root, 'artifacts'));
  const journal = new AgentRetentionJournal(join(root, 'retention', 'journal.jsonl'));
  const rawLogs = new FileAgentRawLogRetentionPort(rawRoot);
  const coordinator = new AgentRetentionCoordinator(runs, artifacts, rawLogs, journal, () => new Date('2026-08-14T00:00:00Z'));
  return { root, rawRoot, runs, artifacts, journal, coordinator };
}

describe('AgentRetentionCoordinator', () => {
  it('previews and performs a confirmed cascade while retaining used-document provenance', async () => {
    const { rawRoot, runs, artifacts, journal, coordinator } = await fixture();
    await runs.create(run('run-one'));
    await mkdir(join(rawRoot, 'run-one')); await writeFile(join(rawRoot, 'run-one', 'stdout.log'), 'raw-canary');
    const proposed = await artifacts.create({ kind: 'cover-letter', content: 'synthetic document', mediaType: 'text/plain', relativePath: 'drafts/letter.txt', provenance: provenance('run-one') });
    const approved = await artifacts.review(proposed.id, 'approved', 0, 'local-user');
    const used = await artifacts.adopt(approved.id, 1, { adopt: async () => ({ applicationCaseId: 'case-run-one', jobId: 'job-run-one', companyKey: 'company-run-one', sourceReference: 'application:case-run-one' }) });

    const preview = await coordinator.preview(['run-one'], 'local-user');
    expect(preview.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'run', id: 'run-one', action: 'delete' }),
      expect.objectContaining({ kind: 'raw_log', bytes: 10, action: 'delete' }),
      expect.objectContaining({ kind: 'artifact_metadata', id: used.id, action: 'retain_used_metadata' }),
      expect.objectContaining({ kind: 'artifact_blob', action: 'delete' })
    ]));
    await expect(coordinator.execute(preview, preview.digest, 'local-user')).resolves.toEqual({ deletedRuns: ['run-one'], retainedUsedMetadata: [used.id] });
    expect(await runs.get('run-one')).toBeUndefined();
    expect(await artifacts.get(used.id)).toMatchObject({ lifecycle: 'used', contentState: 'deleted', sha256: used.sha256, provenance: { runId: 'run-one' } });
    await expect(artifacts.read(used.id)).rejects.toMatchObject({ message: 'artifact_content_deleted', statusCode: 410 });
    await expect(readFile(join(rawRoot, 'run-one', 'stdout.log'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await journal.auditEntries()).map((entry) => entry.type)).toEqual(['deletion_previewed', 'deletion_executed']);
  });

  it('fails closed on legal holds and requires explicit release plus a new preview', async () => {
    const { runs, artifacts, journal, coordinator } = await fixture();
    await runs.create(run('held-run'));
    const artifact = await artifacts.create({ kind: 'cv', content: 'synthetic', mediaType: 'text/plain', provenance: provenance('held-run') });
    const hold = await journal.createHold({ scope: 'application_case', referenceId: 'case-held-run', reasonCode: 'legal_dispute', actor: 'operator' }, new Date('2026-08-13T00:00:00Z'));
    const blocked = await coordinator.preview(['held-run'], 'operator');
    expect(blocked.protectedReferences).toEqual(expect.arrayContaining(['run:held-run', `artifact:${artifact.id}`]));
    await expect(coordinator.execute(blocked, blocked.digest, 'operator')).rejects.toThrow('retention_protected_references_present');
    expect(await runs.get('held-run')).toBeDefined();
    await journal.releaseHold(hold.id, 'operator', new Date('2026-08-14T00:00:00Z'));
    const released = await coordinator.preview(['held-run'], 'operator');
    expect(released.digest).not.toBe(blocked.digest);
    await expect(coordinator.execute(blocked, blocked.digest, 'operator')).rejects.toThrow('retention_preview_stale');
  });

  it('deletes selected metadata but retains a blob referenced by another artifact', async () => {
    const { runs, artifacts, coordinator } = await fixture();
    await runs.create(run('selected')); await runs.create(run('other'));
    const selected = await artifacts.create({ kind: 'cv', content: 'shared bytes', mediaType: 'text/plain', provenance: provenance('selected') });
    const other = await artifacts.create({ kind: 'cv', content: 'shared bytes', mediaType: 'text/plain', provenance: provenance('other') });
    const preview = await coordinator.preview(['selected'], 'operator');
    expect(preview.resources).toContainEqual(expect.objectContaining({ kind: 'artifact_blob', action: 'retain_shared_content', protectedBy: [other.id] }));
    await coordinator.execute(preview, preview.digest, 'operator');
    expect(await artifacts.get(selected.id)).toBeUndefined();
    await expect(artifacts.read(other.id)).resolves.toMatchObject({ content: Buffer.from('shared bytes') });
  });

  it('fails closed when the append-only hold journal is corrupt', async () => {
    const { root, journal } = await fixture();
    await journal.createHold({ scope: 'run', referenceId: 'run-one', reasonCode: 'legal_dispute', actor: 'operator' });
    await writeFile(join(root, 'retention', 'journal.jsonl'), '{broken\n', 'utf8');
    await expect(journal.holds()).rejects.toThrow('retention_journal_corrupt');
  });
});
