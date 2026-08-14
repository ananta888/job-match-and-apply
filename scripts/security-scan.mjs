import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.angular', '.venv', '.venv-wsl', '__pycache__', 'build', 'coverage', 'dist', 'node_modules', 'venv'
]);
const RUNTIME_DIRECTORIES = new Set(['.application-work', '.local-data']);
const SOURCE_EXTENSIONS = new Set([
  '.cjs', '.css', '.graphql', '.html', '.ini', '.js', '.json', '.jsx', '.md', '.mjs', '.py', '.scss',
  '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml'
]);
const SOURCE_FILENAMES = new Set([
  '.dockerignore', '.editorconfig', '.env', '.env.example', '.gitattributes', '.gitignore',
  'agents.md', 'dockerfile', 'makefile'
]);
const MAX_SCANNED_FILE_BYTES = 5 * 1024 * 1024;

const SECRET_PATTERNS = [
  { id: 'private-key', expression: /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/ },
  { id: 'github-token', expression: /(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/ },
  { id: 'aws-access-key', expression: /AKIA[0-9A-Z]{16}/ },
  { id: 'openai-api-key', expression: /\bsk-(?!ant-|test-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'anthropic-api-key', expression: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'agent-auth-environment', expression: /(?:OPENAI|CODEX|ANTHROPIC)_API_KEY\s*=\s*["']?[^\s<{$][^\s"']{8,}/ }
];
const RUNTIME_CANARY_PATTERNS = [
  { id: 'plaintext-canary', expression: /\b(?:AGENT|RUNTIME|SECRET|SECURITY)[_-]CANARY[_:-][A-Za-z0-9_-]{6,}\b/i }
];

function portablePath(path) { return path.split(sep).join('/'); }

function isExcludedDirectory(name) { return EXCLUDED_DIRECTORIES.has(name.toLowerCase()); }

function isRelevantSourceFile(name) {
  const lower = name.toLowerCase();
  return SOURCE_FILENAMES.has(lower) || lower.startsWith('.env.') || SOURCE_EXTENSIONS.has(extname(lower));
}

function readTextFile(path) {
  try {
    if (statSync(path).size > MAX_SCANNED_FILE_BYTES) return undefined;
    const value = readFileSync(path);
    if (value.includes(0)) return undefined;
    return value.toString('utf8');
  } catch { return undefined; }
}

function walkFiles(root, { runtimeOnly = false } = {}) {
  const files = [];
  const visit = (directory, inRuntimeDirectory) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (isExcludedDirectory(entry.name)) continue;
        const nextRuntime = inRuntimeDirectory || RUNTIME_DIRECTORIES.has(entry.name.toLowerCase());
        if (!runtimeOnly || nextRuntime || directory === root) visit(absolute, nextRuntime);
        continue;
      }
      if (!entry.isFile()) continue;
      if (runtimeOnly ? inRuntimeDirectory : !inRuntimeDirectory && isRelevantSourceFile(entry.name)) files.push(absolute);
    }
  };
  visit(root, false);
  return files;
}

function matches(content, patterns, file, scope, findings) {
  for (const pattern of patterns) {
    if (pattern.expression.test(content)) findings.push({ file, rule: pattern.id, scope });
  }
}

function matchesRuntimeFile(path, patterns, file, findings) {
  let descriptor;
  try { descriptor = openSync(path, 'r'); } catch { return; }
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const matchedRules = new Set();
  let carry = '';
  let firstChunk = true;
  try {
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      if (firstChunk && chunk.includes(0)) return;
      firstChunk = false;
      const content = carry + chunk.toString('utf8');
      for (const pattern of patterns) {
        if (!matchedRules.has(pattern.id) && pattern.expression.test(content)) matchedRules.add(pattern.id);
      }
      carry = content.slice(-8192);
    }
  } finally { closeSync(descriptor); }
  for (const rule of matchedRules) findings.push({ file, rule, scope: 'runtime' });
}

function trackedFiles(root) {
  const listed = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', windowsHide: true });
  if (listed.status !== 0) throw new Error(listed.stderr || 'git ls-files failed');
  return listed.stdout.split('\0').filter(Boolean).map(portablePath);
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function scanRepository(rootDirectory, options = {}) {
  const root = resolve(rootDirectory);
  const findings = [];
  const tracked = options.trackedFiles ?? trackedFiles(root);
  for (const file of tracked) {
    const firstSegment = file.split('/')[0]?.toLowerCase();
    if (firstSegment && RUNTIME_DIRECTORIES.has(firstSegment)) {
      findings.push({ file, rule: 'private-runtime-path', scope: 'tracked-path' });
    }
  }

  for (const absolute of walkFiles(root)) {
    const content = readTextFile(absolute);
    if (content === undefined) continue;
    matches(content, SECRET_PATTERNS, portablePath(relative(root, absolute)), 'source', findings);
  }

  const runtimePatterns = [...SECRET_PATTERNS, ...RUNTIME_CANARY_PATTERNS];
  if (options.canary) {
    runtimePatterns.push({ id: 'plaintext-canary', expression: new RegExp(escapeRegExp(options.canary)) });
  }
  for (const absolute of walkFiles(root, { runtimeOnly: true })) {
    matchesRuntimeFile(absolute, runtimePatterns, portablePath(relative(root, absolute)), findings);
  }

  return [...new Map(findings.map((finding) => [`${finding.file}\0${finding.rule}\0${finding.scope}`, finding])).values()];
}

export function runSecurityScan(root = process.cwd(), environment = process.env) {
  const findings = scanRepository(root, { canary: environment.SECURITY_SCAN_CANARY });
  if (findings.length) {
    console.error(JSON.stringify({ findings }, null, 2));
    return 1;
  }
  console.log('Security scan passed: source files (including untracked) and ignored runtime data contain no recognized plaintext secrets or canaries.');
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = runSecurityScan();
