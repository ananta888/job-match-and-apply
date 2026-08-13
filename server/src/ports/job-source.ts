import type { JobPosting, SearchProfile, SourceStatus } from '../domain/models.js';

export interface LoginResult {
  status: string;
  portalId: string;
  note?: string;
}

export interface JobSourcePort {
  statuses(): Promise<SourceStatus[]>;
  search(profile: SearchProfile): Promise<JobPosting[]>;
  login(portalId: string): Promise<LoginResult>;
}
