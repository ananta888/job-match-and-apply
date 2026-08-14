import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config/defaults.js';
import type { ApplicationCase, IdentityProfile } from '../domain/models.js';
import { AgentArtifactStore, type AgentArtifactRecord } from '../agents/artifact-store.js';
import { MemoryConfigStore } from './config-store.js';
import { companyKey } from './mail-correlation.js';
import { VerifiedApplicationArtifactAdoptionPort } from './agent-artifact-adoption.js';
import {
  ApplicationPipelineProofAuthority,
  StaticApplicationPipelineProofKeyProvider,
} from './application-pipeline-proof.js';
import { readVerifiedArtifactRevision } from './artifact-revisions.js';
import { MemoryWorkspaceStore } from './workspace-store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const repositoryRoot = resolve(process.cwd(), '..');
const identity: IdentityProfile = {
  id: 'real-candidate', label: 'Real candidate', mode: 'real', fullName: 'Erika Beispiel',
  email: 'erika@example.test', phone: '', location: 'Berlin', linkedin: '', placeholders: {},
};
const application = (overrides: Partial<ApplicationCase> = {}): ApplicationCase => ({
  id: '11111111-1111-4111-8111-111111111111',
  job: {
    id: 'JOB-ADOPTION-1', sourceId: 'test', title: 'Senior Software Engineer', company: 'Example GmbH',
    location: 'Berlin', workModel: 'hybrid', employmentType: 'full_time', description: 'RabbitMQ', skills: ['RabbitMQ'],
  },
  identityId: identity.id,
  identityMode: 'real',
  documentType: 'cover_letter',
  state: 'review',
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
  artifactNames: [],
  warnings: [],
  revision: 7,
  ...overrides,
});
const manifest = `schema_version: 1
mode: standard
execution: independent_agents
cycle: 1
passes:
  - {id: pass-author-1, role: author, independent_context: true, input_revision: source, output_revision: revision-1, findings: []}
  - {id: pass-evidence-ats-1, role: evidence_ats_reviewer, independent_context: true, input_revision: revision-1, output_revision: revision-2, findings: []}
  - {id: pass-recruiter-style-1, role: recruiter_style_reviewer, independent_context: true, input_revision: revision-2, output_revision: revision-3, findings: []}
  - {id: pass-finalizer-1, role: finalizer, independent_context: true, input_revision: revision-3, output_revision: final, findings: []}
`;
const annotatedContent = 'Guten Tag, <!-- evidence: editorial -->\n\nAls Senior Software Engineer arbeitete ich bei Example GmbH. <!-- evidence: claim-role -->\n';

async function fixture(overrides: Partial<ApplicationCase> = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'verified-agent-adoption-'));
  roots.push(root);
  const workspace = new MemoryWorkspaceStore();
  const current = application(overrides);
  await workspace.saveApplicationCase(current);
  const configuration = structuredClone(defaultConfig);
  configuration.identities = [identity];
  configuration.activeIdentityId = identity.id;
  configuration.assistant = {
    skillPath: resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent'),
    candidateProfilePath: resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent', 'tests', 'fixtures', 'valid-candidate.yaml'),
    styleProfilePath: resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent', 'tests', 'fixtures', 'valid-style.yaml'),
  };
  const proofAuthority = new ApplicationPipelineProofAuthority(
    new StaticApplicationPipelineProofKeyProvider(randomBytes(32)),
  );
  const workRoot = resolve(root, 'application-work');
  const artifacts = new AgentArtifactStore(resolve(root, 'agent-artifacts'));
  const port = new VerifiedApplicationArtifactAdoptionPort(
    workspace, new MemoryConfigStore(configuration), proofAuthority, workRoot,
  );
  return { root, workspace, current, configuration, proofAuthority, workRoot, artifacts, port };
}

async function proposal(
  value: Awaited<ReturnType<typeof fixture>>,
  content: unknown = { annotatedContent, iterationManifest: manifest },
  overrides: Partial<AgentArtifactRecord['provenance']> = {},
) {
  const created = await value.artifacts.create({
    kind: 'application-pipeline-package',
    mediaType: 'application/json',
    content: JSON.stringify(content),
    provenance: {
      runId: 'run-adoption-1', provider: 'fake', providerVersion: '1.0.0', adapterVersion: '1.0.0',
      templateId: 'application-draft', templateVersion: '1.0.0', workflowId: 'evidence-application-package',
      workflowVersion: '1.0.0', applicationCaseId: value.current.id,
      applicationCaseRevision: value.current.revision, jobId: value.current.job.id,
      companyKey: companyKey(value.current.job.company), identityMode: 'real',
      ...overrides,
    },
  });
  return value.artifacts.review(created.id, 'approved', 0, 'local-user');
}

