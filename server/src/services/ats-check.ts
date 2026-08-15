import { createHash } from 'node:crypto';
import { Parser as HtmlParser } from 'htmlparser2';
import { classifyLayoutSection } from './cv-layout-fingerprint.js';

/**
 * Deterministic, in-process ATS check over generated CV HTML.
 *
 * Two complementary, fully local and explainable parts, with no external network and — per
 * `references/ats-rules.md` — no fabricated "ATS score":
 *  1. A lint of structural ATS-friendliness rules (headings, single column, tables, images, etc.).
 *  2. A named rule-based parser round-trip that reports what a real ATS could recover from the
 *     document (sections, contact fields, counts), modelled on how open-source resume parsers work.
 * Optional keyword coverage is reported as counts by requirement priority, never as a score.
 */

const MAX_HTML = 2_000_000;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE = /(?:\+\d{1,3}[\s./-]?)?(?:\(?\d{2,5}\)?[\s./-]?){2,5}\d{2,}/;
const YEAR_RANGE = /\b(19|20)\d{2}\b\s*(?:[–-]|bis|to)\s*(?:\b(19|20)\d{2}\b|heute|present|now)/i;

export type AtsLintStatus = 'pass' | 'warn' | 'fail';
export interface AtsLintRule { id: string; label: string; status: AtsLintStatus; detail: string }

export interface AtsParseResult {
  parser: 'local-rule-based-ats-parser';
  parserVersion: '1.0';
  detectedSections: Array<{ heading: string; canonical: string | null; itemCount: number }>;
  recovered: { name?: string; email?: string; phone?: string; hasDateRanges: boolean };
  counts: { sections: number; experienceItems: number; educationItems: number; skills: number; bullets: number };
  warnings: string[];
}

export interface AtsCoverage {
  mustHave: AtsCoverageGroup;
  niceToHave: AtsCoverageGroup;
}
export interface AtsCoverageGroup {
  total: number;
  matched: number;
  terms: Array<{ term: string; present: boolean }>;
}

export interface AtsCheckReport {
  contract: 'ats-check';
  contractVersion: '1.0';
  engine: 'deterministic-local';
  checkedAt: string;
  htmlSha256: string;
  summary: { pass: number; warn: number; fail: number; parseable: boolean };
  lint: AtsLintRule[];
  parse: AtsParseResult;
  coverage?: AtsCoverage;
  disclaimer: string;
}

interface HtmlSignals {
  headings: Array<{ level: number; text: string }>;
  sections: Array<{ heading: string; items: string[] }>;
  text: string;
  hasTable: boolean;
  hasImage: boolean;
  hasHeaderFooter: boolean;
  hasAside: boolean;
  bodyColumns?: string;
  bulletCount: number;
}

function analyzeHtml(html: string): HtmlSignals {
  const headings: HtmlSignals['headings'] = [];
  const sections: HtmlSignals['sections'] = [];
  const textParts: string[] = [];
  let hasTable = false; let hasImage = false; let hasHeaderFooter = false; let hasAside = false; let bulletCount = 0;
  let bodyColumns: string | undefined;
  let headingLevel = 0; let headingText = '';
  let inListItem = false; let itemText = '';
  let current: { heading: string; items: string[] } | undefined;
  let inStyle = false;

  const parser = new HtmlParser({
    onopentag(name, attributes: Record<string, string>) {
      if (name === 'style') { inStyle = true; return; }
      if (name === 'table') hasTable = true;
      else if (name === 'img') hasImage = true;
      else if (name === 'header' || name === 'footer') hasHeaderFooter = true;
      else if (name === 'aside') hasAside = true;
      else if (name === 'body' && attributes['data-columns']) bodyColumns = attributes['data-columns'];
      if (/^h[1-6]$/.test(name)) { headingLevel = Number(name.slice(1)); headingText = ''; }
      if (name === 'li') { inListItem = true; itemText = ''; bulletCount += 1; }
    },
    ontext(value) {
      if (inStyle) return;
      textParts.push(value);
      if (headingLevel > 0) headingText += value;
      if (inListItem) itemText += value;
    },
    onclosetag(name) {
      if (name === 'style') { inStyle = false; return; }
      if (/^h[1-6]$/.test(name) && headingLevel > 0) {
        const text = headingText.replace(/\s+/g, ' ').trim();
        if (text) {
          headings.push({ level: headingLevel, text });
          if (headingLevel >= 2) { current = { heading: text, items: [] }; sections.push(current); }
        }
        headingLevel = 0; headingText = '';
      }
      if (name === 'li' && inListItem) {
        const text = itemText.replace(/\s+/g, ' ').trim();
        if (text && current) current.items.push(text);
        inListItem = false; itemText = '';
      }
    },
  }, { decodeEntities: true, lowerCaseTags: true, recognizeSelfClosing: true });
  parser.write(html); parser.end();

  return {
    headings, sections, text: textParts.join(' ').replace(/\s+/g, ' ').trim(),
    hasTable, hasImage, hasHeaderFooter, hasAside, bodyColumns, bulletCount,
  };
}

