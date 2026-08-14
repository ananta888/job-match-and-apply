import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  ApplicationArtifactRevision,
  ApplicationPipelineEvidence,
  ApplicationPipelineProof
} from '../domain/models.js';
import { canonicalJson } from '../agents/security-approval.js';

export interface ApplicationPipelineProofKeyProvider {
  key(): Promise<Buffer>;
}

export class StaticApplicationPipelineProofKeyProvider implements ApplicationPipelineProofKeyProvider {
  constructor(private readonly value: Buffer) {
    if (value.byteLength < 32) throw new Error('application_pipeline_proof_key_too_short');
  }
  async key(): Promise<Buffer> { return Buffer.from(this.value); }
}

export class FileApplicationPipelineProofKeyProvider implements ApplicationPipelineProofKeyProvider {
  constructor(private readonly path = resolve(process.cwd(), '..', '.local-data', 'keys', 'application-pipeline-proof.key')) {}

  async key(): Promise<Buffer> {
    try {
      const existing = await readFile(this.path);
      if (existing.byteLength !== 32) throw new Error('application_pipeline_proof_key_invalid');
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const generated = randomBytes(32);
      try {
        await writeFile(this.path, generated, { flag: 'wx', mode: 0o600 });
        return generated;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        const raced = await readFile(this.path);
        if (raced.byteLength !== 32) throw new Error('application_pipeline_proof_key_invalid');
        return raced;
      }
    }
  }
}

type UnsignedProof = Omit<ApplicationPipelineProof, 'signature'>;

function proofBody(proof: ApplicationPipelineProof | UnsignedProof): UnsignedProof {
  const { signature: _signature, ...body } = proof as ApplicationPipelineProof;
  return body;
}

function assertEvidence(evidence: ApplicationPipelineEvidence, requirePreparation = false): void {
  const hashes = [
    evidence.annotatedSha256,
    evidence.iterationManifestSha256,
    evidence.candidateProfileSha256,
    evidence.styleProfileSha256,
    evidence.artifactSha256,
    evidence.languageCheck.issuesSha256,
    evidence.languageCheck.checkedArtifactSha256,
    ...(evidence.preparation ? [
      evidence.preparation.jobAnalysisSha256,
      evidence.preparation.matchMatrixSha256,
      evidence.preparation.unresolvedQuestionsSha256,
    ] : []),
  ];
  if (!/^1\./.test(evidence.pipelineContractVersion) || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('application_pipeline_evidence_invalid');
  }
  if (!evidence.languageCheck.available || !evidence.languageCheck.backend || evidence.languageCheck.issueCount < 0) {
    throw new Error('application_pipeline_language_check_invalid');
  }
  const requiredStages = ['validate_profiles', 'validate_iteration', 'audit_claims', 'check_style'];
  if (requiredStages.some((stage) => !evidence.completedStages.includes(stage))) {
    throw new Error('application_pipeline_stages_incomplete');
  }
  if (requirePreparation && (!evidence.preparation || evidence.preparation.matchMatrixValid !== true
    || ['analyze_job', 'build_match_matrix', 'questions_reviewed'].some((stage) => !evidence.completedStages.includes(stage)))) {
    throw new Error('application_pipeline_preparation_incomplete');
  }
}

export class ApplicationPipelineProofAuthority {
  constructor(
    private readonly keys: ApplicationPipelineProofKeyProvider = new FileApplicationPipelineProofKeyProvider(),
    private readonly clock: () => Date = () => new Date()
  ) {}

  async issue(input: {
    applicationCaseId: string;
    jobId: string;
    identityId: string;
    documentType: ApplicationArtifactRevision['type'];
    evidence: ApplicationPipelineEvidence;
  }): Promise<ApplicationPipelineProof> {
    assertEvidence(input.evidence, true);
    const body: UnsignedProof = {
      contract: 'application-pipeline-proof',
      contractVersion: '1.0',
      applicationCaseId: input.applicationCaseId,
      jobId: input.jobId,
      identityId: input.identityId,
      documentType: input.documentType,
      issuedAt: this.clock().toISOString(),
      ...structuredClone(input.evidence)
    };
    const signature = createHmac('sha256', await this.keys.key()).update(canonicalJson(body), 'utf8').digest('base64url');
    return { ...body, signature };
  }

  async verify(
    proof: ApplicationPipelineProof,
    expected?: Partial<Pick<ApplicationPipelineProof, 'applicationCaseId' | 'jobId' | 'identityId' | 'documentType' | 'artifactSha256'>>
  ): Promise<void> {
    if (proof.contract !== 'application-pipeline-proof' || proof.contractVersion !== '1.0') {
      throw new Error('application_pipeline_proof_contract_invalid');
    }
    assertEvidence(proof);
    if (!/^[A-Za-z0-9_-]+$/.test(proof.signature)) throw new Error('application_pipeline_proof_signature_invalid');
    const actual = Buffer.from(proof.signature, 'base64url');
    if (actual.toString('base64url') !== proof.signature) throw new Error('application_pipeline_proof_signature_invalid');
    const expectedSignature = createHmac('sha256', await this.keys.key()).update(canonicalJson(proofBody(proof)), 'utf8').digest();
    if (actual.byteLength !== expectedSignature.byteLength || !timingSafeEqual(actual, expectedSignature)) {
      throw new Error('application_pipeline_proof_signature_invalid');
    }
    for (const [key, value] of Object.entries(expected ?? {})) {
      if (value !== undefined && proof[key as keyof ApplicationPipelineProof] !== value) {
        throw new Error(`application_pipeline_proof_${key}_mismatch`);
      }
    }
  }
}
