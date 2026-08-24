import { describe, expect, it } from 'vitest';
import {
  normalizeApplicationFinalHtml,
  parseApplicationPipelinePackage,
  renderApplicationPipelinePackageHtml,
} from './application-result-html.js';

describe('application pipeline HTML result', () => {
  it('normalizes the fifth agent HTML directly and removes active or remote content', () => {
    const html = normalizeApplicationFinalHtml(`<!doctype html>
      <html><head><title>Direkter Lebenslauf</title><style>body{display:none}</style></head>
      <body onload="steal()"><h1>Erika Beispiel</h1><script>alert('x')</script>
      <p>Belegte Erfahrung</p><a href="https://example.invalid/leak">Kontakt</a>
      <table><tr><th scope="col" onclick="steal()">Rolle</th><td colspan="2">Engineer</td></tr></table></body></html>`, {
      identityMode: 'real',
    });

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('data-result="final-agent-html"');
    expect(html).toContain('<title>Direkter Lebenslauf</title>');
    expect(html).toContain('<h1>Erika Beispiel</h1>');
    expect(html).toContain('<th scope="col">Rolle</th>');
    expect(html).toContain('<td colspan="2">Engineer</td>');
    expect(html).not.toContain("alert('x')");
    expect(html).not.toContain('example.invalid');
    expect(html).not.toContain('onload');
    expect(html).not.toContain('onclick');
  });

  it('parses only the closed finalizer package contract', () => {
    expect(parseApplicationPipelinePackage(JSON.stringify({
      annotatedContent: '# Anschreiben\n\nBelegter Inhalt.',
      iterationManifest: 'schema_version: 1\n',
    }))).toEqual({
      annotatedContent: '# Anschreiben\n\nBelegter Inhalt.',
      iterationManifest: 'schema_version: 1\n',
    });

    expect(() => parseApplicationPipelinePackage(JSON.stringify({
      annotatedContent: '# Anschreiben', iterationManifest: 'schema_version: 1', approved: true,
    }))).toThrow('application_pipeline_package_contract_invalid');
  });

  it('always returns a self-contained escaped HTML page without internal evidence annotations', () => {
    const html = renderApplicationPipelinePackageHtml({
      annotatedContent: [
        '# Bewerbung <script>alert(1)</script>',
        '',
        '## Profil',
        '- Belegte Erfahrung <!-- evidence: claim-role -->',
        '- **Klare Wirkung**',
      ].join('\n'),
      iterationManifest: 'PRIVATE_INTERNAL_MANIFEST',
    }, {
      artifactSha256: 'a'.repeat(64), identityMode: 'real', artifactLifecycle: 'proposed',
    });

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('Direkte HTML-Sofortansicht');
    expect(html).toContain('<h2>Profil</h2>');
    expect(html).toContain('<li>Belegte Erfahrung</li>');
    expect(html).toContain('<strong>Klare Wirkung</strong>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('evidence:');
    expect(html).not.toContain('PRIVATE_INTERNAL_MANIFEST');
  });
});
