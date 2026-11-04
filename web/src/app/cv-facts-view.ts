import type { CvFact, CvFactCategory } from './models';

/**
 * Shared CV fact view model for the profile panel and the CV studio: readable
 * German labels, station cards grouped by category:recordId (never merging
 * categories), and quiet section ordering adapted from the Lab reference
 * (resumeFacts.js/CvFactsEditor.jsx). Facts remain unverified user data.
 */

export interface CvFactRecordView {
  recordId: string;
  category: CvFactCategory;
  facts: CvFact[];
  title: string;
  period?: string;
}

export interface CvFactViewSection {
  id: CvFactCategory;
  label: string;
  kind: 'card' | 'chips' | 'fields';
}

export const CV_FACT_VIEW_SECTIONS: readonly CvFactViewSection[] = [
  { id: 'profile', label: 'Persönliche Angaben', kind: 'fields' },
  { id: 'contact', label: 'Anschrift & Kontakt', kind: 'fields' },
  { id: 'employment', label: 'Berufliche Stationen', kind: 'card' },
  { id: 'education', label: 'Ausbildung', kind: 'card' },
  { id: 'project', label: 'Projekte', kind: 'card' },
  { id: 'certification', label: 'Zertifikate', kind: 'card' },
  { id: 'skill', label: 'Kenntnisse', kind: 'chips' },
  { id: 'language', label: 'Sprachen', kind: 'chips' },
  { id: 'additional', label: 'Weitere Angaben', kind: 'fields' },
];

const FIELD_LABELS: Record<string, string> = {
  full_name: 'Name', first_name: 'Vorname', last_name: 'Nachname', title: 'Titel',
  address: 'Anschrift', street: 'Straße', house_number: 'Hausnummer', postal_code: 'Postleitzahl',
  city: 'Ort', country: 'Land', email: 'E-Mail', phone: 'Telefon', url: 'Webseite / Profil',
  birth_date: 'Geburtsdatum', date_of_birth: 'Geburtsdatum', nationality: 'Staatsangehörigkeit',
  role: 'Position', position: 'Position', company: 'Arbeitgeber', employer: 'Arbeitgeber', location: 'Ort',
  start_date: 'Beginn', start: 'Beginn', end_date: 'Ende', end: 'Ende', period: 'Zeitraum',
  employment_type: 'Beschäftigungsart', detail: 'Tätigkeit', details: 'Tätigkeit',
  responsibilities: 'Aufgaben', achievement: 'Ergebnis', description: 'Beschreibung',
  degree: 'Abschluss', institution: 'Einrichtung', context: 'Kontext', link: 'Link',
  issuer: 'Ausgestellt von', issue_date: 'Ausgestellt am', expiry_date: 'Gültig bis',
  credential_url: 'Nachweis', canonical_name: 'Bezeichnung', name: 'Bezeichnung',
  category: 'Gruppe', level: 'Niveau', last_used: 'Zuletzt verwendet',
  language: 'Sprache', text: 'Angabe', heading: 'Überschrift', summary: 'Kurzprofil',
  headline: 'Kurzprofil', skills: 'Kenntnisse',
};

const NAME_FALLBACKS: Record<string, string> = {
  skill: 'Fähigkeit', education: 'Ausbildung', project: 'Projekt', certification: 'Zertifikat',
};

export const CV_RECORD_BLOCK_LABELS: Record<string, string> = {
  employment: 'Berufsstation', education: 'Ausbildungsstation', project: 'Projekt', certification: 'Zertifikat',
};

/** Readable label for one fact field; contact.* is mapped, details[n] is a task line. */
export function cvFactViewLabel(field: string, category?: CvFactCategory): string {
  const leaf = field.replace(/\[\d+\]/g, '').split('.').at(-1) ?? field;
  if (/^details\[\d+\]$/.test(field)) return 'Tätigkeit';
  if (leaf === 'name') return (category ? NAME_FALLBACKS[category] : undefined) ?? 'Bezeichnung';
  if (field.startsWith('contact.')) return FIELD_LABELS[leaf] ?? leaf.replace(/_/g, ' ');
  return FIELD_LABELS[leaf]
    ?? leaf.replace(/_/g, ' ').replace(/^./, (value) => value.toLocaleUpperCase('de-DE'));
}

export function isCvDetailField(field: string): boolean {
  return /^details\[\d+\]$/.test(field);
}

