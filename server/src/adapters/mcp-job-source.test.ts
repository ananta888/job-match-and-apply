import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../domain/models.js';
import { assertTrustedHostMcpLaunch, buildTrustedHostMcpEnvironment, inspectTrustedHostMcpRuntime, normalizeMcpJob } from './mcp-job-source.js';

const native: AppConfig['mcp'] = {
  mode: 'stdio', executionIsolation: 'trusted-host',
  command: 'C:\\workspace\\.venv\\Scripts\\job-search-mcp.exe', args: [], env: {}
};

describe('job-search MCP process boundary', () => {
  it('preserves the published nested source reference instead of inventing provenance', () => {
    const job = normalizeMcpJob({
      id: 'synthetic-1', titel: 'Synthetic Engineer', unternehmen: 'Example Invalid GmbH',
      url: 'https://example.invalid/jobs/offline-1', fetched_at: '2026-01-01T00:00:00Z',
      source_reference: {
        source_id: 'synthetic-feed', external_id: 'offline-1',
        url: 'https://example.invalid/jobs/offline-1', fetched_at: '2026-01-01T00:00:00Z'
      },
      normalization_warnings: []
    }, 0);
    expect(job).toMatchObject({
      id: 'synthetic-1', sourceId: 'synthetic-feed', company: 'Example Invalid GmbH',
      url: 'https://example.invalid/jobs/offline-1',
      sourceReferences: [{
        sourceId: 'synthetic-feed', externalId: 'offline-1',
        url: 'https://example.invalid/jobs/offline-1', fetchedAt: '2026-01-01T00:00:00Z'
      }]
    });
  });

  it('passes only host basics and explicit upstream settings, never unrelated server secrets', () => {
    const environment = buildTrustedHostMcpEnvironment(
      { ALLOW_EXTERNAL_PORTALS: '1', JOB_MCP_STATE_DIR: '/safe/state' },
      { PATH: '/usr/bin', TEMP: '/tmp', ROOT_APP_SECRET: 'must-not-cross-boundary' }
    );
    expect(environment).toEqual({ PATH: '/usr/bin', TEMP: '/tmp', ALLOW_EXTERNAL_PORTALS: '1', JOB_MCP_STATE_DIR: '/safe/state' });
    expect(environment).not.toHaveProperty('ROOT_APP_SECRET');
  });

  it('accepts direct native and direct WSL trusted-host launches', () => {
    expect(() => assertTrustedHostMcpLaunch(native)).not.toThrow();
    expect(() => assertTrustedHostMcpLaunch({
      ...native, command: 'C:\\Windows\\System32\\wsl.exe',
      args: ['-d', 'Ubuntu', '--', 'env', 'ALLOW_EXTERNAL_PORTALS=1', 'JOB_MCP_STATE_DIR=/mnt/c/state', '/mnt/c/repo/.venv-wsl/bin/job-search-mcp']
    })).not.toThrow();
  });

  it.each(['bwrap', 'unshare', 'docker', 'podman', 'firejail'])('rejects the %s sandbox wrapper', (wrapper) => {
    expect(() => assertTrustedHostMcpLaunch({ ...native, command: `C:\\tools\\${wrapper}.exe` }))
      .toThrow('sandbox_wrapper_forbidden');
    expect(() => assertTrustedHostMcpLaunch({
      ...native, command: 'C:\\Windows\\System32\\wsl.exe',
      args: ['-d', 'Ubuntu', '--', wrapper, '/mnt/c/repo/.venv-wsl/bin/job-search-mcp']
    })).toThrow('sandbox_wrapper_forbidden');
  });

  it('rejects a shell-mediated or non-trusted launch contract', () => {
    expect(() => assertTrustedHostMcpLaunch({ ...native, command: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu', '--', 'bash', '-lc', 'job-search-mcp'] }))
      .toThrow('wsl_launch_invalid');
    expect(() => assertTrustedHostMcpLaunch({ ...native, executionIsolation: 'sandbox' as never }))
      .toThrow('requires_trusted_host');
  });

  it('binds runtimeTarget and distribution to the direct argv', () => {
    expect(() => assertTrustedHostMcpLaunch({ ...native, runtimeTarget: 'wsl' }))
      .toThrow('wsl_launch_invalid');
    expect(() => assertTrustedHostMcpLaunch({
      ...native, runtimeTarget: 'wsl', distribution: 'Debian', command: 'C:\\Windows\\System32\\wsl.exe',
      args: ['-d', 'Ubuntu', '--', '/mnt/c/repo/.venv-wsl/bin/job-search-mcp']
    })).toThrow('wsl_launch_invalid');
  });

  it('accepts only the canonical native executable below the integration venv', async () => {
    const projectRoot = 'C:\\repo';
    const expected = 'C:\\repo\\integrations\\job-search-mcp\\.venv\\Scripts\\job-search-mcp.exe';
    const settings = { ...native, runtimeTarget: 'windows' as const, command: expected };
    const ready = await inspectTrustedHostMcpRuntime(settings, projectRoot, {
      projectRoot, realpath: async (path) => path, access: async () => undefined
    });
    expect(ready).toMatchObject({ state: 'ready_to_connect', launchValidated: true, connected: false, runtimeTarget: 'windows' });

    const escaped = await inspectTrustedHostMcpRuntime(settings, projectRoot, {
      projectRoot,
      realpath: async (path) => path === expected ? 'C:\\outside\\job-search-mcp.exe' : path,
      access: async () => undefined
    });
    expect(escaped).toMatchObject({ state: 'invalid', launchValidated: false, connected: false });
    expect(escaped.note).toContain('outside_allowed_venv');
  });

  it('pins WSL.exe and rejects a WSL target whose realpath escapes the integration venv', async () => {
    const projectRoot = 'C:\\repo';
    const command = 'C:\\Windows\\System32\\wsl.exe';
    const target = '/mnt/c/repo/integrations/job-search-mcp/.venv-wsl/bin/job-search-mcp';
    const settings: AppConfig['mcp'] = {
      ...native, runtimeTarget: 'wsl', distribution: 'Ubuntu', command,
      args: ['-d', 'Ubuntu', '--', target]
    };
    const runWsl = async (_command: string, _distribution: string, args: string[]): Promise<string> => {
      if (args[0] === 'wslpath') return '/mnt/c/repo/integrations/job-search-mcp';
      if (args[0] === 'readlink' && args.at(-1)?.endsWith('.venv-wsl')) return '/mnt/c/repo/integrations/job-search-mcp/.venv-wsl';
      if (args[0] === 'readlink') return target;
      return '';
    };
    const ready = await inspectTrustedHostMcpRuntime(settings, projectRoot, {
      projectRoot, allowedWslCommand: command, realpath: async (path) => path,
      access: async () => undefined, runWsl
    });
    expect(ready).toMatchObject({ state: 'ready_to_connect', runtimeTarget: 'wsl', distribution: 'Ubuntu' });

    const escaped = await inspectTrustedHostMcpRuntime(settings, projectRoot, {
      projectRoot, allowedWslCommand: command, realpath: async (path) => path,
      access: async () => undefined,
      runWsl: async (wsl, distribution, args) => args[0] === 'readlink' && args.at(-1) === target
        ? '/tmp/job-search-mcp' : runWsl(wsl, distribution, args)
    });
    expect(escaped.state).toBe('invalid');
    expect(escaped.note).toContain('outside_allowed_venv');
  });
});
