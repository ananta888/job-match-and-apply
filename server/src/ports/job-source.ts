import type { JobPosting, JobSourceCapabilities, SearchProfile, SourceStatus } from '../domain/models.js';

export interface LoginResult {
  status: string;
  portalId: string;
  note?: string;
}

export interface JobSourcePort {
  capabilities(): Promise<JobSourceCapabilities>;
  statuses(): Promise<SourceStatus[]>;
  search(profile: SearchProfile): Promise<JobPosting[]>;
  searchDetailed(profile: SearchProfile): Promise<{ jobs: JobPosting[]; failures: Array<{ sourceId: string; category: string; retryable: boolean; detail: string }> }>;
  login(portalId: string): Promise<LoginResult>;
  logout(portalId: string): Promise<LoginResult>;
}
