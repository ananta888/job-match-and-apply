import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { defaultConfig } from './config/defaults.js';
import type { ApplicationCase, ApplicationPipelineEvidence } from './domain/models.js';
import { MemoryAuditLogger } from './services/audit-logger.js';
import { createArtifactRevision } from './services/artifact-revisions.js';
import {
  ApplicationPipelineProofAuthority,
  StaticApplicationPipelineProofKeyProvider
} from './services/application-pipeline-proof.js';
import { MemoryConfigStore } from './services/config-store.js';
import { MemoryWorkspaceStore } from './services/workspace-store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('application pipeline API gates', () => {
  it('binds review, case approval, use and export to one signed server revision', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'application-pipeline-api-'));
    roots.push(workRoot);
    const workspace = new MemoryWorkspaceStore();
    const application: ApplicationCase = {
      id: randomUUID(),
      job: { id: 'job-proof', sourceId: 'test', title: 'Engineer', company: 'Example GmbH', location: 'Berlin', workModel: 'hybrid', employmentType: 'full_time', description: '', skills: [] },
      identityId: 'real-local',
      identityMode: 'real',
      documentType: 'cover_letter',
      state: 'review',
      createdAt: '2026-08-14T10:00:00Z',
      updatedAt: '2026-08-14T10:00:00Z',
      artifactNames: [],
      warnings: [],
      revision: 4
    };
    await workspace.saveApplicationCase(application);
    const authority = new ApplicationPipelineProofAuthority(new StaticApplicationPipelineProofKeyProvider(randomBytes(32)));
    const content = 'Guten Tag,\n\ndies ist die gepr\u00fcfte Revision.';
    const artifactSha256 = sha256(content);
    const evidence: ApplicationPipelineEvidence = {
      pipelineContractVersion: '1.0',
      completedStages: ['validate_profiles', 'analyze_job', 'build_match_matrix', 'questions_reviewed', 'validate_iteration', 'audit_claims', 'check_style'],
      annotatedSha256: sha256('annotated'),
      iterationManifestSha256: sha256('manifest'),
      candidateProfileSha256: sha256('candidate'),
      styleProfileSha256: sha256('style'),
      artifactSha256,
      preparation: {
        jobAnalysisSha256: sha256('analysis'), matchMatrixSha256: sha256('matrix'),
        unresolvedQuestionsSha256: sha256('questions'), matchMatrixValid: true,
      },
      languageCheck: {
        available: true,
        backend: 'nspell',
        language: 'de-DE',
        issueCount: 2,
        issuesSha256: sha256('issues'),
        checkedArtifactSha256: artifactSha256
      }
    };
    const pipelineProof = await authority.issue({
      applicationCaseId: application.id,
      jobId: application.job.id,
      identityId: application.identityId,
      documentType: 'cover_letter',
      evidence
    });
    const revision = await createArtifactRevision(
      workspace, application, { type: 'cover_letter', content, pipelineProof }, workRoot, authority
    );
    const app = createApp(
      new MemoryConfigStore(), new MemoryAuditLogger(), workspace, undefined, undefined,
      { proofAuthority: authority, workRoot }
    );

    await request(app).post(`/api/application-cases/${application.id}/transition`).send({
      state: 'approved', revisionId: revision.id, expectedSha256: revision.sha256, confirmed: true
    }).expect(409);
    await request(app).post(`/api/application-cases/${application.id}/artifacts/${revision.id}/review`).send({
      decision: 'approved',
      expectedSha256: revision.sha256,
      acknowledgedLanguageIssueCount: 1,
      confirmed: true
    }).expect(409);
    await request(app).post(`/api/application-cases/${application.id}/artifacts/${revision.id}/review`).send({
      decision: 'approved',
      expectedSha256: revision.sha256,
      acknowledgedLanguageIssueCount: 2,
      confirmed: true
    }).expect(200);
    await request(app).post(`/api/application-cases/${application.id}/transition`).send({
      state: 'approved', revisionId: revision.id, expectedSha256: 'f'.repeat(64), confirmed: true
    }).expect(409);
    const approvedCase = await request(app).post(`/api/application-cases/${application.id}/transition`).send({
      state: 'approved', revisionId: revision.id, expectedSha256: revision.sha256, confirmed: true
    }).expect(200);
    expect(approvedCase.body).toMatchObject({
      approvedArtifactRevisionId: revision.id, approvedArtifactSha256: revision.sha256,
      approvedAt: expect.any(String)
    });

    await request(app).post(`/api/application-cases/${application.id}/export`).send({
      content: 'browser supplied replacement', format: 'docx'
    }).expect(400);
    const exported = await request(app).post(`/api/application-cases/${application.id}/export`).send({
      revisionId: revision.id, format: 'docx', confirmed: true
    }).expect(200);
    expect(exported.body).toMatchObject({ artifactRevisionId: revision.id, artifactSha256: revision.sha256 });
    expect((await workspace.listArtifactRevisions(application.id))[0]).toMatchObject({
      id: revision.id, lifecycle: 'used', usedForApplicationCaseId: application.id
    });

    await request(app).post(`/api/application-cases/${application.id}/artifacts`).send({
      type: 'cover_letter', content: 'forged', pipelineContractVersion: '1.0'
    }).expect(400);
  });

  it('creates the proof and revision only through the case-bound local pipeline', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'application-pipeline-finalize-'));
    roots.push(workRoot);
    const repositoryRoot = resolve(process.cwd(), '..');
    const config = structuredClone(defaultConfig);
    config.identities.push({
      id: 'real-local',
      label: 'Lokaler Test',
      mode: 'real',
      fullName: 'Erika Beispiel',
      email: 'erika@example.test',
      phone: '',
      location: 'Berlin',
      linkedin: '',
      placeholders: {}
    });
    config.activeIdentityId = 'real-local';
    config.assistant = {
      skillPath: resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent'),
      candidateProfilePath: resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent', 'tests', 'fixtures', 'valid-candidate.yaml'),
      styleProfilePath: resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent', 'tests', 'fixtures', 'valid-style.yaml')
    };
    const application: ApplicationCase = {
      id: randomUUID(),
      job: { id: 'job-case-bound', sourceId: 'test', title: 'Senior Software Engineer', company: 'Example GmbH', location: 'Berlin', workModel: 'hybrid', employmentType: 'full_time', description: 'RabbitMQ', skills: ['RabbitMQ'] },
      identityId: 'real-local',
      identityMode: 'real',
      documentType: 'cover_letter',
      state: 'review',
      createdAt: '2026-08-14T10:00:00Z',
      updatedAt: '2026-08-14T10:00:00Z',
      artifactNames: [],
      warnings: [],
      revision: 4
    };
    const workspace = new MemoryWorkspaceStore();
    await workspace.saveApplicationCase(application);
    const authority = new ApplicationPipelineProofAuthority(new StaticApplicationPipelineProofKeyProvider(randomBytes(32)));
    const app = createApp(
      new MemoryConfigStore(config), new MemoryAuditLogger(), workspace, undefined, undefined,
      { proofAuthority: authority, workRoot }
    );
    const iterationManifest = `schema_version: 1
mode: standard
execution: independent_agents
cycle: 1
passes:
  - {id: pass-author-1, role: author, independent_context: true, input_revision: source, output_revision: revision-1, findings: []}
  - {id: pass-evidence-ats-1, role: evidence_ats_reviewer, independent_context: true, input_revision: revision-1, output_revision: revision-2, findings: []}
  - {id: pass-recruiter-style-1, role: recruiter_style_reviewer, independent_context: true, input_revision: revision-2, output_revision: revision-3, findings: []}
  - {id: pass-finalizer-1, role: finalizer, independent_context: true, input_revision: revision-3, output_revision: final, findings: []}
`;
    const finalized = await request(app).post(`/api/application-cases/${application.id}/pipeline/finalize`).send({
      annotatedContent: 'Guten Tag, <!-- evidence: editorial -->\n\nAls Senior Software Engineer arbeitete ich bei Example GmbH. <!-- evidence: claim-role -->\n',
      iterationManifest
    }).expect(201);
    expect(finalized.body.draft.lifecycle).toBe('final');
    expect(finalized.body.revision).toMatchObject({ lifecycle: 'proposed', pipelineContractVersion: '1.0' });
    expect(finalized.body.revision.pipelineProof.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(authority.verify(finalized.body.revision.pipelineProof, {
      applicationCaseId: application.id,
      artifactSha256: finalized.body.revision.sha256
    })).resolves.toBeUndefined();
  }, 30_000);
});