function lintRules(signals: HtmlSignals): AtsLintRule[] {
  const rules: AtsLintRule[] = [];
  const twoColumn = signals.hasAside || signals.bodyColumns === '2';
  rules.push({
    id: 'single-column', label: 'Einspaltige Lesereihenfolge',
    status: twoColumn ? 'warn' : 'pass',
    detail: twoColumn
      ? 'Mehrspaltiges Layout erkannt (Seitenspalte). Manche ATS lesen Spalten in unklarer Reihenfolge.'
      : 'Eine Spalte mit eindeutiger Lesereihenfolge.',
  });

  const nonStandard = signals.headings.filter((heading) => heading.level >= 2 && classifyLayoutSection(heading.text) === undefined).map((heading) => heading.text);
  const sectionHeadings = signals.headings.filter((heading) => heading.level >= 2);
  rules.push({
    id: 'standard-headings', label: 'Standard-Abschnittsüberschriften',
    status: sectionHeadings.length === 0 ? 'fail' : nonStandard.length ? 'warn' : 'pass',
    detail: sectionHeadings.length === 0
      ? 'Keine Abschnittsüberschriften (h2/h3) gefunden — ATS können keine Abschnitte zuordnen.'
      : nonStandard.length ? `Nicht-kanonische Überschriften: ${nonStandard.slice(0, 6).join(', ')}.` : 'Alle Überschriften sind ATS-üblichen Abschnitten zugeordnet.',
  });

  rules.push({
    id: 'no-tables', label: 'Keine Tabellen',
    status: signals.hasTable ? 'fail' : 'pass',
    detail: signals.hasTable ? 'Tabellen können von ATS falsch oder gar nicht geparst werden.' : 'Keine Tabellen im Dokument.',
  });
  rules.push({
    id: 'no-images-as-content', label: 'Keine Bild-Inhalte',
    status: signals.hasImage ? 'warn' : 'pass',
    detail: signals.hasImage ? 'Bilder werden von ATS nicht gelesen; wichtige Inhalte müssen als Text vorliegen.' : 'Keine Bilder als Informationsträger.',
  });
  rules.push({
    id: 'no-header-footer', label: 'Keine Kopf-/Fußzeilen-Inhalte',
    status: signals.hasHeaderFooter ? 'warn' : 'pass',
    detail: signals.hasHeaderFooter ? 'Inhalte in <header>/<footer> werden von manchen ATS ignoriert.' : 'Keine header/footer-Inhaltsbereiche.',
  });
  rules.push({
    id: 'selectable-text', label: 'Auswählbarer Text',
    status: signals.text.length > 0 ? 'pass' : 'fail',
    detail: signals.text.length > 0 ? 'Der Inhalt liegt als auswählbarer Text vor. Beim PDF-Export selektierbaren Text bewahren.' : 'Kein auswählbarer Text gefunden.',
  });
  return rules;
}