describe('VerifiedApplicationArtifactAdoptionPort', () => {
  it('re-runs the deterministic pipeline and binds immutable hash, proof, source artifact and idempotency', async () => {
    const value = await fixture();
    const approved = await proposal(value);
    const { content } = await value.artifacts.read(approved.id);
    const idempotencyKey = `agent-artifact:${approved.id}:${approved.revision}:${approved.sha256}`;

    const first = await value.port.adopt({ artifact: approved, content, idempotencyKey });
    const repeated = await value.port.adopt({ artifact: approved, content, idempotencyKey });
    expect(repeated).toEqual(first);
    expect(first.sourceReference).toMatch(/^application-revision:/);

    const revisions = await value.workspace.listArtifactRevisions(value.current.id);
    expect(revisions).toHaveLength(1);
    const revision = revisions[0]!;
    const verified = await readVerifiedArtifactRevision(
      value.workspace, value.current, revision.id, value.proofAuthority, value.workRoot,
    );
    const storedContent = await readFile(resolve(value.workRoot, revision.artifactPath));
    expect(revision).toMatchObject({
      lifecycle: 'proposed',
      sourceAgentArtifactId: approved.id,
      adoptionIdempotencyKeySha256: digest(idempotencyKey),
      pipelineProof: {
        contract: 'application-pipeline-proof', applicationCaseId: value.current.id,
        jobId: value.current.job.id, identityId: identity.id, documentType: 'cover_letter',
      },
    });
    expect(revision.sha256).toBe(digest(storedContent));
    expect(revision.pipelineProof?.artifactSha256).toBe(revision.sha256);
    expect(verified.content).toBe(storedContent.toString('utf8'));
    expect(verified.content).not.toContain('<!-- evidence:');
    expect(await value.workspace.getApplicationCase(value.current.id)).not.toMatchObject({
      approvedArtifactRevisionId: revision.id,
    });

    const used = await value.artifacts.adopt(approved.id, 1, value.port);
    expect(used).toMatchObject({
      lifecycle: 'used', revision: 2,
      adoption: { sourceReference: `application-revision:${revision.id}` },
    });
    expect(await value.workspace.listArtifactRevisions(value.current.id)).toHaveLength(1);
  }, 30_000);

  it('requires explicit artifact approval and rejects incognito, stale and non-review case bindings before import', async () => {
    const value = await fixture();
    const created = await value.artifacts.create({
      kind: 'application-pipeline-package', mediaType: 'application/json',
      content: JSON.stringify({ annotatedContent, iterationManifest: manifest }),
      provenance: {
        runId: 'run-proposed', provider: 'fake', providerVersion: '1.0.0', adapterVersion: '1.0.0',
        templateId: 'application-draft', templateVersion: '1.0.0', applicationCaseId: value.current.id,
        applicationCaseRevision: value.current.revision, jobId: value.current.job.id,
        companyKey: companyKey(value.current.job.company), identityMode: 'real',
      },
    });
    await expect(value.artifacts.adopt(created.id, 0, value.port)).rejects.toThrow('artifact_must_be_approved');
    const unreviewedContent = (await value.artifacts.read(created.id)).content;
    await expect(value.port.adopt({ artifact: created, content: unreviewedContent, idempotencyKey: 'direct-bypass' }))
      .rejects.toThrow('serverseitig freigegeben');

    const incognito = await proposal(value, undefined, { identityMode: 'incognito' });
    await expect(value.artifacts.adopt(incognito.id, 1, value.port)).rejects.toThrow('incognito_artifact');

    const stale = await proposal(value, undefined, { applicationCaseRevision: value.current.revision - 1 });
    const staleContent = (await value.artifacts.read(stale.id)).content;
    await expect(value.port.adopt({ artifact: stale, content: staleContent, idempotencyKey: 'stale' }))
      .rejects.toThrow('aktuellen Fall');

    const draftCase = await fixture({ state: 'draft' });
    const draftArtifact = await proposal(draftCase);
    const draftContent = (await draftCase.artifacts.read(draftArtifact.id)).content;
    await expect(draftCase.port.adopt({ artifact: draftArtifact, content: draftContent, idempotencyKey: 'draft-case' }))
      .rejects.toThrow('Review-Status');
  });

  it('rejects an open/forged package contract, absent real identity and conflicting idempotency keys', async () => {
    const value = await fixture();
    const extraField = await proposal(value, { annotatedContent, iterationManifest: manifest, pipelineProof: 'forged-by-agent' });
    await expect(value.port.adopt({
      artifact: extraField, content: (await value.artifacts.read(extraField.id)).content, idempotencyKey: 'forged-package',
    })).rejects.toThrow('geschlossenen Pipelinepaket-Vertrag');

    const wrongKind = await proposal(value);
    await expect(value.port.adopt({
      artifact: { ...wrongKind, kind: 'cover-letter' },
      content: (await value.artifacts.read(wrongKind.id)).content,
      idempotencyKey: 'wrong-kind',
    })).rejects.toThrow('application-pipeline-package');

    const withoutIdentity = await fixture();
    withoutIdentity.configuration.identities = [];
    const noIdentityPort = new VerifiedApplicationArtifactAdoptionPort(
      withoutIdentity.workspace,
      new MemoryConfigStore(withoutIdentity.configuration),
      withoutIdentity.proofAuthority,
      withoutIdentity.workRoot,
    );
    const missingIdentity = await proposal(withoutIdentity);
    await expect(noIdentityPort.adopt({
      artifact: missingIdentity,
      content: (await withoutIdentity.artifacts.read(missingIdentity.id)).content,
      idempotencyKey: 'no-identity',
    })).rejects.toThrow('reale Identitaet');

    const valid = await proposal(value);
    const content = (await value.artifacts.read(valid.id)).content;
    await expect(value.port.adopt({
      artifact: valid, content: Buffer.from(`${content.toString('utf8')}\nforged`), idempotencyKey: 'forged-content',
    })).rejects.toThrow('exakt geprueften Inhalt');
    await value.port.adopt({ artifact: valid, content, idempotencyKey: 'first-key' });
    await expect(value.port.adopt({ artifact: valid, content, idempotencyKey: 'different-key' }))
      .rejects.toThrow('widerspruechlich');
  }, 30_000);
});
