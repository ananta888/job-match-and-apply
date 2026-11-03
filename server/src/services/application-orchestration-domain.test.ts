import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalApplicationOrchestrationDomain } from './application-orchestration-domain.js';
import type { ApplicationCase, ApplicationCaseState } from '../domain/models.js';
import type { ConfigStore } from './config-store.js';
import type { WorkspaceStore } from './workspace-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const CV_TEXT = '# Synthetischer Lebenslauf\n\nStation: Beispiel GmbH, 2020-2024.\n';

function fixtureCase(overrides: Partial<ApplicationCase> & { id: string }): ApplicationCase {
  return {
    job: { id: 'job-1', title: 'Synthetische Stelle', company: 'Beispiel GmbH' } as ApplicationCase['job'],
    identityId: 'identity-real',
    identityMode: 'real',
    documentType: 'cover_letter',
    state: 'draft' as ApplicationCaseState,
    createdAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
    artifactNames: [],
    warnings: [],
    revision: 3,
    ...overrides,
  } as ApplicationCase;
}

async function fixtureDomain(workspace: WorkspaceStore) {
  const config = {
    load: async () => ({
      identities: [
        { id: 'identity-real', mode: 'real', fullName: 'Synthetische Person' },
        { id: 'identity-other', mode: 'real', fullName: 'Andere Person' },
        { id: 'identity-incognito', mode: 'incognito', fullName: 'Synthetische Incognito-Person' },
      ],
    }),
  } as unknown as ConfigStore;
  return new LocalApplicationOrchestrationDomain(
    workspace, config, {} as never, { verify: async () => undefined } as never,
    roots[roots.length - 1]!, randomBytes(32),
  );
}

