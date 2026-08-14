import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutableAllowlist, isPathWithin, WorkspaceRegistry } from './security-boundaries.js';

const cleanup: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-security-'));
  cleanup.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('path containment', () => {
  it('normalizes Windows case and rejects sibling-prefix and traversal paths', () => {
    expect(isPathWithin('C:\\Work\\Repo', 'c:\\work\\repo\\src\\a.ts', 'win32')).toBe(true);
    expect(isPathWithin('C:\\Work\\Repo', 'C:\\Work\\Repository\\a.ts', 'win32')).toBe(false);
    expect(isPathWithin('C:\\Work\\Repo', 'C:\\Work\\Repo\\..\\secret.txt', 'win32')).toBe(false);
    expect(isPathWithin('C:\\Work\\Repo', '\\Work\\Repo\\src\\a.ts', 'win32')).toBe(false);
    expect(isPathWithin('C:\\Work\\Repo', '\\\\?\\C:\\Work\\Repo\\src\\a.ts', 'win32')).toBe(false);
    expect(isPathWithin('\\\\server\\share\\Repo', '\\\\SERVER\\SHARE\\repo\\src\\a.ts', 'win32')).toBe(true);
    expect(isPathWithin('/work/repo', '/work/repo/src/a.ts', 'posix')).toBe(true);
    expect(isPathWithin('/work/repo', '/work/repository/a.ts', 'posix')).toBe(false);
  });
});

describe('WorkspaceRegistry', () => {
  it('canonicalizes the root and allows existing and future paths only within it', async () => {
    const root = await tempDirectory();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.txt'), 'safe');
    const registry = new WorkspaceRegistry();
    await registry.register({ id: 'repo', root, accessMode: 'read_write' });
    const canonicalRoot = await realpath(root);
    expect(await registry.resolvePath('repo', 'src/a.txt')).toBe(await realpath(join(root, 'src', 'a.txt')));
    expect(await registry.resolvePath('repo', 'new/file.txt', 'read_write', false)).toBe(resolve(canonicalRoot, 'new', 'file.txt'));
    await expect(registry.resolvePath('repo', '../secret.txt', 'read_only', false)).rejects.toThrow('workspace_path_escape');
    await expect(registry.resolvePath('repo', 'C:\\Windows\\System32')).rejects.toThrow('workspace_path_must_be_relative');
  });

  it('rejects symlink/junction escape after realpath canonicalization', async () => {
    const parent = await tempDirectory();
    const root = join(parent, 'root');
    const outside = join(parent, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const registry = new WorkspaceRegistry();
    await registry.register({ id: 'repo', root, accessMode: 'read_only' });
    await expect(registry.resolvePath('repo', 'escape/secret.txt')).rejects.toThrow('workspace_path_escape');
    await expect(registry.resolvePath('repo', 'new.txt', 'read_write', false)).rejects.toThrow('workspace_write_not_allowed');
  });
});

describe('ExecutableAllowlist', () => {
  it('builds argv from typed slots without shell interpolation', async () => {
    const root = await tempDirectory();
    await writeFile(join(root, 'prompt.txt'), 'hello');
    const registry = new WorkspaceRegistry();
    await registry.register({ id: 'repo', root, accessMode: 'read_only' });
    const allowlist = new ExecutableAllowlist(registry);
    await allowlist.register({
      providerId: 'node', runtimeTarget: process.platform === 'win32' ? 'windows' : 'wsl', executablePath: process.execPath,
      argumentTemplate: [
        { type: 'literal', value: '--version' },
        { type: 'slot', name: 'mode', kind: 'enum', values: ['safe'] },
        { type: 'slot', name: 'prompt', kind: 'workspace_path' },
      ],
      workspaceIds: ['repo'], sandboxProfiles: ['read_only_offline'],
    });
    const launch = await allowlist.resolveLaunch({
      providerId: 'node', runtimeTarget: process.platform === 'win32' ? 'windows' : 'wsl', workspaceId: 'repo',
      sandboxProfile: 'read_only_offline', slots: { mode: 'safe', prompt: 'prompt.txt' },
    });
    const canonicalRoot = await realpath(root);
    expect(launch).toMatchObject({ executable: process.execPath, shell: false, cwd: canonicalRoot });
    expect(launch.argv).toEqual(['--version', 'safe', await realpath(join(root, 'prompt.txt'))]);
  });

  it('rejects browser-selected executables, undeclared slots and option injection', async () => {
    const root = await tempDirectory();
    const registry = new WorkspaceRegistry();
    await registry.register({ id: 'repo', root, accessMode: 'read_only' });
    const allowlist = new ExecutableAllowlist(registry);
    await allowlist.register({
      providerId: 'node', runtimeTarget: 'windows', executablePath: process.execPath,
      argumentTemplate: [{ type: 'slot', name: 'mode', kind: 'identifier' }],
      workspaceIds: ['repo'], sandboxProfiles: ['read_only_offline'],
    });
    await expect(allowlist.resolveLaunch({ providerId: 'evil', runtimeTarget: 'windows', workspaceId: 'repo', sandboxProfile: 'read_only_offline', slots: {} }))
      .rejects.toThrow('executable_not_allowlisted');
    await expect(allowlist.resolveLaunch({ providerId: 'node', runtimeTarget: 'windows', workspaceId: 'repo', sandboxProfile: 'read_only_offline', slots: { mode: 'safe', executable: 'evil.exe' } }))
      .rejects.toThrow('undeclared_argument_slot');
    await expect(allowlist.resolveLaunch({ providerId: 'node', runtimeTarget: 'windows', workspaceId: 'repo', sandboxProfile: 'read_only_offline', slots: { mode: '--require=evil' } }))
      .rejects.toThrow('option_injection');
  });
});
