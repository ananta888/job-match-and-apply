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

import { buildJobSearchMcpRuntimeSettings } from './job-search-mcp-discovery.js';

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
});
