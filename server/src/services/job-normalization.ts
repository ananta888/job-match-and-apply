import { createHash } from 'node:crypto';
import type { JobPosting, SourceReference } from '../domain/models.js';

/** Shape every stored job identifier must satisfy. */
export const SAFE_JOB_ID = /^job-[a-f0-9]{16}$/;

const normalized = (value: string): string => value.normalize('NFKC').trim().toLocaleLowerCase('de-DE').replace(/\s+/g, ' ');

function mergeReferences(left: SourceReference[] = [], right: SourceReference[] = []): SourceReference[] {
  const byKey = new Map<string, SourceReference>();
  for (const reference of [...left, ...right]) byKey.set(`${reference.sourceId}:${reference.externalId}`, reference);
  return [...byKey.values()];
}

/** Stable cross-source/cross-run identity key: normalized URL (query/hash stripped) or `title|company|location`. */
export function jobIdentityKey(job: JobPosting): string {
  const urlKey = job.url ? normalized(job.url).replace(/[?#].*$/, '') : '';
  const semanticKey = [job.title, job.company, job.location].map(normalized).join('|');
  return urlKey || semanticKey;
}

/**
 * Allowlist-safe identifier derived from the stable identity key.
 *
 * Sources hand out whatever they please as an id — the MCP sources use the
 * posting URL, which carries `/`, `?` and `&`. Those ids flow into agent
 * orchestration scopes, artifact metadata and process contexts, all of which
 * accept only a narrow character set, so an unnormalized id made every
 * case-bound orchestration fail. The source's own id stays available in
 * `sourceReferences[].externalId` and the address in `url`.
 */
export function safeJobId(job: JobPosting): string {
  return `job-${createHash('sha256').update(jobIdentityKey(job)).digest('hex').slice(0, 16)}`;
}

export function mergeJob(left: JobPosting, right: JobPosting): JobPosting {
  const prefer = (first: string, second: string): string => first.trim().length >= second.trim().length ? first : second;
  const selectedDescription = left.description.trim().length >= right.description.trim().length ? left : right;
  const references = mergeReferences(left.sourceReferences, right.sourceReferences);
  return {
    ...left,
    title: prefer(left.title, right.title), company: prefer(left.company, right.company),
    location: prefer(left.location, right.location), description: prefer(left.description, right.description),
    skills: [...new Set([...left.skills, ...right.skills])],
    salaryMin: left.salaryMin ?? right.salaryMin, salaryMax: left.salaryMax ?? right.salaryMax,
    salaryCurrency: left.salaryCurrency ?? right.salaryCurrency, language: left.language ?? right.language,
    url: left.url ?? right.url, publishedAt: left.publishedAt ?? right.publishedAt,
    fetchedAt: [left.fetchedAt, right.fetchedAt].filter(Boolean).sort().at(-1),
    sourceReferences: references,
    fieldProvenance: {
      ...(left.fieldProvenance ?? {}), ...(right.fieldProvenance ?? {}),
      description: { sourceId: selectedDescription.sourceId, externalId: selectedDescription.id, strategy: 'longest_non_empty' },
      skills: { sourceId: 'local-derived', externalId: references.map((item) => item.externalId).join(','), strategy: 'stable_union' }
    },
    mergeHistory: [...(left.mergeHistory ?? []), ...(right.mergeHistory ?? []), {
      mergedAt: [left.fetchedAt, right.fetchedAt].filter(Boolean).sort().at(-1) ?? 'unknown',
      sourceIds: [...new Set(references.map((item) => item.sourceId))], strategy: 'normalized_url_or_title_company_location'
    }],
    normalizationWarnings: [...new Set([
      ...(left.normalizationWarnings ?? []), ...(right.normalizationWarnings ?? []),
      left.sourceId === right.sourceId ? '' : `Duplikat aus ${left.sourceId} und ${right.sourceId} zusammengeführt.`
    ].filter(Boolean))]
  };
}

export function deduplicateJobs(jobs: JobPosting[]): JobPosting[] {
  const merged = new Map<string, JobPosting>();
  for (const job of jobs) {
    const key = jobIdentityKey(job);
    // Normalize on the way in, so no source-shaped id ever reaches storage.
    const incoming = { ...structuredClone(job), id: safeJobId(job) };
    merged.set(key, merged.has(key) ? mergeJob(merged.get(key)!, incoming) : incoming);
  }
  return [...merged.values()];
}
