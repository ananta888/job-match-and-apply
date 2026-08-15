import { describe, expect, it } from 'vitest';
import { checkAtsHtml } from './ats-check.js';

const atsCv = `<!doctype html><html lang="de"><head><meta charset="utf-8"></head>
  <body data-mode="ats"><main>
    <h1>Petra Muster</h1>
    <section><h2>Berufserfahrung</h2><ul><li>Softwareentwicklerin bei Beispiel GmbH 2020–heute</li><li>Angular und TypeScript im Team eingeführt</li></ul></section>
    <section><h2>Ausbildung</h2><ul><li>B.Sc. Informatik 2016–2020</li></ul></section>
    <section><h2>Kenntnisse</h2><ul><li>Angular, TypeScript, RxJS</li></ul></section>
    <p>Kontakt: petra@example.com · +49 30 1234567</p>
  </main></body></html>`;

const twoColumnCv = `<!doctype html><html lang="de"><body data-mode="original" data-columns="2"><main>
  <aside class="col-side"><h2>Profil</h2><ul><li>Kurzprofil</li></ul></aside>
  <table><tr><td>Layout</td></tr></table>
  <div class="col-main"><h1>Max Muster</h1><h2>Lieblingsfarbe</h2><ul><li>Blau</li></ul></div>
</main></body></html>`;

describe('checkAtsHtml — deterministic lint', () => {
  it('passes a clean single-column ATS CV', () => {
    const report = checkAtsHtml(atsCv);
    expect(report.contract).toBe('ats-check');
    expect(report.summary.fail).toBe(0);
    expect(report.summary.parseable).toBe(true);
    const byId = Object.fromEntries(report.lint.map((rule) => [rule.id, rule.status]));
    expect(byId['single-column']).toBe('pass');
    expect(byId['standard-headings']).toBe('pass');
    expect(byId['no-tables']).toBe('pass');
    expect(byId['selectable-text']).toBe('pass');
  });

  it('flags a two-column, table-based CV with non-standard headings', () => {
    const report = checkAtsHtml(twoColumnCv);
    const byId = Object.fromEntries(report.lint.map((rule) => [rule.id, rule.status]));
    expect(byId['single-column']).toBe('warn');
    expect(byId['no-tables']).toBe('fail');
    expect(byId['standard-headings']).toBe('warn');
    expect(report.summary.fail).toBeGreaterThan(0);
    expect(report.parse.warnings.some((warning) => /mehrspaltig/i.test(warning))).toBe(true);
  });
});

describe('checkAtsHtml — local parser round-trip', () => {
  it('recovers contact fields, sections and counts', () => {
    const report = checkAtsHtml(atsCv);
    expect(report.parse.parser).toBe('local-rule-based-ats-parser');
    expect(report.parse.recovered).toMatchObject({ name: 'Petra Muster', email: 'petra@example.com' });
    expect(report.parse.recovered.hasDateRanges).toBe(true);
    expect(report.parse.counts.experienceItems).toBe(2);
    expect(report.parse.counts.educationItems).toBe(1);
    expect(report.parse.counts.skills).toBe(3);
    const canonicals = report.parse.detectedSections.map((section) => section.canonical);
    expect(canonicals).toEqual(expect.arrayContaining(['employment', 'education', 'skill']));
  });
});

describe('checkAtsHtml — keyword coverage', () => {
  it('reports coverage as counts by priority without a score', () => {
    const report = checkAtsHtml(atsCv, { mustHave: ['Angular', 'Kubernetes'], niceToHave: ['RxJS'] });
    expect(report.coverage?.mustHave).toMatchObject({ total: 2, matched: 1 });
    expect(report.coverage?.niceToHave).toMatchObject({ total: 1, matched: 1 });
    expect(JSON.stringify(report)).not.toMatch(/"score"/);
  });

  it('rejects oversized or empty input', () => {
    expect(() => checkAtsHtml('')).toThrow();
    expect(() => checkAtsHtml('x'.repeat(2_000_001))).toThrow();
  });
});