async function writeBoundCv(workRoot: string, caseId: string, revisionId: string, content: string): Promise<{
  id: string; applicationCaseId: string; type: 'cv'; lifecycle: 'approved'; sha256: string;
  bytes: number; artifactPath: string;
}> {
  const directory = resolve(workRoot, caseId, 'revisions');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${revisionId}.md`), content, 'utf8');
  return {
    id: revisionId, applicationCaseId: caseId, type: 'cv', lifecycle: 'approved',
    sha256: sha256(content), bytes: Buffer.byteLength(content, 'utf8'),
    artifactPath: `${caseId}/revisions/${revisionId}.md`,
  } as never;
}

describe('source CV binding in application_case resolution', () => {
  it('delivers the exact approved CV content bound to the same identity and mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-cv-')); roots.push(root);
    const sourceCase = fixtureCase({
      id: '11111111-1111-4111-8111-111111111111', identityId: 'identity-real', identityMode: 'real', documentType: 'cv',
    });
    const targetCase = fixtureCase({
      id: '22222222-2222-4222-8222-222222222222', documentType: 'cover_letter',
      sourceCv: {
        caseId: sourceCase.id, revisionId: '33333333-3333-4333-8333-333333333333',
        sha256: sha256(CV_TEXT), profileSha256: 'a'.repeat(64),
      },
    });
    const revision = await writeBoundCv(root, sourceCase.id, '33333333-3333-4333-8333-333333333333', CV_TEXT);
    const workspace = {
      getApplicationCase: async (id: string) => (id === sourceCase.id ? sourceCase : id === targetCase.id ? targetCase : undefined),
      listArtifactRevisions: async (caseId?: string) => (caseId === sourceCase.id ? [revision] : []),
    } as unknown as WorkspaceStore;
    const domain = await fixtureDomain(workspace);
    const resolved = await domain.resolve({
      orchestrationId: 'orch-1', workflowId: 'evidence-application-package', workflowVersion: '1.2.0',
      nodeId: 'evidence', role: 'evidence_reviewer', reference: 'application_case',
      scope: { applicationCaseId: targetCase.id, applicationCaseRevision: targetCase.revision, identityMode: 'real' } as never,
      signal: new AbortController().signal,
    });
    const section = JSON.parse(resolved.content) as { sourceCv: Record<string, unknown> };
    expect(section.sourceCv).toEqual({
      caseId: sourceCase.id,
      revisionId: '33333333-3333-4333-8333-333333333333',
      sha256: sha256(CV_TEXT),
      boundContent: CV_TEXT,
      boundContentSha256: sha256(CV_TEXT),
      boundContentTruncated: false,
    });
  });

  it('bounds oversized CV content and flags the excerpt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-cv-bound-')); roots.push(root);
    const content = 'x'.repeat(70_000);
    const sourceCase = fixtureCase({
      id: '11111111-1111-4111-8111-111111111111', identityId: 'identity-real', identityMode: 'real', documentType: 'cv',
    });
    const targetCase = fixtureCase({
      id: '22222222-2222-4222-8222-222222222222', documentType: 'cover_letter',
      sourceCv: { caseId: sourceCase.id, revisionId: 'rev-1', sha256: sha256(content), profileSha256: 'a'.repeat(64) },
    });
    const revision = await writeBoundCv(root, sourceCase.id, 'rev-1', content);
    const workspace = {
      getApplicationCase: async (id: string) => (id === sourceCase.id ? sourceCase : targetCase),
      listArtifactRevisions: async () => [revision],
    } as unknown as WorkspaceStore;
    const domain = await fixtureDomain(workspace);
    const resolved = await domain.resolve({
      orchestrationId: 'orch-1', workflowId: 'evidence-application-package', workflowVersion: '1.2.0',
      nodeId: 'evidence', role: 'evidence_reviewer', reference: 'application_case',
      scope: { applicationCaseId: targetCase.id, applicationCaseRevision: targetCase.revision, identityMode: 'real' } as never,
      signal: new AbortController().signal,
    });
    const section = JSON.parse(resolved.content) as { sourceCv: Record<string, unknown> };
    expect(section.sourceCv.boundContentTruncated).toBe(true);
    expect(String(section.sourceCv.boundContent)).toHaveLength(64_000);
  });

  it('rejects identity, mode, version and content mismatches instead of mixing CVs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-cv-negative-')); roots.push(root);
    const sourceCase = fixtureCase({
      id: '11111111-1111-4111-8111-111111111111', identityId: 'identity-real', identityMode: 'real', documentType: 'cv',
    });
    const revision = await writeBoundCv(root, sourceCase.id, 'rev-1', CV_TEXT);
    const runResolve = async (workspace: WorkspaceStore, target: ApplicationCase) => {
      const domain = await fixtureDomain(workspace);
      return domain.resolve({
        orchestrationId: 'orch-1', workflowId: 'evidence-application-package', workflowVersion: '1.2.0',
        nodeId: 'evidence', role: 'evidence_reviewer', reference: 'application_case',
        scope: { applicationCaseId: target.id, applicationCaseRevision: target.revision, identityMode: target.identityMode } as never,
        signal: new AbortController().signal,
      });
    };
    const baseTarget = fixtureCase({
      id: '22222222-2222-4222-8222-222222222222', documentType: 'cover_letter',
      sourceCv: { caseId: sourceCase.id, revisionId: 'rev-1', sha256: sha256(CV_TEXT), profileSha256: 'a'.repeat(64) },
    });

    const missingCase = {
      getApplicationCase: async (id: string) => (id === baseTarget.id ? baseTarget : undefined),
      listArtifactRevisions: async () => [revision],
    } as unknown as WorkspaceStore;
    await expect(runResolve(missingCase, baseTarget)).rejects.toThrow('orchestration_source_cv_case_missing');

    const otherIdentity = fixtureCase({ ...baseTarget, id: '22222222-2222-4222-8222-222222222222', identityId: 'identity-other' });
    const identityMismatch = {
      getApplicationCase: async (id: string) => (id === sourceCase.id ? sourceCase : otherIdentity),
      listArtifactRevisions: async () => [revision],
    } as unknown as WorkspaceStore;
    await expect(runResolve(identityMismatch, otherIdentity)).rejects.toThrow('orchestration_source_cv_identity_mismatch');

    const incognitoTarget = fixtureCase({
      ...baseTarget, id: '22222222-2222-4222-8222-222222222222',
      identityMode: 'incognito', identityId: 'identity-incognito',
    });
    // Same identity id but the source record still carries the real mode: no silent mixing.
    const staleModeSource = { ...sourceCase, identityId: 'identity-incognito', identityMode: 'real' as const };
    const modeMismatch = {
      getApplicationCase: async (id: string) => (id === staleModeSource.id ? staleModeSource : incognitoTarget),
      listArtifactRevisions: async () => [revision],
    } as unknown as WorkspaceStore;
    await expect(runResolve(modeMismatch, incognitoTarget)).rejects.toThrow('orchestration_source_cv_identity_mismatch');

    const tamperedTarget = fixtureCase({
      ...baseTarget,
      sourceCv: { caseId: sourceCase.id, revisionId: 'rev-1', sha256: 'b'.repeat(64), profileSha256: 'a'.repeat(64) },
    });
    const bindingBroken = {
      getApplicationCase: async (id: string) => (id === sourceCase.id ? sourceCase : tamperedTarget),
      listArtifactRevisions: async () => [revision],
    } as unknown as WorkspaceStore;
    await expect(runResolve(bindingBroken, tamperedTarget)).rejects.toThrow('orchestration_source_cv_binding_broken');

    const staleRevision = { ...revision, lifecycle: 'proposed' as const };
    const notApproved = {
      getApplicationCase: async (id: string) => (id === sourceCase.id ? sourceCase : baseTarget),
      listArtifactRevisions: async () => [staleRevision],
    } as unknown as WorkspaceStore;
    await expect(runResolve(notApproved, baseTarget)).rejects.toThrow('orchestration_source_cv_binding_broken');

    await writeFile(resolve(root, sourceCase.id, 'revisions', 'rev-1.md'), 'veränderte Fassung', 'utf8');
    const contentMismatch = {
      getApplicationCase: async (id: string) => (id === sourceCase.id ? sourceCase : baseTarget),
      listArtifactRevisions: async () => [revision],
    } as unknown as WorkspaceStore;
    await expect(runResolve(contentMismatch, baseTarget)).rejects.toThrow('orchestration_source_cv_content_mismatch');
  });

  it('keeps cases without a CV binding free of bound content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-cv-free-')); roots.push(root);
    const targetCase = fixtureCase({ id: '22222222-2222-4222-8222-222222222222', documentType: 'cover_letter' });
    const workspace = {
      getApplicationCase: async () => targetCase,
      listArtifactRevisions: async () => [],
    } as unknown as WorkspaceStore;
    const domain = await fixtureDomain(workspace);
    const resolved = await domain.resolve({
      orchestrationId: 'orch-1', workflowId: 'evidence-application-package', workflowVersion: '1.2.0',
      nodeId: 'evidence', role: 'evidence_reviewer', reference: 'application_case',
      scope: { applicationCaseId: targetCase.id, applicationCaseRevision: targetCase.revision, identityMode: 'real' } as never,
      signal: new AbortController().signal,
    });
    expect(resolved.content).not.toContain('boundContent');
  });
});