function parseResume(signals: HtmlSignals): AtsParseResult {
  const detectedSections = signals.sections.map((section) => ({
    heading: section.heading, canonical: classifyLayoutSection(section.heading) ?? null, itemCount: section.items.length,
  }));
  const itemsFor = (canonical: string) => signals.sections
    .filter((section) => classifyLayoutSection(section.heading) === canonical)
    .reduce((sum, section) => sum + section.items.length, 0);
  const skillSections = signals.sections.filter((section) => classifyLayoutSection(section.heading) === 'skill');
  const skills = skillSections.reduce((sum, section) => sum + section.items.reduce((count, item) => count + item.split(/[,;·•]/).map((part) => part.trim()).filter(Boolean).length, 0), 0);

  const email = EMAIL.exec(signals.text)?.[0];
  const phone = PHONE.exec(signals.text)?.[0]?.trim();
  const name = signals.headings.find((heading) => heading.level === 1)?.text;

  const warnings: string[] = [];
  if (detectedSections.length === 0) warnings.push('Keine Abschnitte erkennbar — ATS-Parsing würde scheitern.');
  if (!email && !phone) warnings.push('Keine Kontaktdaten (E-Mail/Telefon) parsebar.');
  if (signals.hasAside || signals.bodyColumns === '2') warnings.push('Mehrspaltiges Layout: ATS-Lesereihenfolge ist nicht garantiert.');
  if (detectedSections.every((section) => section.canonical === null) && detectedSections.length > 0) {
    warnings.push('Überschriften nicht auf ATS-Standardabschnitte abbildbar.');
  }

  return {
    parser: 'local-rule-based-ats-parser', parserVersion: '1.0', detectedSections,
    recovered: { ...(name ? { name } : {}), ...(email ? { email } : {}), ...(phone ? { phone } : {}), hasDateRanges: YEAR_RANGE.test(signals.text) },
    counts: { sections: detectedSections.length, experienceItems: itemsFor('employment'), educationItems: itemsFor('education'), skills, bullets: signals.bulletCount },
    warnings,
  };
}

function coverageGroup(text: string, terms: string[]): AtsCoverageGroup {
  const haystack = text.toLocaleLowerCase('de-DE');
  const seen = new Set<string>();
  const items = terms
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && !seen.has(term.toLocaleLowerCase('de-DE')) && seen.add(term.toLocaleLowerCase('de-DE')))
    .slice(0, 100)
    .map((term) => ({ term, present: haystack.includes(term.toLocaleLowerCase('de-DE')) }));
  return { total: items.length, matched: items.filter((item) => item.present).length, terms: items };
}

export function checkAtsHtml(html: string, options: { mustHave?: string[]; niceToHave?: string[]; now?: string } = {}): AtsCheckReport {
  if (typeof html !== 'string' || html.length < 1 || html.length > MAX_HTML) {
    throw Object.assign(new Error('ATS-Prüfung benötigt gültiges HTML unter 2 MB.'), { statusCode: 400 });
  }
  const signals = analyzeHtml(html);
  const lint = lintRules(signals);
  const parse = parseResume(signals);
  const summary = {
    pass: lint.filter((rule) => rule.status === 'pass').length,
    warn: lint.filter((rule) => rule.status === 'warn').length,
    fail: lint.filter((rule) => rule.status === 'fail').length,
    parseable: lint.every((rule) => rule.status !== 'fail') && parse.counts.sections > 0,
  };
  const coverage = (options.mustHave?.length || options.niceToHave?.length)
    ? { mustHave: coverageGroup(signals.text, options.mustHave ?? []), niceToHave: coverageGroup(signals.text, options.niceToHave ?? []) }
    : undefined;
  return {
    contract: 'ats-check', contractVersion: '1.0', engine: 'deterministic-local',
    checkedAt: options.now ?? new Date().toISOString(),
    htmlSha256: createHash('sha256').update(html).digest('hex'),
    summary, lint, parse, ...(coverage ? { coverage } : {}),
    disclaimer: 'Lokale, erklärbare ATS-Heuristik ohne erfundenen Score. Sie ersetzt keinen bestimmten Ziel-ATS.',
  };
}
