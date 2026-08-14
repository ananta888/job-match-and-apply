import { describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, assertAgentCapabilities } from './agent-runner.js';

const capabilities = {
  schemaVersion: AGENT_CONTRACT_VERSION,
  provider: 'synthetic',
  adapterVersion: '1.0.0',
  streaming: true,
  resume: false,
  interactiveInput: false,
  approvals: false,
  tools: true,
  images: false,
  structuredOutput: true,
  sandboxPolicies: ['read-only'] as const,
  usage: true,
  supportedRuntimeTargets: ['windows'] as const
};

describe('AgentCapabilities runtime contract', () => {
  it('accepts additive unknown capabilities for forward compatibility', () => {
    expect(() => assertAgentCapabilities({ ...capabilities, futureCapability: { enabled: true } })).not.toThrow();
  });

  it('rejects missing required fields and an unknown major version', () => {
    const { streaming: _streaming, ...missing } = capabilities;
    expect(() => assertAgentCapabilities(missing)).toThrow('streaming');
    expect(() => assertAgentCapabilities({ ...capabilities, schemaVersion: '2.0' })).toThrow('Inkompatible');
  });
});
