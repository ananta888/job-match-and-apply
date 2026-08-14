import { describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentRun } from '../ports/agent-runner.js';
import { createAgentSupportBundle, verifyAgentSupportBundle } from './support-bundle.js';

const run: AgentRun = {
  schemaVersion: AGENT_CONTRACT_VERSION, id: 'run-private', provider: 'fake', state: 'failed', currentSequence: 4,
  requestedAt: '2026-08-14T00:00:00Z', updatedAt: '2026-08-14T00:00:01Z',
  request: {
    provider: 'fake', task: 'CANARY_PRIVATE_PROMPT user@example.invalid', workspaceRoot: 'C:\\Users\\Real Person\\secret',
    runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny',
    applicationCaseId: 'case-private', metadata: { correlationId: 'correlation-private', userPrompt: 'CANARY_PRIVATE_PROMPT' }
  },
  failure: { code: 'provider_failed', message: 'CANARY_PRIVATE_FAILURE +49 1234', retryable: false }
};

describe('agent support bundle', () => {
  it('allowlists metadata, hashes identifiers and excludes paths, prompts, notes and failure details', () => {
    const bundle = createAgentSupportBundle({
      appVersion: '0.1.0', generatedAt: new Date('2026-08-14T00:01:00Z'), runs: [run],
      providers: [{ id: 'fake', available: true, installations: [{
        provider: 'fake', runtimeTarget: 'windows', executable: 'C:\\Users\\Real Person\\fake.exe',
        version: 'fake 1.0', support: 'supported', authStatus: 'not_required', authNote: 'CANARY_PRIVATE_NOTE'
      }] }],
      queue: { capturedAt: '2026-08-14T00:00:00Z', depth: 1, active: 0, limits: { global: 2, perProvider: 1 }, activeByProvider: {}, activeByWorkspace: { 'C:\\private': 1 }, activeByOwner: { 'real@example.invalid': 1 }, queue: [{
        runId: run.id, provider: 'fake', workspaceRoot: run.request.workspaceRoot, ownerId: 'real@example.invalid', position: 1,
        basePriority: 0, effectivePriority: 1, waitMs: 20, blockedBy: []
      }] },
      recovery: [], telemetry: { generatedAt: '2026-08-14T00:00:00Z', queueDepth: 1, activeRuns: 0, totals: { started: 1, terminal: { succeeded: 0, failed: 1, timed_out: 0, cancelled: 0 }, approvals: 0, approvalWaitMs: 0, streamReconnects: 0, recoveries: 0 }, providerRuns: { fake: 1 } },
      features: { codexAppServerExperimental: false, realtimeWebSocket: false },
      jobSearchMcp: { mode: 'demo', executionIsolation: 'trusted-host', runtimeStatus: 'demo' }
    });
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toMatch(/CANARY|Real Person|user@example|real@example|private|workspaceRoot|executable|authNote|failure detail/i);
    expect(serialized).toContain('sha256:');
    expect(verifyAgentSupportBundle(bundle)).toBe(true);
    expect(verifyAgentSupportBundle({ ...bundle, generatedAt: '2026-08-14T00:02:00Z' })).toBe(false);
  });
});
