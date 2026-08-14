import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApplicationCase, ApplicationPipelineEvidence } from '../domain/models.js';
import {
  createArtifactRevision,
  markArtifactUsed,
  reviewArtifactRevision
} from './artifact-revisions.js';
import {
  ApplicationPipelineProofAuthority,
  StaticApplicationPipelineProofKeyProvider
} from './application-pipeline-proof.js';
import { MemoryWorkspaceStore } from './workspace-store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const application = (mode: 'real' | 'incognito', state: ApplicationCase['state'] = 'approved'): ApplicationCase => ({
  id: '11111111-1111-4111-8111-111111111111',
  job: { id: 'JOB-1', sourceId: 'test', title: 'Engineer', company: 'Acme GmbH', location: 'Berlin', workModel: 'hybrid', employmentType: 'full_time', description: '', skills: [] },
  identityId: mode,
  identityMode: mode,
  documentType: 'cover_letter',
  state,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  artifactNames: [],
  warnings: [],
  revision: 1
});

const authority = () => new ApplicationPipelineProofAuthority(
  new StaticApplicationPipelineProofKeyProvider(randomBytes(32))
);

async function proofFor(proofAuthority: ApplicationPipelineProofAuthority, app: ApplicationCase, content: string) {
  const artifactSha256 = digest(content);
  const evidence: ApplicationPipelineEvidence = {
    pipelineContractVersion: '1.0',
    completedStages: ['validate_profiles', 'analyze_job', 'build_match_matrix', 'questions_reviewed', 'validate_iteration', 'audit_claims', 'check_style'],
    annotatedSha256: digest('annotated'),
    iterationManifestSha256: digest('manifest'),
    candidateProfileSha256: digest('candidate'),
    styleProfileSha256: digest('style'),
    artifactSha256,
    preparation: {
      jobAnalysisSha256: digest('analysis'), matchMatrixSha256: digest('matrix'),
      unresolvedQuestionsSha256: digest('questions'), matchMatrixValid: true,
    },
    languageCheck: {
      available: true,
      backend: 'nspell',
      language: 'de-DE',
      issueCount: 1,
      issuesSha256: digest('issues'),
      checkedArtifactSha256: artifactSha256
    }
  };
  return proofAuthority.issue({
    applicationCaseId: app.id,
    jobId: app.job.id,
    identityId: app.identityId,
    documentType: 'cover_letter',
    evidence
  });
}

describe('artifact revisions', () => {
  it('requires exact server proof and human review before immutable use', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'application-artifact-'));
    roots.push(root);
    const store = new MemoryWorkspaceStore();
    const app = application('real');
    const proofAuthority = authority();
    const content = 'Belegter Entwurf';
    const pipelineProof = await proofFor(proofAuthority, app, content);
    const revision = await createArtifactRevision(store, app, { type: 'cover_letter', content, pipelineProof }, root, proofAuthority);
    expect(await readFile(resolve(root, revision.artifactPath), 'utf8')).toBe(content);
    await expect(markArtifactUsed(store, app, revision.id, proofAuthority, root)).rejects.toThrow('freigegeben');

    const approved = await reviewArtifactRevision(store, app, revision.id, {
      decision: 'approved',
      expectedSha256: revision.sha256,
      acknowledgedLanguageIssueCount: 1,
      confirmed: true
    }, proofAuthority, root);
    expect(approved.lifecycle).toBe('approved');
    app.approvedArtifactRevisionId = approved.id;
    app.approvedArtifactSha256 = approved.sha256;
    app.approvedAt = '2026-08-14T00:00:00Z';
    const used = await markArtifactUsed(store, app, revision.id, proofAuthority, root);
    expect(used.lifecycle).toBe('used');
    await expect(store.saveArtifactRevision({ ...used, type: 'cv' })).rejects.toThrow('unver');
  });

  it('rejects forged, unverified and incognito use paths', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'application-artifact-'));
    roots.push(root);
    const store = new MemoryWorkspaceStore();
    const real = application('real');
    const incognito = application('incognito');
    const proofAuthority = authority();
    const unverified = await createArtifactRevision(store, real, { type: 'cover_letter', content: 'Browserentwurf' }, root);
    await expect(reviewArtifactRevision(store, real, unverified.id, {
      decision: 'approved', expectedSha256: unverified.sha256, acknowledgedLanguageIssueCount: 0, confirmed: true
    }, proofAuthority, root)).rejects.toThrow('keinen serverseitigen');

    const previewProof = await proofFor(proofAuthority, incognito, 'Vorschau');
    const preview = await createArtifactRevision(store, incognito, { type: 'cover_letter', content: 'Vorschau', pipelineProof: previewProof }, root, proofAuthority);
    const approved = await reviewArtifactRevision(store, incognito, preview.id, {
      decision: 'approved', expectedSha256: preview.sha256, acknowledgedLanguageIssueCount: 1, confirmed: true
    }, proofAuthority, root);
    await expect(markArtifactUsed(store, incognito, approved.id, proofAuthority, root)).rejects.toThrow('Inkognito');
  });
});
