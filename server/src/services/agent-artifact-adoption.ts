import { createHash } from 'node:crypto';
import type { AgentArtifactAdoptionPort, AgentArtifactRecord } from '../agents/artifact-store.js';
import { LocalApplicationAssistantAdapter } from '../adapters/local-application-assistant.js';
import type { ConfigStore } from './config-store.js';
import type { WorkspaceStore } from './workspace-store.js';
import { companyKey } from './mail-correlation.js';
import { createArtifactRevision, readVerifiedArtifactRevision } from './artifact-revisions.js';
import type { ApplicationPipelineProofAuthority } from './application-pipeline-proof.js';

interface PipelinePackage {
  annotatedContent: string;
  iterationManifest: string;
}

function policyError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function parsePipelinePackage(content: Buffer): PipelinePackage {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)); }
  catch { throw policyError('Das Agentenartefakt ist kein gueltiges UTF-8-JSON-Pipelinepaket.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw policyError('Das Agentenartefakt besitzt keinen gueltigen Pipelinevertrag.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['annotatedContent', 'iterationManifest'].includes(key))
    || typeof value.annotatedContent !== 'string' || !value.annotatedContent.trim() || value.annotatedContent.length > 200_000
    || typeof value.iterationManifest !== 'string' || !value.iterationManifest.trim() || value.iterationManifest.length > 200_000) {
    throw policyError('Das Agentenartefakt entspricht nicht dem geschlossenen Pipelinepaket-Vertrag.');
  }
  return { annotatedContent: value.annotatedContent, iterationManifest: value.iterationManifest };
}

/**
 * Imports an approved proposal only by running the deterministic application
 * pipeline again. Agent text can therefore never mint its own proof.
 */
export class VerifiedApplicationArtifactAdoptionPort implements AgentArtifactAdoptionPort {
  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly config: ConfigStore,
    private readonly proofAuthority: ApplicationPipelineProofAuthority,
    private readonly workRoot: string,
  ) {}

  async adopt(input: {
    artifact: Readonly<AgentArtifactRecord>;
    content: Buffer;
    idempotencyKey: string;
  }): Promise<{ applicationCaseId: string; jobId: string; companyKey: string; sourceReference: string }> {
    if (input.artifact.kind !== 'application-pipeline-package' || input.artifact.mediaType !== 'application/json') {
      throw policyError('Nur ein geprueftes application-pipeline-package kann als Dokumentrevision uebernommen werden.');
    }
    if (input.artifact.lifecycle !== 'approved' || input.artifact.review?.decision !== 'approved') {
      throw policyError('Das Pipelinepaket muss vor der Uebernahme serverseitig freigegeben sein.');
    }
    const contentSha256 = createHash('sha256').update(input.content).digest('hex');
    if (input.artifact.sha256 !== contentSha256 || input.artifact.bytes !== input.content.byteLength) {
      throw policyError('Das freigegebene Pipelinepaket stimmt nicht mit dem exakt geprueften Inhalt ueberein.');
    }
    const caseId = input.artifact.provenance.applicationCaseId;
    const application = caseId ? await this.workspace.getApplicationCase(caseId) : undefined;
    if (!application) throw policyError('Der gebundene Bewerbungsfall wurde nicht gefunden.');
    if (application.state !== 'review') throw policyError('Die Uebernahme ist nur im Review-Status zulaessig.');
    if (application.identityMode !== 'real' || input.artifact.provenance.identityMode !== 'real') {
      throw policyError('Inkognito-Artefakte duerfen nicht als reale Dokumentrevision uebernommen werden.');
    }
    if (application.job.id !== input.artifact.provenance.jobId
      || companyKey(application.job.company) !== input.artifact.provenance.companyKey
      || application.revision !== input.artifact.provenance.applicationCaseRevision) {
      throw policyError('Das Agentenartefakt ist nicht mehr an den aktuellen Fall-, Stellen- und Firmenstand gebunden.');
    }
    const idempotencyHash = createHash('sha256').update(input.idempotencyKey, 'utf8').digest('hex');
    const existing = (await this.workspace.listArtifactRevisions(application.id))
      .find((revision) => revision.sourceAgentArtifactId === input.artifact.id);
    if (existing) {
      if (existing.adoptionIdempotencyKeySha256 !== idempotencyHash) throw policyError('Der Agentenartefakt-Schluessel wurde widerspruechlich wiederverwendet.');
      await readVerifiedArtifactRevision(this.workspace, application, existing.id, this.proofAuthority, this.workRoot);
      return {
        applicationCaseId: application.id, jobId: application.job.id,
        companyKey: companyKey(application.job.company), sourceReference: `application-revision:${existing.id}`,
      };
    }
    const pipelinePackage = parsePipelinePackage(input.content);
    const configuration = await this.config.load();
    const identity = configuration.identities.find((candidate) => candidate.id === application.identityId);
    if (!identity || identity.mode !== 'real') throw policyError('Die serverseitig gebundene reale Identitaet ist nicht verfuegbar.');
    const draft = await new LocalApplicationAssistantAdapter(configuration.assistant, this.workRoot).finalize({
      job: application.job,
      identity,
      documentType: application.documentType,
      annotatedContent: pipelinePackage.annotatedContent,
      iterationManifest: pipelinePackage.iterationManifest,
    });
    if (!draft.pipelineEvidence || draft.lifecycle !== 'final') throw policyError('Die lokale Pipeline hat keinen pruefbaren Finalnachweis erzeugt.');
    const artifactType = application.documentType === 'email' ? 'application_email' : application.documentType;
    const proof = await this.proofAuthority.issue({
      applicationCaseId: application.id,
      jobId: application.job.id,
      identityId: application.identityId,
      documentType: artifactType,
      evidence: draft.pipelineEvidence,
    });
    const revision = await createArtifactRevision(this.workspace, application, {
      type: artifactType,
      content: draft.content,
      pipelineProof: proof,
      sourceAgentArtifactId: input.artifact.id,
      adoptionIdempotencyKeySha256: idempotencyHash,
    }, this.workRoot, this.proofAuthority);
    return {
      applicationCaseId: application.id,
      jobId: application.job.id,
      companyKey: companyKey(application.job.company),
      sourceReference: `application-revision:${revision.id}`,
    };
  }
}
