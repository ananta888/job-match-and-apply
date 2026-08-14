import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApplicationPipelineEvidence } from '../domain/models.js';
import {
  ApplicationPipelineProofAuthority,
  StaticApplicationPipelineProofKeyProvider
} from './application-pipeline-proof.js';

const hash = 'a'.repeat(64);
const evidence: ApplicationPipelineEvidence = {
  pipelineContractVersion: '1.0',
  completedStages: ['validate_profiles', 'analyze_job', 'build_match_matrix', 'questions_reviewed', 'validate_iteration', 'audit_claims', 'check_style'],
  annotatedSha256: hash,
  iterationManifestSha256: hash,
  candidateProfileSha256: hash,
  styleProfileSha256: hash,
  artifactSha256: hash,
  preparation: { jobAnalysisSha256: hash, matchMatrixSha256: hash, unresolvedQuestionsSha256: hash, matchMatrixValid: true },
  languageCheck: {
    available: true,
    backend: 'nspell',
    language: 'de-DE',
    issueCount: 0,
    issuesSha256: hash,
    checkedArtifactSha256: hash
  }
};

describe('ApplicationPipelineProofAuthority', () => {
  it('binds a server signature to case, identity, document and all evidence hashes', async () => {
    const authority = new ApplicationPipelineProofAuthority(
      new StaticApplicationPipelineProofKeyProvider(randomBytes(32)),
      () => new Date('2026-08-14T10:00:00Z')
    );
    const proof = await authority.issue({
      applicationCaseId: 'case-1', jobId: 'job-1', identityId: 'real-1', documentType: 'cover_letter', evidence
    });
    await expect(authority.verify(proof, {
      applicationCaseId: 'case-1', artifactSha256: hash, documentType: 'cover_letter'
    })).resolves.toBeUndefined();
    await expect(authority.verify({ ...proof, artifactSha256: 'b'.repeat(64) })).rejects.toThrow('signature_invalid');
    await expect(authority.verify(proof, { applicationCaseId: 'foreign-case' })).rejects.toThrow('mismatch');
  });
});
