import { describe, expect, it } from 'vitest';
import type { SearchPreferenceMatch } from '../domain/models.js';
import { compareJobs } from './job-comparison.js';

const match = (id: string, score: number): SearchPreferenceMatch => ({
  job: { id, sourceId: 'demo', title: id, company: 'Example', location: '', workModel: 'unknown', employmentType: 'unknown', description: '', skills: [] },
  searchPreferenceScore: score, accepted: true, matchedMustHave: [], missingMustHave: [], matchedNiceToHave: [], exclusions: [],
  scoreBreakdown: { mustHave: score, niceToHave: 0, region: 0, workModel: 0, exclusions: 0 }
});

describe('compareJobs', () => {
  it('keeps preference and evidence factors separately explainable', () => {
    const result = compareJobs([match('a', 90), match('b', 80)], [{ jobId: 'b', direct: 5, transferable: 0, partial: 0, gaps: 0 }], { searchPreference: 1, evidenceCoverage: 2, gaps: 3, salary: 0 });
    expect(result[0]?.factors).toHaveProperty('searchPreference');
    expect(result[0]?.factors).toHaveProperty('evidenceCoverage');
    expect(result.find((item) => item.jobId === 'b')?.evidence.direct).toBe(5);
  });
});
