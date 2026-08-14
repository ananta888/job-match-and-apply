import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ApplicationArtifactRevision, ApplicationCase, ApplicationPipelineProof } from '../domain/models.js';
import type { WorkspaceStore } from './workspace-store.js';
import { companyKey } from './mail-correlation.js';
import type { ApplicationPipelineProofAuthority } from './application-pipeline-proof.js';

const defaultWorkRoot = (): string => resolve(process.cwd(), '..', '.application-work');
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

function policyError(message: string, statusCode = 409): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function documentTypeFor(type: ApplicationArtifactRevision['type']): ApplicationPipelineProof['documentType'] {
  return type;
}

export async function createArtifactRevision(
  workspace: WorkspaceStore,
  application: ApplicationCase,
  input: {
    type: ApplicationArtifactRevision['type'];
    content: string;
    pipelineProof?: ApplicationPipelineProof;
    sourceAgentArtifactId?: string;
    adoptionIdempotencyKeySha256?: string;
  },
  workRoot = defaultWorkRoot(),
  proofAuthority?: ApplicationPipelineProofAuthority
): Promise<ApplicationArtifactRevision> {
  const id = randomUUID();
  const data = Buffer.from(input.content, 'utf8');
  const contentSha256 = sha256(data);
  if (input.pipelineProof) {
    if (!proofAuthority) throw policyError('Serverseitige Pipeline-Nachweispr\u00fcfung fehlt.');
    await proofAuthority.verify(input.pipelineProof, {
      applicationCaseId: application.id,
      jobId: application.job.id,
      identityId: application.identityId,
      documentType: documentTypeFor(input.type),
      artifactSha256: contentSha256
    });
  }
  const directory = resolve(workRoot, application.id, 'revisions');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const extension = input.type === 'application_email' ? 'txt' : 'md';
  const artifactPath = resolve(directory, `${id}.${extension}`);
  await writeFile(artifactPath, data, { mode: 0o600, flag: 'wx' });
  const revision: ApplicationArtifactRevision = {
    id,
    applicationCaseId: application.id,
    companyKey: companyKey(application.job.company),
    jobId: application.job.id,
    type: input.type,
    lifecycle: 'proposed',
    sha256: contentSha256,
    bytes: data.length,
    artifactPath: artifactPath.slice(resolve(workRoot).length + 1).replaceAll('\\', '/'),
    pipelineContractVersion: input.pipelineProof?.pipelineContractVersion ?? 'unverified',
    pipelineProof: input.pipelineProof ? structuredClone(input.pipelineProof) : undefined,
    sourceAgentArtifactId: input.sourceAgentArtifactId,
    adoptionIdempotencyKeySha256: input.adoptionIdempotencyKeySha256,
    createdAt: new Date().toISOString()
  };
  await workspace.saveArtifactRevision(revision);
  return revision;
}

export async function reviewArtifactRevision(
  workspace: WorkspaceStore,
  application: ApplicationCase,
  revisionId: string,
  input: {
    decision: 'approved' | 'rejected';
    expectedSha256: string;
    acknowledgedLanguageIssueCount: number;
    confirmed: true;
  },
  proofAuthority: ApplicationPipelineProofAuthority,
  workRoot = defaultWorkRoot()
): Promise<ApplicationArtifactRevision> {
  const { revision } = await readVerifiedArtifactRevision(workspace, application, revisionId, proofAuthority, workRoot);
  if (revision.lifecycle !== 'proposed') throw policyError('Nur eine vorgeschlagene Dokumentrevision kann gepr\u00fcft werden.');
  if (input.confirmed !== true || input.expectedSha256 !== revision.sha256) throw policyError('Die Freigabe ist nicht an die aktuelle Dokumentrevision gebunden.');
  const issueCount = revision.pipelineProof!.languageCheck.issueCount;
  if (input.acknowledgedLanguageIssueCount !== issueCount) {
    throw policyError('Die best\u00e4tigte Zahl der Sprachhinweise stimmt nicht mit dem Pr\u00fcfnachweis \u00fcberein.');
  }
  const reviewed: ApplicationArtifactRevision = {
    ...revision,
    lifecycle: input.decision,
    review: {
      decision: input.decision,
      reviewer: 'local-user',
      reviewedAt: new Date().toISOString(),
      expectedSha256: revision.sha256,
      acknowledgedLanguageIssueCount: issueCount
    }
  };
  await workspace.saveArtifactRevision(reviewed);
  return reviewed;
}

