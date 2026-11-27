import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config/defaults.js';

const runtimeDiscovery = vi.hoisted(() => ({
  windowsPathToWsl: vi.fn(),
}));

vi.mock('../agents/runtime-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/runtime-discovery.js')>();
  return {
    ...actual,
    AgentRuntimeDiscovery: class {
      windowsPathToWsl(...args: unknown[]): Promise<string> {
        return runtimeDiscovery.windowsPathToWsl(...args);
      }
    },
  };
});

import { buildJobSearchMcpRuntimeSettings, discoverJobSearchMcpRuntimes } from './job-search-mcp-discovery.js';

describe('job-search MCP runtime selection', () => {
  beforeEach(() => {
    runtimeDiscovery.windowsPathToWsl.mockReset();
  });

  it('maps a failed WSL path probe to a safe conflict without exposing host details', async () => {
    runtimeDiscovery.windowsPathToWsl.mockRejectedValue(new Error('sensitive synthetic host detail'));

    let failure: unknown;
    try {
      await buildJobSearchMcpRuntimeSettings(
        'wsl', structuredClone(defaultConfig), 'C:\\synthetic-workspace'
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      statusCode: 409,
      message: 'Die WSL-MCP-Runtime ist nicht verfügbar: Laufzeitpfade konnten nicht geprüft werden.',
    });
    expect(String(failure)).not.toContain('sensitive synthetic host detail');
  });
  it('offers only the native macOS venv on a Mac and reports it unavailable until installed', async () => {
    const candidates = await discoverJobSearchMcpRuntimes(structuredClone(defaultConfig), '/synthetic/repo', 'darwin');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ runtimeTarget: 'darwin', available: false, active: false });
    expect(runtimeDiscovery.windowsPathToWsl).not.toHaveBeenCalled();
  });

  it('refuses to select the macOS runtime while its venv is missing', async () => {
    await expect(buildJobSearchMcpRuntimeSettings('darwin', structuredClone(defaultConfig), '/synthetic/repo'))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Die macOS-MCP-Runtime ist nicht verfügbar') });
  });
});
