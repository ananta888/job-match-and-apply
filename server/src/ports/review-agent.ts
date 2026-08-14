export type ReviewRole = 'author' | 'evidence_ats_reviewer' | 'recruiter_style_reviewer' | 'finalizer';
export interface ReviewFinding {
  id: string; severity: 'low' | 'medium' | 'high' | 'critical'; category: string;
  description: string; status: 'open' | 'resolved' | 'accepted_risk'; disposition?: string;
}
export interface ReviewRequest {
  role: ReviewRole;
  jobAnalysis: unknown;
  candidateClaims: unknown;
  styleProfile: unknown;
  revision: string;
  criteria: string[];
}
export interface ReviewResult { revision: string; findings: ReviewFinding[]; }
export interface ReviewAgentPort { execute(request: ReviewRequest): Promise<ReviewResult>; }
