import { Parser } from 'htmlparser2';

const MAX_PACKAGE_FIELD_LENGTH = 200_000;
const HASH = /^[a-f0-9]{64}$/;
const EVIDENCE_ANNOTATION = /<!--\s*evidence:[\s\S]*?-->/gi;
const HTML_FENCE = /^\s*```html\s*([\s\S]*?)\s*```\s*$/i;
const ALLOWED_TAGS = new Set([
  'article', 'aside', 'blockquote', 'br', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'footer', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'small', 'span', 'strong',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const VOID_TAGS = new Set(['br', 'hr']);
const BLOCKED_CONTENT_TAGS = new Set([
  'audio', 'base', 'button', 'canvas', 'embed', 'form', 'iframe', 'img', 'input', 'link', 'math', 'meta',
  'noscript', 'object', 'option', 'script', 'select', 'source', 'style', 'svg', 'template', 'textarea', 'video',
]);

export interface ApplicationPipelinePackage {
  annotatedContent: string;
  iterationManifest: string;
}

export interface ApplicationPipelineHtmlContext {
  artifactSha256: string;
  identityMode: 'real' | 'incognito';
  artifactLifecycle: 'proposed' | 'approved' | 'used' | 'rejected';
}

export interface ApplicationFinalHtmlContext {
  identityMode: 'real' | 'incognito';
}

/**
 * Reads the closed JSON contract emitted by legacy workflow 1.0 runs. Current
 * workflow 1.1 runs use normalizeApplicationFinalHtml instead.
 */
export function parseApplicationPipelinePackage(content: string): ApplicationPipelinePackage {
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { throw new Error('application_pipeline_package_json_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('application_pipeline_package_contract_invalid');
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'annotatedContent') || !Object.hasOwn(value, 'iterationManifest')
    || typeof value.annotatedContent !== 'string' || !value.annotatedContent.trim()
    || value.annotatedContent.length > MAX_PACKAGE_FIELD_LENGTH
    || typeof value.iterationManifest !== 'string' || !value.iterationManifest.trim()
    || value.iterationManifest.length > MAX_PACKAGE_FIELD_LENGTH) {
    throw new Error('application_pipeline_package_contract_invalid');
  }
  return { annotatedContent: value.annotatedContent, iterationManifest: value.iterationManifest };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function safeTableAttributes(name: string, attributes: Record<string, string>): string {
  const values: string[] = [];
  if (name === 'td' || name === 'th') {
    for (const attribute of ['colspan', 'rowspan'] as const) {
      const value = attributes[attribute];
      if (value && /^(?:[1-9]|1[0-9]|20)$/.test(value)) values.push(`${attribute}="${value}"`);
    }
  }
  if (name === 'th' && ['row', 'col', 'rowgroup', 'colgroup'].includes(attributes.scope ?? '')) {
    values.push(`scope="${attributes.scope}"`);
  }
  return values.length ? ` ${values.join(' ')}` : '';
}

/**
 * Turns the fifth agent's complete HTML document into the immutable,
 * script-free page that is stored and displayed. Model-controlled scripts,
 * styles, navigation, forms and remote resources never survive this boundary.
 */
export function normalizeApplicationFinalHtml(input: string, context: ApplicationFinalHtmlContext): string {
  if (input.length > MAX_PACKAGE_FIELD_LENGTH) throw new Error('application_final_html_too_large');
  const fenced = HTML_FENCE.exec(input);
  const source = (fenced?.[1] ?? input).trim();
  if (!/^<!doctype\s+html(?:\s[^>]*)?>/i.test(source)
    || !/<html(?:\s[^>]*)?>/i.test(source) || !/<body(?:\s[^>]*)?>/i.test(source)) {
    throw new Error('application_final_html_document_required');
  }

  const body: string[] = [];
  const openTags: string[] = [];
  let inBody = false;
  let inTitle = false;
  let blockedDepth = 0;
  let title = '';
  let visibleText = '';
  let parseFailure: Error | undefined;
  const closeThrough = (name: string) => {
    const index = openTags.lastIndexOf(name);
    if (index < 0) return;
    while (openTags.length > index) body.push(`</${openTags.pop()!}>`);
  };
  const parser = new Parser({
    onopentag(name, attributes) {
      if (blockedDepth > 0) { blockedDepth += 1; return; }
      if (name === 'title' && !inBody) { inTitle = true; return; }
      if (name === 'body') { inBody = true; return; }
      if (!inBody) return;
      if (BLOCKED_CONTENT_TAGS.has(name)) { blockedDepth = 1; return; }
      if (!ALLOWED_TAGS.has(name)) return;
      body.push(`<${name}${safeTableAttributes(name, attributes)}>`);
      if (!VOID_TAGS.has(name)) openTags.push(name);
    },
    ontext(text) {
      if (inTitle) title += text;
      if (!inBody || blockedDepth > 0) return;
      body.push(escapeHtml(text));
      visibleText += text;
    },
    onclosetag(name) {
      if (blockedDepth > 0) { blockedDepth -= 1; return; }
      if (name === 'title') { inTitle = false; return; }
      if (name === 'body') {
        while (openTags.length) body.push(`</${openTags.pop()!}>`);
        inBody = false;
        return;
      }
      if (inBody && ALLOWED_TAGS.has(name) && !VOID_TAGS.has(name)) closeThrough(name);
    },
    onerror(error) { parseFailure = error; },
  }, { decodeEntities: true, lowerCaseAttributeNames: true, lowerCaseTags: true, recognizeSelfClosing: true });
  parser.end(source);
  if (parseFailure || !visibleText.trim()) throw new Error('application_final_html_content_invalid');

  const safeTitle = title.trim().slice(0, 160) || 'Finale Bewerbungsfassung';
  const identityNote = context.identityMode === 'incognito'
    ? 'Inkognito-Fassung – nicht für eine echte Bewerbung verwenden.'
    : 'Fertige Fassung des fünften Agenten – noch nicht versendet.';
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(safeTitle)}</title>
  <style>
    :root{color-scheme:light;font-family:Arial,Helvetica,sans-serif;color:#17213a;background:#eef1f6}
    *{box-sizing:border-box}body{margin:0;padding:24px}.document-shell{max-width:900px;margin:auto;background:#fff;border:1px solid #dfe3ea;border-radius:14px;box-shadow:0 14px 40px #17213a16;overflow:hidden}
    .result-head{padding:16px 24px;background:#e8f7f0;border-bottom:1px solid #b9e4d1;color:#20583f}.result-head strong,.result-head small{display:block}.result-head strong{font-size:14px}.result-head small{margin-top:5px;font-size:11px;line-height:1.5}
    .agent-document{padding:34px 38px 42px}.agent-document h1{margin:0 0 24px;font-size:30px;line-height:1.15}.agent-document h2{margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid #6855e7;font-size:18px}.agent-document h3{margin:20px 0 8px;font-size:15px}.agent-document p,.agent-document li,.agent-document dd,.agent-document dt,.agent-document td,.agent-document th{font-size:14px;line-height:1.65}.agent-document ul,.agent-document ol{padding-left:24px}.agent-document li+li{margin-top:6px}.agent-document pre,.agent-document code{border-radius:4px;background:#f1f3f7;font-family:Consolas,monospace}.agent-document code{padding:2px 5px;font-size:.92em}.agent-document pre{padding:12px;white-space:pre-wrap}.agent-document table{width:100%;border-collapse:collapse}.agent-document th,.agent-document td{padding:8px;border:1px solid #dfe3ea;text-align:left}
    @media(max-width:600px){body{padding:0}.document-shell{border:0;border-radius:0}.agent-document{padding:25px 20px}.agent-document h1{font-size:25px}}
    @media print{body{padding:0;background:#fff}.document-shell{border:0;box-shadow:none}.result-head{display:none}}
  </style>
</head>
<body data-result="final-agent-html" data-identity-mode="${context.identityMode}">
  <div class="document-shell">
    <header class="result-head"><strong>Fünfter Agent abgeschlossen · finale HTML-Version</strong><small>${escapeHtml(identityNote)}</small></header>
    <article class="agent-document">${body.join('')}</article>
  </div>
</body>
</html>`;
}

function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function documentHtml(content: string): { title: string; body: string } {
  const lines = content.replace(EVIDENCE_ANNOTATION, '').replace(/\r/g, '').split('\n');
  const blocks: string[] = [];
  let list: 'ul' | 'ol' | undefined;
  let title = 'Finale Bewerbungsfassung';

  const closeList = () => {
    if (!list) return;
    blocks.push(`</${list}>`);
    list = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { closeList(); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      if (level === 1 && title === 'Finale Bewerbungsfassung') title = text.replace(/[*`]/g, '');
      blocks.push(`<h${level}>${inlineMarkdown(text)}</h${level}>`);
      continue;
    }
    const unordered = /^[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const nextList = unordered ? 'ul' : 'ol';
      if (list !== nextList) { closeList(); list = nextList; blocks.push(`<${list}>`); }
      blocks.push(`<li>${inlineMarkdown((unordered ?? ordered)![1]!)}</li>`);
      continue;
    }
    closeList();
    if (/^([-*_])\1{2,}$/.test(line)) blocks.push('<hr>');
    else blocks.push(`<p>${inlineMarkdown(line.replace(/^>\s?/, ''))}</p>`);
  }
  closeList();
  return { title, body: blocks.join('\n') };
}

/**
 * Produces a complete, script-free HTML page for the fifth agent's final
 * document. All model text is escaped before the small Markdown subset is
 * projected into controlled markup.
 */
export function renderApplicationPipelinePackageHtml(
  value: ApplicationPipelinePackage,
  context: ApplicationPipelineHtmlContext,
): string {
  if (!HASH.test(context.artifactSha256)) throw new Error('application_result_html_hash_invalid');
  const document = documentHtml(value.annotatedContent);
  const identityNote = context.identityMode === 'incognito'
    ? 'Inkognito-Fassung – nicht für eine echte Bewerbung verwenden.'
    : 'Finale Fassung des fünften Agenten – noch nicht versendet.';
  const state = {
    proposed: 'Agentenlauf abgeschlossen', approved: 'Agentenfassung bestätigt',
    used: 'Agentenfassung übernommen', rejected: 'Agentenfassung abgelehnt',
  }[context.artifactLifecycle];
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(document.title)}</title>
  <style>
    :root{color-scheme:light;font-family:Arial,Helvetica,sans-serif;color:#17213a;background:#eef1f6}
    *{box-sizing:border-box}body{margin:0;padding:24px}main{max-width:850px;margin:auto;background:#fff;border:1px solid #dfe3ea;border-radius:14px;box-shadow:0 14px 40px #17213a16;overflow:hidden}
    .result-head{padding:16px 22px;background:#eeebff;border-bottom:1px solid #d9d3ff;color:#3f338f}.result-head strong,.result-head small{display:block}.result-head strong{font-size:14px}.result-head small{margin-top:5px;font-size:11px;line-height:1.5}
    article{padding:30px 34px 38px}h1{margin:0 0 24px;color:#17213a;font-size:30px;line-height:1.15}h2{margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid #6855e7;color:#29334a;font-size:18px}h3{margin:20px 0 8px;font-size:15px}p,li{font-size:14px;line-height:1.65}p{white-space:pre-wrap}ul,ol{padding-left:24px}li+li{margin-top:6px}code{padding:2px 5px;border-radius:4px;background:#f1f3f7;font-family:Consolas,monospace;font-size:.92em}hr{border:0;border-top:1px solid #dfe3ea;margin:24px 0}
    footer{padding:12px 22px;border-top:1px solid #e6e9ef;color:#667085;background:#fafbfc;font-size:10px;overflow-wrap:anywhere}
    @media(max-width:600px){body{padding:0}main{border:0;border-radius:0}article{padding:24px 20px}h1{font-size:25px}}
    @media print{body{padding:0;background:#fff}main{border:0;box-shadow:none}.result-head,footer{display:none}}
  </style>
</head>
<body data-result="final-agent-html" data-identity-mode="${context.identityMode}">
  <main>
    <header class="result-head"><strong>Direkte HTML-Sofortansicht · ${escapeHtml(state)}</strong><small>${escapeHtml(identityNote)}</small></header>
    <article>${document.body}</article>
    <footer>Ergebnis-SHA-256: ${context.artifactSha256}</footer>
  </main>
</body>
</html>`;
}
