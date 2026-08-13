import type { ApplicationDraft, IdentityProfile, JobMatch } from '../domain/models.js';

export interface ApplicationAssistantPort {
  status(): Promise<{ available: boolean; note: string }>;
  draft(match: JobMatch, identity: IdentityProfile, documentType: 'cover_letter' | 'email'): Promise<ApplicationDraft>;
}
