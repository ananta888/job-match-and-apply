export interface CandidateClaimSummary {
  id: string;
  statement: string;
  status: 'verified' | 'user_confirmed' | 'inferred' | 'unverified' | 'do_not_use';
  evidenceRefs: string[];
  allowedOutputs: string[];
  validFrom?: string;
  validTo?: string;
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
  patch(operations: ClaimPatchOperation[], confirmed: boolean): Promise<{ status: string; updatedClaimIds: string[] }>;
  addImportProposals(proposals: Array<{ id: string; statement: string; sha256: string }>, confirmed: boolean): Promise<{ status: string; addedClaimIds: string[] }>;
}
