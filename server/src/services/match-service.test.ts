import { describe, expect, it } from 'vitest';
import type { JobPosting, SearchProfile } from '../domain/models.js';
import { matchJob } from './match-service.js';

const profile: SearchProfile = {
  name: 'Test', query: 'Angular', regions: ['Berlin'], radiusKm: 50,
  workModels: ['hybrid'], employmentTypes: ['full_time'], mustHave: ['TypeScript'],
  niceToHave: ['Angular'], exclude: ['Arbeitnehmerüberlassung'], minSalary: 60000, sourceIds: ['demo']
};

const job: JobPosting = {
  id: '1', sourceId: 'demo', title: 'Angular Developer', company: 'Example', location: 'Berlin',
  workModel: 'hybrid', employmentType: 'full_time', description: 'TypeScript und Angular',
  skills: ['TypeScript', 'Angular'], salaryMax: 80000
};

describe('matchJob', () => {
  it('accepts a job that satisfies all hard filters', () => {
    const result = matchJob(profile, job);
    expect(result.accepted).toBe(true);
    expect(result.searchPreferenceScore).toBe(100);
    expect(Object.values(result.scoreBreakdown).reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it('rejects excluded wording even when skills match', () => {
    const result = matchJob(profile, { ...job, description: `${job.description} Arbeitnehmerüberlassung` });
    expect(result.accepted).toBe(false);
    expect(result.exclusions).toEqual(['Arbeitnehmerüberlassung']);
  });
});
