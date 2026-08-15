import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  assertOfflineMcpCapabilities,
  buildOfflineSmokeEnvironment,
  collectOfflineProbeProcess,
} from './job-search-mcp-smoke.mjs';

const tools = ['capabilities', 'browser_status', 'mehrportal_suche', 'portal_login', 'portal_sitzung_loeschen'];
const capabilityResult = {
  content: [{ type: 'text', text: JSON.stringify({
    contract: 'job-search-mcp', contract_version: '1.0',
    sources: [{
      id: 'stepstone', enabled: true, supports_login: true,
      login_required_for_search: false, policy_status: 'configured'
    }]
  }) }]
};

describe('offline trusted-host MCP smoke', () => {
  it('accepts the real StepStone/tool capability surface without invoking a portal tool', () => {
    expect(assertOfflineMcpCapabilities({ tools: tools.map((name) => ({ name })) }, capabilityResult)).toMatchObject({
      contract: 'job-search-mcp', contractVersion: '1.0',
      stepStone: { enabled: true, supportsLogin: true }
    });
  });

  it('requires portal networking off and does not inherit unrelated secrets', () => {
    const environment = buildOfflineSmokeEnvironment(
      { ALLOW_EXTERNAL_PORTALS: '0', JOB_MCP_STATE_DIR: '/safe/state' },
      { PATH: '/usr/bin', ROOT_APP_SECRET: 'must-not-cross' }
    );
    expect(environment).toEqual({ PATH: '/usr/bin', ALLOW_EXTERNAL_PORTALS: '0', JOB_MCP_STATE_DIR: '/safe/state' });
    expect(() => buildOfflineSmokeEnvironment({ ALLOW_EXTERNAL_PORTALS: '1', JOB_MCP_STATE_DIR: '/safe/state' }))
      .toThrow('requires_portals_disabled');
  });

  it('fails closed when the StepStone or required-tool contract drifts', () => {
    expect(() => assertOfflineMcpCapabilities(
      { tools: tools.filter((name) => name !== 'portal_login').map((name) => ({ name })) }, capabilityResult
    )).toThrow('tool_missing:portal_login');
    expect(() => assertOfflineMcpCapabilities({ tools: tools.map((name) => ({ name })) }, {
      content: [{ type: 'text', text: JSON.stringify({ contract: 'job-search-mcp', contract_version: '1.0', sources: [] }) }]
    })).toThrow('stepstone_capability_missing');
  });

  it('terminates a timed-out environment probe and waits for its close event', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      kill: vi.fn(() => {
        setTimeout(() => child.emit('close', null), 1);
        return true;
      }),
      unref: vi.fn(),
    });
    const spawnProcess = vi.fn(() => child);

    await expect(collectOfflineProbeProcess(
      'wsl.exe', ['-d', 'Ubuntu', '--', 'env'], { ALLOW_EXTERNAL_PORTALS: '0' }, 1,
      { spawnProcess, terminationGraceMs: 20 }
    )).rejects.toThrow('job_search_mcp_smoke_environment_probe_timeout');

    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('force-terminates and detaches a probe that never closes', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      kill: vi.fn(() => true), unref: vi.fn(),
    });

    await expect(collectOfflineProbeProcess(
      'wsl.exe', ['-d', 'Ubuntu', '--', 'env'], { ALLOW_EXTERNAL_PORTALS: '0' }, 1,
      { spawnProcess: () => child, terminationGraceMs: 1 }
    )).rejects.toThrow('job_search_mcp_smoke_environment_probe_timeout');

    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });
});
