import type { SearchPreferenceMatch } from '../domain/models.js';

export interface CandidateCoverage { jobId: string; direct: number; transferable: number; partial: number; gaps: number; }
export interface ComparisonWeights { searchPreference: number; evidenceCoverage: number; gaps: number; salary: number; }

export function compareJobs(matches: SearchPreferenceMatch[], coverage: CandidateCoverage[], weights: ComparisonWeights) {
  const coverageByJob = new Map(coverage.map((item) => [item.jobId, item]));
  return matches.map((match) => {
    const evidence = coverageByJob.get(match.job.id) ?? { jobId: match.job.id, direct: 0, transferable: 0, partial: 0, gaps: 0 };
    const evidencePoints = evidence.direct * 3 + evidence.transferable * 2 + evidence.partial;
    const salary = match.job.salaryMin ?? 0;
    const factors = {
      searchPreference: match.searchPreferenceScore * weights.searchPreference,
      evidenceCoverage: evidencePoints * weights.evidenceCoverage,
      gaps: -evidence.gaps * weights.gaps,
      salary: salary / 1000 * weights.salary
    };
    return { jobId: match.job.id, title: match.job.title, company: match.job.company, factors, total: Object.values(factors).reduce((sum, value) => sum + value, 0), evidence };
  }).sort((left, right) => right.total - left.total);
}
