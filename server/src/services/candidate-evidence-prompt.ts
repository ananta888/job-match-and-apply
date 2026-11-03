/**
 * Prompt-facing rendering of the candidate evidence. The full snapshot repeats
 * status, allowedOutputs, evidenceRefs and a derived sourceReference on every
 * one of hundreds of claims and duplicates each record's values as atomic
 * claims; a real CV grew to ~110 KB (~40k tokens) per node this way. The
 * compact form keeps every claim id, category, statement and evidence ref,
 * keeps the records with their claim ids, and states the uniform fields once
 * in a legend. LAB_CAREER_EVIDENCE_FORMAT=full restores the verbose form.
 */
export function compactCandidateEvidence(snapshot: {
  contract: string; contractVersion: string; outputType: string;
  claims: Array<Record<string, unknown> & { id: string; category?: string; statement: string; status?: string; evidenceRefs?: string[]; allowedOutputs?: string[] }>;
  records: Record<string, Array<Record<string, unknown>>>;
}, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  if (env.LAB_CAREER_EVIDENCE_FORMAT === 'full') return snapshot;
  const statuses = new Set(snapshot.claims.map((claim) => claim.status ?? ''));
  const outputs = new Set(snapshot.claims.map((claim) => JSON.stringify(claim.allowedOutputs ?? [])));
  const refs = new Set(snapshot.claims.map((claim) => JSON.stringify(claim.evidenceRefs ?? [])));
  if (statuses.size > 1 || outputs.size > 1) return snapshot;
  const uniformRefs = refs.size === 1 ? (snapshot.claims[0]?.evidenceRefs ?? []) : null;
  const dropped = new Set<string>();
  return {
    contract: snapshot.contract, contractVersion: snapshot.contractVersion, outputType: snapshot.outputType, format: 'compact-1',
    legend: {
      claims: 'Each claim is [id, category, statement' + (uniformRefs ? '' : ', evidenceRefs') + ']. Cite claim ids exactly as written; look them up here before citing.',
      ...(statuses.size === 1 ? { status: [...statuses][0] } : {}),
      ...(outputs.size === 1 ? { allowedOutputs: JSON.parse([...outputs][0] ?? "[]") } : {}),
      ...(uniformRefs ? { evidenceRefs: uniformRefs } : {}),
      sourceReference: 'Claim references are derived as local:<sha256(claim:<claim id>)>; record references are retained.',
      records: 'Structured entries with their claim_ids; a detail carries its own claim_id.',
    },
    claims: snapshot.claims.map((claim) => uniformRefs ? [claim.id, claim.category ?? 'other', claim.statement] : [claim.id, claim.category ?? 'other', claim.statement, claim.evidenceRefs ?? []]),
    records: Object.fromEntries(Object.entries(snapshot.records).map(([collection, records]) => [
      collection,
      records.map((record) => Object.fromEntries(Object.entries(record).filter(([key, value]) => !dropped.has(key) && value !== '' && value !== undefined && value !== null
        && !(Array.isArray(value) && value.length === 0)))),
    ])),
  };
}

/**
 * Claim and evidence ids of a rendered candidate_evidence section, used as the
 * allowed set for the one targeted correction round on unknown ids. Handles the
 * compact form (claims as tuples, uniform refs in the legend) and the full
 * snapshot. Returns undefined for anything else; the caller then skips the
 * check instead of guessing.
 */
export function evidenceIdsFromSnapshot(content: string): { claimIds: string[]; evidenceRefs: string[] } | undefined {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as { claims?: unknown; legend?: { evidenceRefs?: unknown } };
  if (!Array.isArray(snapshot.claims)) return undefined;
  const claimIds = new Set<string>(), evidenceRefs = new Set<string>();
  const add = (set: Set<string>, candidate: unknown): void => {
    if (typeof candidate !== 'string' || !candidate || candidate.length > 300 || set.size >= 5_000) return;
    set.add(candidate);
  };
  const legendRefs = Array.isArray(snapshot.legend?.evidenceRefs) ? snapshot.legend.evidenceRefs : [];
  for (const ref of legendRefs) add(evidenceRefs, ref);
  for (const claim of snapshot.claims) {
    if (Array.isArray(claim)) {
      add(claimIds, claim[0]);
      if (Array.isArray(claim[3])) for (const ref of claim[3]) add(evidenceRefs, ref);
      continue;
    }
    if (!claim || typeof claim !== 'object') return undefined;
    const entry = claim as { id?: unknown; evidenceRefs?: unknown };
    add(claimIds, entry.id);
    if (Array.isArray(entry.evidenceRefs)) for (const ref of entry.evidenceRefs) add(evidenceRefs, ref);
  }
  return claimIds.size ? { claimIds: [...claimIds], evidenceRefs: [...evidenceRefs] } : undefined;
}
