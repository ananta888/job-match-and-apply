import type { ApplicationDraft, ApplicationPipelineCapabilities, CandidateMatchAnalysis, IdentityProfile, JobPosting } from '../domain/models.js';

export interface FinalizeApplicationCommand {
  job: JobPosting;
  identity: IdentityProfile;
  documentType: 'cv' | 'cover_letter' | 'email';
  annotatedContent: string;
  iterationManifest: string;
}

export interface ApplicationAssistantPort {
  capabilities(): Promise<ApplicationPipelineCapabilities>;
  analyze(job: JobPosting, documentType: 'cv' | 'cover_letter' | 'email'): Promise<CandidateMatchAnalysis>;
  status(): Promise<{ available: boolean; note: string }>;
  preview(job: JobPosting, identity: IdentityProfile, documentType: 'cv' | 'cover_letter' | 'email'): Promise<ApplicationDraft>;
  finalize(command: FinalizeApplicationCommand): Promise<ApplicationDraft>;
}
