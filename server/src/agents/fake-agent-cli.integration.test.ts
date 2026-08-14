import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessSupervisor } from './process-supervisor.js';

const roots: string[] = [];
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent-cli.mjs');
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function permissionBoundArgs(cwd: string, mode: string, outside?: string): string[] {
  return [
    '--permission',
    `--allow-fs-read=${dirname(fixture)}`,
    `--allow-fs-write=${cwd}`,
    fixture,
    mode,
    ...(outside ? [outside] : []),
  ];
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-fake-cli-'));
  roots.push(root);
  return root;
}

describe('versioned fake agent CLI processes', () => {
  it.each([
    ['normal', 'exit', 0],
    ['slow', 'exit', 0],
    ['crash', 'crash', 23],
  ] as const)('covers %s mode without credentials or external services', async (mode, termination, exitCode) => {
    const cwd = await workspace();
    const result = await new ProcessSupervisor().start({
      executable: process.execPath, args: permissionBoundArgs(cwd, mode), cwd,
      env: { PATH: process.env.PATH ?? '' }, limits: { wallTimeMs: 2_000, idleTimeMs: 1_000, cancelGraceMs: 100 },
    }).completion;
    expect(result).toMatchObject({ termination, exitCode });
  });

  it('supports bounded stdin and keeps adversarial fixture writes inside its canonical temporary workspace', async () => {
    const interactiveRoot = await workspace();
    const interactive = new ProcessSupervisor().start({
      executable: process.execPath, args: permissionBoundArgs(interactiveRoot, 'interactive'), cwd: interactiveRoot,
      env: { PATH: process.env.PATH ?? '' }, limits: { maxInputBytes: 64, wallTimeMs: 2_000, idleTimeMs: 1_000 },
    });
    await interactive.writeInput('synthetic answer', true);
    expect(await interactive.completion).toMatchObject({ termination: 'exit', stdout: expect.stringContaining('received') });

    const maliciousRoot = await workspace();
    const outside = resolve(maliciousRoot, '..', `outside-${Date.now()}.txt`);
    const malicious = await new ProcessSupervisor().start({
      executable: process.execPath, args: permissionBoundArgs(maliciousRoot, 'malicious-output', outside), cwd: maliciousRoot,
      env: { PATH: process.env.PATH ?? '' }, limits: { wallTimeMs: 2_000, idleTimeMs: 1_000 },
    }).completion;
    expect(malicious.termination).toBe('exit');
    expect(malicious.stdout).toContain('filesystem.write_denied');
    expect(await readFile(join(maliciousRoot, 'synthetic-malicious-output.txt'), 'utf8')).toContain('ignore');
    await expect(access(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
