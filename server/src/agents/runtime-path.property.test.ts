import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPathWithinRoot, validateWorkspaceRoot } from './runtime-discovery.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('cross-platform path containment properties', () => {
  it.each([
    ['windows case-folded descendant', 'C:\\WORK\\Root\\child', 'c:\\work\\root', 'windows', true],
    ['windows normalized descendant', 'C:\\work\\root\\a\\..\\child', 'C:\\work\\root', 'windows', true],
    ['windows sibling-prefix escape', 'C:\\work\\root-mutated', 'C:\\work\\root', 'windows', false],
    ['windows parent escape', 'C:\\work\\outside', 'C:\\work\\root', 'windows', false],
    ['windows different drive', 'D:\\work\\root', 'C:\\work\\root', 'windows', false],
    ['UNC case-folded descendant', '\\\\SERVER\\Share\\Root\\child', '\\\\server\\share\\root', 'windows', true],
    ['UNC different share', '\\\\server\\other\\root', '\\\\server\\share\\root', 'windows', false],
    ['windows root-relative request', '\\work\\root\\child', 'C:\\work\\root', 'windows', false],
    ['windows device namespace', '\\\\?\\C:\\work\\root\\child', 'C:\\work\\root', 'windows', false],
    ['windows device root', 'C:\\work\\root\\child', '\\\\?\\C:\\work\\root', 'windows', false],
    ['linux descendant', '/srv/work/root/child', '/srv/work/root', 'posix', true],
    ['linux dot normalization', '/srv/work/root/a/../child', '/srv/work/root', 'posix', true],
    ['linux case mutation', '/srv/work/Root/child', '/srv/work/root', 'posix', false],
    ['linux sibling-prefix escape', '/srv/work/root-mutated', '/srv/work/root', 'posix', false],
    ['relative request', '../root', '/srv/work/root', 'posix', false],
  ] as const)('%s', (_name, requested, allowed, flavor, accepted) => {
    expect(isPathWithinRoot(requested, allowed, flavor)).toBe(accepted);
  });

  it('resolves symlink/junction-like aliases before scope checks', async () => {
    const base = await mkdtemp(join(tmpdir(), 'path-property-')); roots.push(base);
    const allowed = join(base, 'allowed');
    const inside = join(allowed, 'inside');
    const outside = join(base, 'outside');
    await mkdir(inside, { recursive: true }); await mkdir(outside);
    const insideLink = join(allowed, 'inside-link');
    const outsideLink = join(allowed, 'outside-link');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      await symlink(inside, insideLink, linkType);
      await symlink(outside, outsideLink, linkType);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expect(validateWorkspaceRoot(insideLink, [allowed])).resolves.toBeTruthy();
    await expect(validateWorkspaceRoot(outsideLink, [allowed])).rejects.toThrow('außerhalb');
  });

  it('rejects an existing file as a workspace root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'path-file-property-')); roots.push(base);
    const file = join(base, 'not-a-directory');
    await writeFile(file, 'synthetic');
    await expect(validateWorkspaceRoot(file, [base])).rejects.toThrow('Verzeichnis');
  });
});
