import type { JobMatch, JobPosting, SearchProfile } from '../domain/models.js';

const normalize = (value: string): string => value.trim().toLocaleLowerCase('de-DE');

export function matchJob(profile: SearchProfile, job: JobPosting): JobMatch {
  const haystack = normalize([job.title, job.company, job.description, ...job.skills].join(' '));
  const contains = (term: string): boolean => haystack.includes(normalize(term));
  const matchedMustHave = profile.mustHave.filter(contains);
  const missingMustHave = profile.mustHave.filter((term) => !contains(term));
  const matchedNiceToHave = profile.niceToHave.filter(contains);
  const exclusions = profile.exclude.filter(contains);
  const mustScore = profile.mustHave.length === 0 ? 60 : (matchedMustHave.length / profile.mustHave.length) * 60;
  const niceScore = profile.niceToHave.length === 0 ? 20 : (matchedNiceToHave.length / profile.niceToHave.length) * 20;
  const regionScore = profile.regions.some((region) => normalize(job.location).includes(normalize(region))) ? 10 : 0;
  const workModelScore = profile.workModels.includes(job.workModel) ? 10 : 0;
  const salaryAccepted = !profile.minSalary || !job.salaryMax || job.salaryMax >= profile.minSalary;
  const accepted = missingMustHave.length === 0 && exclusions.length === 0 && salaryAccepted;
  return {
    job,
    score: Math.max(0, Math.round(mustScore + niceScore + regionScore + workModelScore - exclusions.length * 30)),
    accepted,
    matchedMustHave,
    missingMustHave,
    matchedNiceToHave,
    exclusions
  };
}
