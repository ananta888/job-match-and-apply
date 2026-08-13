export type WorkModel = 'remote' | 'hybrid' | 'onsite';
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'freelance' | 'internship';

export interface SearchProfile {
  name: string;
  query: string;
  regions: string[];
  radiusKm: number;
  workModels: WorkModel[];
  employmentTypes: EmploymentType[];
  mustHave: string[];
  niceToHave: string[];
  exclude: string[];
  minSalary?: number;
  sourceIds: string[];
}

export interface IdentityProfile {
  id: string;
  label: string;
  mode: 'real' | 'incognito';
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  placeholders: Record<string, string>;
}

export interface JobPosting {
  id: string;
  sourceId: string;
  title: string;
  company: string;
  location: string;
  workModel: WorkModel;
  employmentType: EmploymentType;
  description: string;
  skills: string[];
  salaryMin?: number;
  salaryMax?: number;
  url?: string;
  publishedAt?: string;
}

export interface JobMatch {
  job: JobPosting;
  score: number;
  accepted: boolean;
  matchedMustHave: string[];
  missingMustHave: string[];
  matchedNiceToHave: string[];
  exclusions: string[];
}

export interface SourceStatus {
  id: string;
  name: string;
  kind: 'mcp' | 'profile' | 'demo';
  enabled: boolean;
  connected: boolean;
  supportsLogin: boolean;
  sessionAvailable?: boolean;
  note: string;
}

export interface AppConfig {
  searchProfile: SearchProfile;
  identities: IdentityProfile[];
  activeIdentityId: string;
  mcp: {
    mode: 'demo' | 'stdio';
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  assistant: {
    skillPath: string;
    candidateProfilePath: string;
    styleProfilePath: string;
  };
}

export interface ApplicationDraft {
  jobId: string;
  identityId: string;
  documentType: 'cover_letter' | 'email';
  content: string;
  strongestMatches: string[];
  gaps: string[];
  warnings: string[];
}