function groupFactValue(facts: readonly CvFact[], fields: readonly string[]): string | undefined {
  const allowed = new Set(fields);
  for (const decision of ['confirmed', 'pending'] as const) {
    const match = facts.find((fact) => fact.decision === decision
      && allowed.has(fact.field.toLocaleLowerCase('en-US').split('.').at(-1)!.replace(/\[[0-9]{1,4}\]$/, '')));
    if (match?.value.trim()) return match.value.trim();
  }
  return undefined;
}

function groupDateRange(facts: readonly CvFact[]): string | undefined {
  const start = groupFactValue(facts, ['start_date', 'start']);
  const end = groupFactValue(facts, ['end_date', 'end']);
  return start || end ? `${start ?? '?'} – ${end ?? 'heute'}` : undefined;
}

function employmentDateRank(facts: readonly CvFact[], end: boolean): number {
  const value = end
    ? groupFactValue(facts, ['end_date', 'end', 'period', 'date_range', 'duration'])
    : groupFactValue(facts, ['start_date', 'start', 'period', 'date_range', 'duration']);
  if (!value) return Number.NEGATIVE_INFINITY;
  if (end && /\b(?:present|current|heute|aktuell|gegenwärtig|laufend|now)\b/i.test(value)) return Number.MAX_SAFE_INTEGER;
  const dates = [...value.matchAll(/\b((?:19|20)\d{2})(?:[-/.](0?[1-9]|1[0-2]))?\b/g)]
    .map((match) => Number(match[1]) * 12 + Number(match[2] ?? (end ? 12 : 1)));
  if (!dates.length) return Number.NEGATIVE_INFINITY;
  return end ? dates.at(-1)! : dates[0]!;
}

/**
 * Groups facts into station cards by category:recordId. The same recordId in
 * different categories never merges (Lab groupRecords merged by recordId only,
 * which would fuse unrelated records); missing titles fall back to readable
 * station numbers, never to hashes.
 */
export function groupCvFactRecords(facts: readonly CvFact[]): CvFactRecordView[] {
  const groups = new Map<string, { facts: CvFact[]; index: number }>();
  for (const [index, fact] of facts.entries()) {
    const key = `${fact.category}:${fact.recordId}`;
    const current = groups.get(key);
    groups.set(key, { facts: [...(current?.facts ?? []), fact], index: current?.index ?? index });
  }
  const records = [...groups.entries()].map(([key, group]) => {
    const recordId = group.facts[0]?.recordId ?? key;
    const category = group.facts[0]?.category ?? 'additional';
    const role = groupFactValue(group.facts, ['role', 'position', 'title', 'job_title']);
    const company = groupFactValue(group.facts, ['company', 'employer', 'organization']);
    const period = groupFactValue(group.facts, ['period', 'date_range', 'duration']) ?? groupDateRange(group.facts);
    const generic = groupFactValue(group.facts, ['name', 'title', 'degree', 'institution', 'description']);
    const blockLabel = CV_RECORD_BLOCK_LABELS[category];
    const ordinal = [...groups.keys()].filter((candidate) => candidate.startsWith(`${category}:`)).indexOf(key) + 1;
    const title = blockLabel
      ? [role, company].filter(Boolean).join(' · ') || generic || `${blockLabel} ${ordinal}`
      : generic || recordId;
    return { recordId, category, facts: group.facts, title, ...(period ? { period } : {}), index: group.index };
  });
  const employment = records.filter((record) => record.category === 'employment').sort((left, right) => {
    const leftEnd = employmentDateRank(left.facts, true);
    const rightEnd = employmentDateRank(right.facts, true);
    if (leftEnd !== rightEnd) return rightEnd - leftEnd;
    const leftStart = employmentDateRank(left.facts, false);
    const rightStart = employmentDateRank(right.facts, false);
    return rightStart - leftStart || left.index - right.index;
  });
  return [
    ...employment,
    ...records.filter((record) => record.category !== 'employment').sort((left, right) => left.index - right.index),
  ].map(({ index: _index, ...record }) => record);
}

export function cvFactGroupIsRaw(record: CvFactRecordView): boolean {
  if (record.category === 'additional') return true;
  return record.facts.length > 0 && record.facts.every((fact) => {
    const root = fact.field.toLocaleLowerCase('en-US').split('.')[0]!.replace(/\[[0-9]{1,4}\]$/, '');
    return root === 'other' || root === 'additional';
  });
}

/** Sensible values (identity/contact) stay masked until the user explicitly reveals them. */
export function cvFactIsSensitive(fact: CvFact): boolean {
  return fact.category === 'profile' || fact.category === 'contact' || fact.field.startsWith('contact.');
}
