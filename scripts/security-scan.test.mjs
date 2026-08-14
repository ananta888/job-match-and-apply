import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { afterEach } from 'node:test';
import { scanRepository } from './security-scan.mjs';

const fixtures = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'job-match-security-scan-'));
  fixtures.push(root);
  return root;
}
afterEach(() => {
  const safePrefix = `${resolve(tmpdir(), 'job-match-security-scan-')}`;
  for (const root of fixtures.splice(0)) {
    assert.ok(resolve(root).startsWith(safePrefix));
    rmSync(root, { recursive: true });
  }
});
function write(root, path, content) {
  const target = join(root, ...path.split('/'));
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

test('scans relevant untracked source files', () => {
  const root = fixture();
  write(root, 'server/src/untracked.ts', `export const leaked = '${'ghp_' + 'A'.repeat(24)}';`);
  assert.deepEqual(scanRepository(root, { trackedFiles: [] }), [
    { file: 'server/src/untracked.ts', rule: 'github-token', scope: 'source' }
  ]);
});

test('does not treat an explicit sk-test fixture as a production OpenAI key', () => {
  const root = fixture();
  write(root, 'server/src/security.test.ts', `const canary = '${'sk-' + 'test-' + 'DO-NOT-LEAK-123456'}';`);
  assert.deepEqual(scanRepository(root, { trackedFiles: [] }), []);
});

test('does not scan .git, node_modules, or dist directories', () => {
  const root = fixture();
  const secret = 'AKIA' + 'A'.repeat(16);
  write(root, '.git/config.json', secret);
  write(root, 'node_modules/package/index.js', secret);
  write(root, 'server/dist/index.js', secret);
  assert.deepEqual(scanRepository(root, { trackedFiles: [] }), []);
});

test('detects plaintext canaries and recognized secrets in ignored runtime data', () => {
  const root = fixture();
  write(root, '.local-data/agent-runs/run.json', JSON.stringify({ prompt: 'AGENT_' + 'CANARY_unit_123456', token: 'sk-ant-' + 'B'.repeat(24) }));
  assert.deepEqual(scanRepository(root, { trackedFiles: [] }), [
    { file: '.local-data/agent-runs/run.json', rule: 'anthropic-api-key', scope: 'runtime' },
    { file: '.local-data/agent-runs/run.json', rule: 'plaintext-canary', scope: 'runtime' }
  ]);
});

test('supports an exact runtime canary supplied by the caller', () => {
  const root = fixture();
  write(root, '.application-work/run.json', JSON.stringify({ prompt: 'opaque-test-marker-4815162342' }));
  assert.deepEqual(scanRepository(root, { trackedFiles: [], canary: 'opaque-test-marker-4815162342' }), [
    { file: '.application-work/run.json', rule: 'plaintext-canary', scope: 'runtime' }
  ]);
});

test('scans runtime logs larger than the source-file size limit', () => {
  const root = fixture();
  const canary = 'opaque-large-runtime-marker-123456';
  write(root, '.local-data/agent-runs/events.jsonl', `${'x'.repeat(5 * 1024 * 1024 + 1)}${canary}`);
  assert.deepEqual(scanRepository(root, { trackedFiles: [], canary }), [
    { file: '.local-data/agent-runs/events.jsonl', rule: 'plaintext-canary', scope: 'runtime' }
  ]);
});

test('does not report encrypted runtime values as plaintext', () => {
  const root = fixture();
  write(root, '.local-data/agent-runs/run.json', JSON.stringify({ task: 'agent-vault:v1:iv.tag.ciphertext' }));
  assert.deepEqual(scanRepository(root, { trackedFiles: [] }), []);
});

test('reports tracked private runtime paths independently of content', () => {
  const root = fixture();
  write(root, '.local-data/run.json', '{}');
  assert.deepEqual(scanRepository(root, { trackedFiles: ['.local-data/run.json'] }), [
    { file: '.local-data/run.json', rule: 'private-runtime-path', scope: 'tracked-path' }
  ]);
});