export async function markArtifactUsed(
  workspace: WorkspaceStore,
  application: ApplicationCase,
  revisionId: string,
  proofAuthority: ApplicationPipelineProofAuthority,
  workRoot = defaultWorkRoot()
): Promise<ApplicationArtifactRevision> {
  if (application.identityMode !== 'real') throw policyError('Inkognito-Dokumente d\u00fcrfen nicht als verwendet markiert werden.');
  if (application.state !== 'approved' && application.state !== 'exported') {
    throw policyError('Der Bewerbungsfall muss vor der Verwendung freigegeben sein.');
  }
  const { revision } = await readVerifiedArtifactRevision(workspace, application, revisionId, proofAuthority, workRoot);
  if (application.approvedArtifactRevisionId !== revision.id || application.approvedArtifactSha256 !== revision.sha256) {
    throw policyError('Verwendung ist nur fuer die exakt am Bewerbungsfall freigegebene Dokumentrevision erlaubt.');
  }
  if (revision.lifecycle === 'used') return revision;
  if (revision.lifecycle !== 'approved' || revision.review?.decision !== 'approved') {
    throw policyError('Die exakt gepr\u00fcfte Dokumentrevision muss vor der Verwendung freigegeben werden.');
  }
  const used: ApplicationArtifactRevision = {
    ...revision,
    lifecycle: 'used',
    usedAt: new Date().toISOString(),
    usedForApplicationCaseId: application.id
  };
  await workspace.saveArtifactRevision(used);
  return used;
}

export async function assertApplicationApprovalReady(
  workspace: WorkspaceStore,
  application: ApplicationCase,
  revisionId: string,
  expectedSha256: string,
  proofAuthority: ApplicationPipelineProofAuthority,
  workRoot = defaultWorkRoot()
): Promise<ApplicationArtifactRevision> {
  const expectedType: ApplicationArtifactRevision['type'] = application.documentType === 'email'
    ? 'application_email'
    : application.documentType;
  const { revision } = await readVerifiedArtifactRevision(workspace, application, revisionId, proofAuthority, workRoot);
  if (revision.type !== expectedType || revision.sha256 !== expectedSha256
    || revision.lifecycle !== 'approved' || revision.review?.decision !== 'approved'
    || revision.review.expectedSha256 !== expectedSha256) {
    throw policyError('Freigabe benoetigt exakt die ausgewaehlte, hashgepruefte, serverseitig finalisierte und menschlich bestaetigte Dokumentrevision.');
  }
  return revision;
}

export async function readVerifiedArtifactRevision(
  workspace: WorkspaceStore,
  application: ApplicationCase,
  revisionId: string,
  proofAuthority: ApplicationPipelineProofAuthority,
  workRoot = defaultWorkRoot()
): Promise<{ revision: ApplicationArtifactRevision; content: string }> {
  const revision = (await workspace.listArtifactRevisions(application.id)).find((item) => item.id === revisionId);
  if (!revision) throw policyError('Dokumentrevision nicht gefunden.', 404);
  if (!revision.pipelineProof) throw policyError('Dokumentrevision besitzt keinen serverseitigen Pipeline-Nachweis.');
  await proofAuthority.verify(revision.pipelineProof, {
    applicationCaseId: application.id,
    jobId: application.job.id,
    identityId: application.identityId,
    documentType: documentTypeFor(revision.type),
    artifactSha256: revision.sha256
  });
  const root = await realpath(resolve(workRoot));
  const candidate = resolve(root, revision.artifactPath);
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw policyError('Dokumentpfad liegt au\u00dferhalb des Arbeitsbereichs.');
  const stats = await lstat(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) throw policyError('Dokumentrevision ist keine regul\u00e4re lokale Datei.');
  const canonical = await realpath(candidate);
  const canonicalRelative = relative(root, canonical);
  if (canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) throw policyError('Dokumentpfad verl\u00e4sst den Arbeitsbereich.');
  const data = await readFile(canonical);
  if (data.byteLength !== revision.bytes || sha256(data) !== revision.sha256) {
    throw policyError('Dokumentrevision stimmt nicht mehr mit ihrem serverseitigen Nachweis \u00fcberein.');
  }
  return { revision, content: data.toString('utf8') };
}
