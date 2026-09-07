export interface CandidateClaimSummary {
  id: string;
  category?: string;
  statement: string;
  status: 'verified' | 'user_confirmed' | 'inferred' | 'unverified' | 'do_not_use';
  evidenceRefs: string[];
  allowedOutputs: string[];
  validFrom?: string;
  validTo?: string;
}

export const candidateEvidenceCollections = [
  'experience', 'projects', 'skills', 'education', 'certifications', 'languages',
] as const;
export type CandidateEvidenceCollection = (typeof candidateEvidenceCollections)[number];

export interface CandidateEvidenceSnapshot {
  contractVersion: string;
  outputType: 'cv' | 'cover_letter' | 'email' | 'linkedin' | 'interview';
  valid: boolean;
  errors: string[];
  claims: CandidateClaimSummary[];
  records: Record<CandidateEvidenceCollection, Array<Record<string, unknown>>>;
}

export interface CandidateProfileSummary {
  contractVersion: string;
  valid: boolean;
  errors: string[];
  profile: Record<string, unknown>;
  claims: CandidateClaimSummary[];
}

export interface ClaimPatchOperation { claimId: string; field: string; value: unknown; }

export interface CandidateProfilePort {
  summary(): Promise<CandidateProfileSummary>;
  evidence(outputType: CandidateEvidenceSnapshot['outputType']): Promise<CandidateEvidenceSnapshot>;
  patch(operations: ClaimPatchOperation[], confirmed: boolean): Promise<{ status: string; updatedClaimIds: string[] }>;
  addImportProposals(proposals: Array<{ id: string; statement: string; sha256: string }>, confirmed: boolean): Promise<{ status: string; addedClaimIds: string[] }>;
}
