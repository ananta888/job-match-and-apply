import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentCapabilities, AgentEvent, AgentProviderInstallation, AgentRun, AgentRunRequest, AgentRunnerPort,
} from '../ports/agent-runner.js';
import type { CvFact } from '../ports/cv-normalization.js';
import {
  MemoryCvAiStructuringRunStore, sealCvAiStructuringRun, type CvAiStructuringSuggestion,
} from './cv-ai-structuring-store.js';
import {
  CvAiStructuringError, CvAiStructuringService, extractProviderJsonObject, publicCvAiStructuringRun,
  type CvAiStructuringImportPort, type CvAiStructuringValidationPort,
  type CvAiAgentRunPort, type CvAiAgentRunPurger, type CvAiStructuringObservabilityPort,
} from './cv-ai-structuring.js';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const importId = '22222222-2222-4222-8222-222222222222';
const runIds = ['11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444'];
const agentIds = ['33333333-3333-4333-8333-333333333333', '55555555-5555-4555-8555-555555555555'];

const lineManifestJson = JSON.stringify({
  contract: 'cv-line-manifest', contract_version: '1.0',
  lines: [{ line: 1, text: 'SYNTHETIC ROLE', sha256: digest('SYNTHETIC ROLE') }],
});
const schemaJson = JSON.stringify({
  type: 'object', additionalProperties: false,
  required: ['contract'], properties: { contract: { const: 'ai-cv-structure-proposal' } },
});

const suggestion: CvAiStructuringSuggestion = {
  id: 'suggestion-1111111111111111', path: 'employment[0].role', collection: 'experience',
  recordId: 'experience-1111111111111111', field: 'role', category: 'employment', mergeable: true,
  value: 'SYNTHETIC ROLE',
  sourceAnchor: { lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 14, quote: 'SYNTHETIC ROLE' },
  confidence: 0.8,
  alternatives: [{
    id: 'alternative-1111111111111111', value: 'SYNTHETIC',
    sourceAnchor: { lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 9, quote: 'SYNTHETIC' }, confidence: 0.4,
  }],
  questions: [], status: 'unverified',
};

function capabilities(): AgentCapabilities {
  return {
    schemaVersion: '1.0', provider: 'fake', providerVersion: 'fake 1.0.0', adapterVersion: '1.0.0',
    protocolVersion: '1.0', streaming: true, resume: false, interactiveInput: false, approvals: false,
    tools: false, images: false, structuredOutput: true, sandboxPolicies: ['read-only'], usage: true,
    supportedRuntimeTargets: ['windows', 'linux', 'darwin'], extensions: {
      networkControl: true, externalSandbox: 'synthetic-no-tools-v1', networkAccessClaim: 'provider-control-plane-only',
    },
  };
}

function provider(support: AgentProviderInstallation['support'] = 'supported'): AgentRunnerPort {
  const installation: AgentProviderInstallation = {
    provider: 'fake', runtimeTarget: 'windows', executable: 'synthetic', version: 'fake 1.0.0',
    support, authStatus: 'not_required', capabilities: capabilities(),
  };
  return {
    provider: 'fake', discover: vi.fn(async () => [installation]), capabilities: vi.fn(async () => capabilities()),
    start: vi.fn(), sendInput: vi.fn(), resolveApproval: vi.fn(), cancel: vi.fn(), resume: vi.fn(), dispose: vi.fn(),
  } as unknown as AgentRunnerPort;
}

class FakeRuns implements CvAiAgentRunPort {
  readonly requests: AgentRunRequest[] = [];
  readonly runs = new Map<string, AgentRun>();
  readonly runEvents = new Map<string, AgentEvent[]>();
  readonly cancelled: string[] = [];
  holdCancellation = false;

  async enqueue(request: AgentRunRequest): Promise<AgentRun> {
    const id = agentIds[this.requests.length]!; this.requests.push(structuredClone(request));
    const run: AgentRun = {
      schemaVersion: '1.0', id, provider: request.provider, state: 'queued', request: structuredClone(request),
      capabilities: capabilities(),
      requestedAt: '2026-08-14T10:00:00.000Z', updatedAt: '2026-08-14T10:00:00.000Z', currentSequence: 0,
    };
    this.runs.set(id, run); return structuredClone(run);
  }
  async get(id: string) { const run = this.runs.get(id); return run ? structuredClone(run) : undefined; }
  async events(id: string) { return structuredClone(this.runEvents.get(id) ?? []); }
  async cancel(id: string) {
    this.cancelled.push(id);
    const run = this.runs.get(id);
    if (!this.holdCancellation && run && !['cancelled', 'failed', 'timed_out', 'succeeded'].includes(run.state)) {
      this.runs.set(id, { ...run, state: 'cancelled', finishedAt: '2026-08-14T10:00:01.000Z' });
    }
  }
}

function fixture(options: {
  providerSupport?: AgentProviderInstallation['support']; now?: () => Date; allowSyntheticProviders?: boolean;
  maxRunDurationMs?: number;
} = {}) {
  const store = new MemoryCvAiStructuringRunStore();
  const agentRuns = new FakeRuns();
  const purger: CvAiAgentRunPurger = {
    deleteRuns: vi.fn(async (ids: readonly string[]) => ids.map((runId) => {
      agentRuns.runs.delete(runId); agentRuns.runEvents.delete(runId); return { runId, events: 1 };
    })),
  };
  const traces: Array<{ errorClass?: string; eventSequence?: number; code: string; operation: string }> = [];
  const observability: CvAiStructuringObservabilityPort = {
    record: vi.fn(async (input) => { traces.push(input); return input; }),
  };
  const baseProposalArtifact = { contract: 'cv-import-proposal', privateCanary: 'BASE-PRIVATE-CANARY' };
  let committedStage: { revision: number; sha256: string; facts: CvFact[] } | undefined;
  let currentImportRevision = 3;
  let currentImportSha256 = 'a'.repeat(64);
  let createdRecognition: Awaited<ReturnType<CvAiStructuringImportPort['createAiRecognitionVersion']>> | undefined;
  const imports: CvAiStructuringImportPort = {
    loadAiSource: vi.fn(async (id) => id === importId ? {
      id: importId, revision: currentImportRevision, sha256: currentImportSha256,
      sourceId: 'source-cv-aaaaaaaaaaaaaaaa',
      sourceSha256: 'b'.repeat(64), extractedTextSha256: 'c'.repeat(64), baseProposalSha256: 'd'.repeat(64),
      baseProposalArtifact, lineManifestJson, lineManifestSha256: digest(lineManifestJson),
      deterministicRecognitionVersionId: 'recognition-aaaaaaaaaaaaaaaa',
    } : undefined),
    findAiStage: vi.fn(async () => committedStage ? structuredClone(committedStage) : undefined),
    stageAiStructure: vi.fn(async (input) => {
      committedStage = {
        revision: 4, sha256: '9'.repeat(64), facts: input.facts.map((fact: CvFact) => ({
          ...structuredClone(fact), provenance: { ...structuredClone(fact.provenance), recognition: {
            ...structuredClone(fact.provenance.recognition!), runId: input.runId, proposalSha256: input.aiProposalSha256,
          } },
        })),
      };
      return { revision: 4, sha256: '9'.repeat(64), stagedFactIds: committedStage.facts.map((fact) => fact.id) };
    }),
    createAiRecognitionVersion: vi.fn(async (input) => {
      if (createdRecognition) return structuredClone(createdRecognition);
      if (input.expectedRevision !== currentImportRevision) {
        throw new CvAiStructuringError('cv_import_revision_conflict', 409, 'apply', false);
      }
      if (input.expectedSha256 !== currentImportSha256) {
        throw new CvAiStructuringError('cv_import_sha_conflict', 409, 'apply', false);
      }
      currentImportRevision = 4;
      currentImportSha256 = '9'.repeat(64);
      createdRecognition = {
        revision: currentImportRevision,
        sha256: currentImportSha256,
        recognitionVersionId: 'recognition-bbbbbbbbbbbbbbbb',
        recognitionVersionCount: 2,
        factIds: input.facts.map((fact: CvFact) => fact.id),
      };
      return structuredClone(createdRecognition);
    }),
  };
  const facts: CvFact[] = [{
    id: 'fact-1111111111111111', category: 'employment', recordId: 'experience-1111111111111111',
    field: 'role', value: 'SYNTHETIC ROLE', decision: 'pending',
    provenance: {
      sourceSha256: 'b'.repeat(64), anchor: 'ai:suggestion-1111111111111111', origin: 'imported',
      recognition: {
        method: 'ai_assisted', suggestionId: suggestion.id,
        sourceSpan: { lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 14 },
      },
    },
  }];
  const validation: CvAiStructuringValidationPort = {
    contract: vi.fn(async () => ({
      outputContract: 'ai-cv-structure-proposal' as const, outputContractVersion: '1.0' as const,
      outputSchemaJson: schemaJson, outputSchemaSha256: digest(schemaJson),
    })),
    validateProposal: vi.fn(async (input: Parameters<CvAiStructuringValidationPort['validateProposal']>[0]) => {
      expect(input.baseProposalArtifact).toBe(baseProposalArtifact);
      return {
        contract: 'validated-ai-cv-structure-proposal' as const, contractVersion: '1.0' as const, status: 'unverified' as const,
        binding: {
          sourceId: 'source-cv-aaaaaaaaaaaaaaaa', sourceSha256: 'b'.repeat(64),
          extractedTextSha256: 'c'.repeat(64), baseProposalSha256: 'd'.repeat(64),
        },
        proposalSha256: 'e'.repeat(64), suggestions: [suggestion],
        privateArtifact: { aiProposal: input.aiProposal, privateCanary: 'VALIDATED-PRIVATE-CANARY' },
      };
    }),
    applySelections: vi.fn(async (input: Parameters<CvAiStructuringValidationPort['applySelections']>[0]) => {
      expect(input.baseProposalArtifact).toBe(baseProposalArtifact);
      return {
        mergedArtifact: { contract: 'cv-import-proposal', merged: true }, mergedProposalSha256: '8'.repeat(64),
        facts, appliedSuggestionIds: input.selections.map((item) => item.suggestionId),
      };
    }),
    materializeRecognitionVersion: vi.fn(async () => ({
      materializedArtifact: { contract: 'cv-import-proposal', materialized: true },
      materializedProposalSha256: '7'.repeat(64),
      facts,
      warnings: [],
      unresolvedConflicts: [],
      appliedSuggestionIds: [suggestion.id],
    })),
  };
  let idIndex = 0;
  const service = new CvAiStructuringService({
    store, imports, validation, agentRuns, purger, observability, providers: [provider(options.providerSupport)],
    configProfiles: { load: async () => ({ profile: {
      schemaVersion: 3, profileId: 'safe-default', updatedAt: '2026-08-14T09:00:00.000Z',
      providers: [{ provider: 'fake', enabled: true, runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' }],
      budgets: { warningAtPercent: 80, maxRunDurationMs: options.maxRunDurationMs ?? 60_000 },
      features: { multiAgentExperimental: true, realtimeWebSocketExperimental: false, rawProviderLogs: false },
    }, source: 'primary' }) },
    workspaceRoot: process.cwd(), now: options.now ?? (() => new Date('2026-08-14T10:00:00.000Z')),
    id: () => runIds[idIndex++]!, runTtlMs: 60_000,
    allowSyntheticProviders: options.allowSyntheticProviders ?? true,
  });
  return {
    service, store, imports, validation, agentRuns, purger, traces,
    setImportCas(revision: number, sha256: string) {
      currentImportRevision = revision;
      currentImportSha256 = sha256;
    },
    get committedStage() { return committedStage; },
  };
}

const disclosure = {
  version: '1.0' as const, confirmed: true as const, sendExtractedCvTextToProvider: true as const,
  acknowledgeProviderControlPlaneNetwork: true as const,
};
const actor = { id: 'local-user', type: 'local' as const };
const selection = { providerId: 'fake', runtimeTarget: 'windows' as const, expectedVersion: 'fake 1.0.0' };
const providerEvents = (agentId: string, output: string, extra: AgentEvent[] = []): AgentEvent[] => [{
  schemaVersion: '1.0', runId: agentId, sequence: 1, timestamp: '2026-08-14T10:00:09.000Z', provider: 'fake',
  correlationId: 'synthetic', kind: 'process_started', data: {
    runtimeTarget: 'windows', sandboxEnforcement: 'synthetic-no-tools-v1', networkAccessClaim: 'provider-control-plane-only',
  },
}, ...extra, {
  schemaVersion: '1.0', runId: agentId, sequence: extra.length + 2, timestamp: '2026-08-14T10:00:10.000Z', provider: 'fake',
  correlationId: 'synthetic', kind: 'agent_message_completed', data: { text: output },
}];

async function makeReady(value = fixture()) {
  const started = await value.service.start({
    cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
    provider: selection, disclosure, actor,
  });
  const agentId = agentIds[0]!;
  value.agentRuns.runs.set(agentId, { ...value.agentRuns.runs.get(agentId)!, state: 'succeeded' });
  value.agentRuns.runEvents.set(agentId, providerEvents(agentId, '{"contract":"ai-cv-structure-proposal"}'));
  const ready = await value.service.get(importId, started.id);
  return { ...value, started, ready, get committedStage() { return value.committedStage; } };
}

async function leaveApplyingAfterCommittedStage(value = fixture()) {
  const readyValue = await makeReady(value);
  const originalSave = readyValue.store.compareAndSave.bind(readyValue.store); let failedOnce = false;
  vi.spyOn(readyValue.store, 'compareAndSave').mockImplementation(async (...args) => {
    const next = args[3];
    if (next.status === 'applied' && !failedOnce) { failedOnce = true; throw new Error('synthetic_run_save_crash'); }
    return originalSave(...args);
  });
  await expect(readyValue.service.apply({
    cvImportId: importId, runId: readyValue.ready.id, expectedRunRevision: readyValue.ready.revision,
    expectedRunSha256: readyValue.ready.sha256, expectedCvImportRevision: 3,
    expectedCvImportSha256: 'a'.repeat(64), confirmed: true, actor,
    selections: [{ suggestionId: suggestion.id, alternativeId: null }],
  })).rejects.toThrow('synthetic_run_save_crash');
  expect(await readyValue.store.get(readyValue.ready.id)).toMatchObject({ status: 'applying', applyIntent: {
    expectedCvImportRevision: 3, selections: [{ suggestionId: suggestion.id, alternativeId: null }],
  } });
  expect(publicCvAiStructuringRun((await readyValue.store.get(readyValue.ready.id))!)).not.toHaveProperty('applyIntent');
  return readyValue;
}

describe('provider answer unwrapping', () => {
  const proposal = { contract: 'ai-cv-structure-proposal', fields: [] };
  const json = JSON.stringify(proposal);

  it('accepts a bare object, unchanged', () => {
    expect(extractProviderJsonObject(json)).toEqual(proposal);
    expect(extractProviderJsonObject(`
  ${json}  
`)).toEqual(proposal);
  });

  it('accepts the shapes a CLI provider actually produces', () => {
    // Reproduces the two failures observed with Claude CLI: a spoken preamble
    // and a fenced block. Both were rejected as provider_output_not_strict_json.
    expect(extractProviderJsonObject(
      `Hier ist die Struktur des Lebenslaufs:

\`\`\`json
${json}
\`\`\`
`,
    )).toEqual(proposal);
    expect(extractProviderJsonObject(`\`\`\`
${json}
\`\`\``)).toEqual(proposal);
    expect(extractProviderJsonObject(`Ergebnis:
${json}
Soll ich noch etwas anpassen?`)).toEqual(proposal);
  });

  it('keeps braces inside strings from truncating the object', () => {
    const tricky = { note: 'ein } und ein \\" im Text', ok: true };
    expect(extractProviderJsonObject(`Text
${JSON.stringify(tricky)}
Ende`)).toEqual(tricky);
  });

  it('still refuses answers that carry no object', () => {
    expect(extractProviderJsonObject('Ich kann das leider nicht strukturieren.')).toBeUndefined();
    expect(extractProviderJsonObject('[1, 2, 3]')).toBeUndefined();
    expect(extractProviderJsonObject('```json\n{ kaputt \n```')).toBeUndefined();
    expect(extractProviderJsonObject('')).toBeUndefined();
  });
});

describe('CvAiStructuringService', () => {
  it('keeps the synthetic provider test-only unless the composition explicitly opts in', async () => {
    const blocked = fixture({ allowSyntheticProviders: false });
    const options = await blocked.service.options({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
    });
    expect(options.providers[0]!.installations[0]).toMatchObject({
      ready: false, blockers: expect.arrayContaining(['synthetic_provider_test_only']),
    });
  });

  it('lists exact-version options with an explicit provider-control-plane disclosure and fails closed when untested', async () => {
    const ready = fixture();
    expect(await ready.service.options({ cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64) }))
      .toMatchObject({
        contract: 'cv-ai-structuring-options', providers: [{
          providerId: 'fake', installations: [{ ready: true, version: 'fake 1.0.0',
            network: { toolNetwork: 'disabled', jobSearchMcpAccessible: false, providerControlPlane: 'provider_managed_may_use_network' } }],
        }],
      });
    const blocked = fixture({ providerSupport: 'untested' });
    const options = await blocked.service.options({ cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64) });
    expect(options.providers[0]!.installations[0]).toMatchObject({ ready: false, blockers: ['installation_not_supported'] });
  });

  it('starts only with literal opt-in and enqueues a locked read-only/no-tool/no-network agent run', async () => {
    const { service, agentRuns } = fixture();
    const started = await service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor, correlationId: 'correlation-one',
    });
    expect(started).toMatchObject({ id: runIds[0], status: 'queued', provider: { id: 'fake', version: 'fake 1.0.0' } });
    expect(JSON.stringify(started)).not.toContain('BASE-PRIVATE-CANARY');
    expect(agentRuns.requests[0]).toMatchObject({
      provider: 'fake', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny',
      metadata: {
        workflowId: 'cv-ai-structuring', requiredRootMcpTools: [], providerToolMode: 'none',
        expectedProviderVersion: 'fake 1.0.0',
      },
    });
    expect(agentRuns.requests[0]!.task).toContain('UNTRUSTED DATA ONLY');
    expect(agentRuns.requests[0]!.limits!.maxInputBytes).toBeGreaterThanOrEqual(
      Buffer.byteLength(agentRuns.requests[0]!.task, 'utf8'),
    );
    // An idle ceiling above the wall clock could never fire. This profile
    // tightens the run duration to 60 s, so the idle limit has to follow it down.
    expect(agentRuns.requests[0]!.limits!.wallTimeMs).toBe(60_000);
    expect(agentRuns.requests[0]!.limits!.idleTimeMs).toBe(60_000);
  });

  it('allows a provider to stay silent for a whole batched turn', async () => {
    // One single-shot turn with no tools: a provider that batches its answer
    // sends nothing until the turn ends. Measured against the real payload,
    // opencode emitted step_start after 3.8 s and then nothing for 311 s. The
    // former two-minute idle ceiling killed every such run as if the process had
    // wedged, which is why opencode never once completed.
    const { service, agentRuns } = fixture({ maxRunDurationMs: 30 * 60_000 });
    await service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    const limits = agentRuns.requests[0]!.limits!;
    expect(limits.idleTimeMs).toBeGreaterThan(311_000);
    expect(limits.wallTimeMs).toBe(10 * 60_000);
    expect(limits.idleTimeMs).toBeLessThanOrEqual(limits.wallTimeMs!);
  });

  it('reassembles an answer the provider streamed as several text blocks', async () => {
    // The Claude CLI emits one assistant event per text block, so a long
    // structure never arrives as a single message. Requiring exactly one
    // rejected every such run with provider_output_not_strict_json, and taking
    // only the last block would keep nothing but the tail.
    const { service, agentRuns, validation } = fixture();
    const started = await service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    const agentId = agentIds[0]!;
    agentRuns.runs.set(agentId, { ...agentRuns.runs.get(agentId)!, state: 'succeeded', finishedAt: '2026-08-14T10:00:10.000Z' });
    const fragments = ['{"contract":', '"ai-cv-structure', '-proposal"}'];
    agentRuns.runEvents.set(agentId, [
      {
        schemaVersion: '1.0', runId: agentId, sequence: 1, timestamp: '2026-08-14T10:00:09.000Z', provider: 'fake',
        correlationId: 'synthetic', kind: 'process_started', data: {
          runtimeTarget: 'windows', sandboxEnforcement: 'synthetic-no-tools-v1',
          networkAccessClaim: 'provider-control-plane-only',
        },
      },
      ...fragments.map((text, index) => ({
        schemaVersion: '1.0' as const, runId: agentId, sequence: index + 2,
        timestamp: '2026-08-14T10:00:10.000Z', provider: 'fake', correlationId: 'synthetic',
        kind: 'agent_message_completed' as const, data: { text },
      })),
    ] as never);

    const ready = await service.get(importId, started.id);
    expect(ready).toMatchObject({ status: 'suggestions_ready' });
    // The port must see the reassembled object, not a fragment.
    expect(validation.validateProposal).toHaveBeenCalledWith(expect.objectContaining({
      aiProposal: { contract: 'ai-cv-structure-proposal' },
    }));
  });

  it('accepts exactly one JSON object, validates it through the submodule port, and purges the raw agent run before exposing suggestions', async () => {
    const { service, agentRuns, purger, validation } = fixture();
    const started = await service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    const agentId = agentIds[0]!;
    agentRuns.runs.set(agentId, { ...agentRuns.runs.get(agentId)!, state: 'succeeded', finishedAt: '2026-08-14T10:00:10.000Z' });
    agentRuns.runEvents.set(agentId, providerEvents(agentId, '{"contract":"ai-cv-structure-proposal"}'));

    const ready = await service.get(importId, started.id);
    expect(ready).toMatchObject({ status: 'suggestions_ready', proposal: { sha256: 'e'.repeat(64), suggestions: [suggestion] } });
    expect(JSON.stringify(ready)).not.toContain('VALIDATED-PRIVATE-CANARY');
    expect(validation.validateProposal).toHaveBeenCalledTimes(1);
    expect(purger.deleteRuns).toHaveBeenCalledWith([agentId]);
  });

  it('singleflights concurrent get and list refreshes for the same succeeded run', async () => {
    const value = fixture();
    const started = await value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    const agentId = agentIds[0]!;
    value.agentRuns.runs.set(agentId, {
      ...value.agentRuns.runs.get(agentId)!, state: 'succeeded', finishedAt: '2026-08-14T10:00:10.000Z',
    });
    value.agentRuns.runEvents.set(agentId, providerEvents(agentId, '{"contract":"ai-cv-structure-proposal"}'));
    const originalSave = value.store.compareAndSave.bind(value.store);
    let releaseValidating!: () => void;
    const validatingGate = new Promise<void>((resolve) => { releaseValidating = resolve; });
    let enteredValidating!: () => void;
    const validatingEntered = new Promise<void>((resolve) => { enteredValidating = resolve; });
    vi.spyOn(value.store, 'compareAndSave').mockImplementation(async (...args) => {
      if (args[3].status === 'validating') {
        enteredValidating();
        await validatingGate;
      }
      return originalSave(...args);
    });

    const getPromise = value.service.get(importId, started.id);
    await validatingEntered;
    const listPromise = value.service.list(importId);
    releaseValidating();
    const [got, listed] = await Promise.all([getPromise, listPromise]);

    expect(got).toMatchObject({ id: started.id, status: 'suggestions_ready' });
    expect(listed).toEqual([expect.objectContaining({ id: started.id, status: 'suggestions_ready' })]);
    expect(value.validation.validateProposal).toHaveBeenCalledTimes(1);
    expect(value.purger.deleteRuns).toHaveBeenCalledTimes(1);
  });

  it('materializes a complete AI recognition version from the deterministic source and activates it without per-suggestion clicks', async () => {
    const { service, agentRuns, purger, validation, imports } = fixture();
    const started = await service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, mode: 'replace_with_ai_version', actor,
    });
    const agentId = agentIds[0]!;
    agentRuns.runs.set(agentId, {
      ...agentRuns.runs.get(agentId)!, state: 'succeeded', finishedAt: '2026-08-14T10:00:10.000Z',
    });
    agentRuns.runEvents.set(agentId, providerEvents(agentId, '{"contract":"ai-cv-structure-proposal"}'));

    const applied = await service.get(importId, started.id);

    expect(applied).toMatchObject({
      mode: 'replace_with_ai_version', status: 'applied',
      result: {
        recognitionVersionId: 'recognition-bbbbbbbbbbbbbbbb', recognitionVersionCount: 2,
        stagedFactIds: ['fact-1111111111111111'], factsRemainPending: true,
      },
    });
    expect(applied).not.toHaveProperty('proposal');
    expect(validation.materializeRecognitionVersion).toHaveBeenCalledWith(expect.objectContaining({
      expectedBaseProposalSha256: 'd'.repeat(64), expectedAiProposalSha256: 'e'.repeat(64),
    }));
    expect(imports.createAiRecognitionVersion).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({
        deterministicRecognitionVersionId: 'recognition-aaaaaaaaaaaaaaaa',
        baseProposalSha256: 'd'.repeat(64),
      }),
      provenance: expect.objectContaining({
        runId: started.id, proposalSha256: 'e'.repeat(64),
        selections: [{ suggestionId: suggestion.id, alternativeId: null }],
      }),
      facts: [expect.objectContaining({ decision: 'pending' })],
    }));
    expect(purger.deleteRuns).toHaveBeenCalledWith([agentId]);
  });

  it.each([
    ['revision', { revision: 4 }, 'cv_import_revision_conflict'],
    ['sha256', { sha256: 'f'.repeat(64) }, 'cv_import_sha_conflict'],
  ] as const)('fails closed with 409 when the import %s drifts before replacement commit', async (
    _field,
    patch,
    expectedCode,
  ) => {
    const value = fixture();
    const started = await value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, mode: 'replace_with_ai_version', actor,
    });
    const source = (await value.imports.loadAiSource(importId))!;
    value.setImportCas(
      'revision' in patch ? patch.revision : source.revision,
      'sha256' in patch ? patch.sha256 : source.sha256,
    );
    const agentId = agentIds[0]!;
    value.agentRuns.runs.set(agentId, {
      ...value.agentRuns.runs.get(agentId)!, state: 'succeeded', finishedAt: '2026-08-14T10:00:10.000Z',
    });
    value.agentRuns.runEvents.set(agentId, providerEvents(agentId, '{"contract":"ai-cv-structure-proposal"}'));

    await expect(value.service.get(importId, started.id)).rejects.toMatchObject({
      code: expectedCode, statusCode: 409,
    });
    expect(value.validation.materializeRecognitionVersion).toHaveBeenCalledTimes(1);
    expect(value.imports.createAiRecognitionVersion).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 3, expectedSha256: 'a'.repeat(64),
    }));
    expect(await value.store.get(started.id)).toMatchObject({
      status: 'failed', failure: { code: expectedCode, retryable: false },
    });
  });

  it('recovers the same recognition version when saving the applied run crashes after import materialization', async () => {
    const value = fixture();
    const started = await value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, mode: 'replace_with_ai_version', actor,
    });
    const agentId = agentIds[0]!;
    value.agentRuns.runs.set(agentId, { ...value.agentRuns.runs.get(agentId)!, state: 'succeeded' });
    value.agentRuns.runEvents.set(agentId, providerEvents(agentId, '{"contract":"ai-cv-structure-proposal"}'));
    const originalSave = value.store.compareAndSave.bind(value.store); let failedOnce = false;
    vi.spyOn(value.store, 'compareAndSave').mockImplementation(async (...args) => {
      if (args[3].status === 'applied' && !failedOnce) {
        failedOnce = true;
        throw new Error('synthetic_recognition_run_save_crash');
      }
      return originalSave(...args);
    });

    await expect(value.service.get(importId, started.id)).rejects.toThrow();
    expect(await value.store.get(started.id)).toMatchObject({ status: 'suggestions_ready' });

    const recovered = await value.service.get(importId, started.id);
    expect(recovered).toMatchObject({
      status: 'applied', result: { recognitionVersionId: 'recognition-bbbbbbbbbbbbbbbb' },
    });
    expect(value.imports.createAiRecognitionVersion).toHaveBeenCalledTimes(2);
  });

  it('keeps replacement recovery active after one raw-purge failure and finishes on the next poll', async () => {
    const value = fixture();
    const started = await value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, mode: 'replace_with_ai_version', actor,
    });
    const agentId = agentIds[0]!;
    value.agentRuns.runs.set(agentId, { ...value.agentRuns.runs.get(agentId)!, state: 'succeeded' });
    value.agentRuns.runEvents.set(agentId, providerEvents(agentId, '{"contract":"ai-cv-structure-proposal"}'));
    vi.mocked(value.purger.deleteRuns).mockRejectedValueOnce(new Error('synthetic_purge_failure'));

    const recovering = await value.service.get(importId, started.id);
    expect(recovering).toMatchObject({ mode: 'replace_with_ai_version', status: 'suggestions_ready' });
    await expect(value.service.start({
      cvImportId: importId, expectedCvImportRevision: 4, expectedCvImportSha256: '9'.repeat(64),
      provider: selection, disclosure, mode: 'replace_with_ai_version', actor,
    })).rejects.toMatchObject({ code: 'cv_ai_run_already_active', statusCode: 409 });
    expect(value.agentRuns.requests).toHaveLength(1);

    const applied = await value.service.get(importId, started.id);
    expect(applied).toMatchObject({
      mode: 'replace_with_ai_version', status: 'applied',
      result: { recognitionVersionId: 'recognition-bbbbbbbbbbbbbbbb' },
    });
    expect(value.purger.deleteRuns).toHaveBeenCalledTimes(2);
    expect(value.imports.createAiRecognitionVersion).toHaveBeenCalledTimes(2);
  });

  it('rejects manual suggestion apply for a replacement run stranded in suggestions_ready recovery', async () => {
    const value = fixture();
    const started = await value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, mode: 'replace_with_ai_version', actor,
    });
    const agentId = agentIds[0]!;
    value.agentRuns.runs.set(agentId, { ...value.agentRuns.runs.get(agentId)!, state: 'succeeded' });
    value.agentRuns.runEvents.set(agentId, providerEvents(agentId, '{"contract":"ai-cv-structure-proposal"}'));
    const originalSave = value.store.compareAndSave.bind(value.store); let failedOnce = false;
    vi.spyOn(value.store, 'compareAndSave').mockImplementation(async (...args) => {
      if (args[3].status === 'applied' && !failedOnce) {
        failedOnce = true;
        throw new Error('synthetic_recognition_run_save_crash');
      }
      return originalSave(...args);
    });
    await expect(value.service.get(importId, started.id)).rejects.toThrow('synthetic_recognition_run_save_crash');
    const stranded = (await value.store.get(started.id))!;
    expect(stranded).toMatchObject({ mode: 'replace_with_ai_version', status: 'suggestions_ready' });

    await expect(value.service.apply({
      cvImportId: importId, runId: stranded.id,
      expectedRunRevision: stranded.revision, expectedRunSha256: stranded.sha256,
      expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      selections: [{ suggestionId: suggestion.id, alternativeId: null }], confirmed: true, actor,
    })).rejects.toMatchObject({ code: 'cv_ai_run_not_applyable', statusCode: 409 });
    expect(value.validation.applySelections).not.toHaveBeenCalled();
    expect(value.imports.stageAiStructure).not.toHaveBeenCalled();
    expect(await value.store.get(started.id)).toEqual(stranded);
  });

  it('fails closed on an answer without any object, supports explicit cancel, and retries from the current encrypted import only after fresh disclosure', async () => {
    const { service, agentRuns } = fixture();
    const started = await service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    const agentId = agentIds[0]!;
    agentRuns.runs.set(agentId, { ...agentRuns.runs.get(agentId)!, state: 'succeeded' });
    // Markdown wrapping is unwrapped now, so only an answer that carries no
    // object at all still fails closed.
    agentRuns.runEvents.set(agentId, providerEvents(agentId, 'Ich kann das leider nicht strukturieren.'));
    const failed = await service.get(importId, started.id);
    expect(failed).toMatchObject({ status: 'failed', failure: { code: 'provider_output_not_strict_json', stage: 'validation' } });

    const retried = await service.retry({
      cvImportId: importId, runId: failed.id, expectedRunRevision: failed.revision, expectedRunSha256: failed.sha256,
      expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64), provider: selection,
      disclosure, actor,
    });
    expect(retried).toMatchObject({ attempt: 2, retryOf: failed.id, status: 'queued' });
    await service.cancel({
      cvImportId: importId, runId: retried.id, expectedRunRevision: retried.revision,
      expectedRunSha256: retried.sha256, confirmed: true, actor,
    });
    expect(agentRuns.cancelled).toContain(agentIds[1]);
  });

  it('records the shape of a rejected answer before the raw run is purged, without its content', async () => {
    // Three paths end in provider_output_not_strict_json and the raw run is
    // gone immediately afterwards, so a failed run used to say nothing about
    // which one it took. These counters separate them from a single attempt.
    const { service, agentRuns, purger, traces } = fixture();
    const started = await service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    const agentId = agentIds[0]!;
    agentRuns.runs.set(agentId, { ...agentRuns.runs.get(agentId)!, state: 'succeeded' });
    const prose = 'Ich kann das leider nicht strukturieren.';
    agentRuns.runEvents.set(agentId, providerEvents(agentId, prose, [{
      schemaVersion: '1.0', runId: agentId, sequence: 100, timestamp: '2026-08-14T10:00:09.500Z',
      provider: 'fake', correlationId: 'synthetic', kind: 'rate_limit_event', data: {},
    }]));

    const failed = await service.get(importId, started.id);
    expect(failed).toMatchObject({ status: 'failed', failure: { code: 'provider_output_not_strict_json' } });

    const shape = new Map(traces
      .filter((entry) => entry.operation === 'provider_output_shape')
      .map((entry) => [entry.errorClass, entry.eventSequence]));
    expect(shape.get('message_events')).toBe(1);
    expect(shape.get('message_blocks_with_text')).toBe(1);
    expect(shape.get('output_bytes')).toBe(Buffer.byteLength(prose, 'utf8'));
    expect(shape.get('open_braces')).toBe(0);
    expect(shape.get('events_total')).toBe(3);
    expect(shape.get('kind.rate_limit_event')).toBe(1);
    expect(shape.get('kind.process_started')).toBe(1);

    // Diagnosis buys no retention: the raw run is still purged.
    expect(purger.deleteRuns).toHaveBeenCalledWith([agentId]);
    const written = JSON.stringify(traces);
    expect(written).not.toContain(prose);
    expect(written).not.toContain('SYNTHETIC ROLE');
  });

  it('records the exit code and stderr volume of a provider process that died', async () => {
    // A bare 'crash' says only "exited non-zero". Without the exit code and
    // how much the process wrote, a run that refused the request cannot be
    // told from one that never got started, and the purge removes both.
    const { service, agentRuns, traces } = fixture();
    const started = await service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    const agentId = agentIds[0]!;
    const complaint = 'Credit balance is too low';
    agentRuns.runEvents.set(agentId, [{
      schemaVersion: '1.0', runId: agentId, sequence: 1, timestamp: '2026-08-14T10:00:09.000Z', provider: 'fake',
      correlationId: 'synthetic', kind: 'warning', data: { code: 'provider_stderr', message: complaint },
    }, {
      schemaVersion: '1.0', runId: agentId, sequence: 2, timestamp: '2026-08-14T10:00:10.000Z', provider: 'fake',
      correlationId: 'synthetic', kind: 'error', data: { code: 'crash', message: 'Providerprozess endete mit Code 1.', retryable: true },
    }, {
      schemaVersion: '1.0', runId: agentId, sequence: 3, timestamp: '2026-08-14T10:00:10.000Z', provider: 'fake',
      correlationId: 'synthetic', kind: 'run_completed', data: { state: 'failed', exitCode: 1, termination: 'crash' },
    }]);
    agentRuns.runs.set(agentId, {
      ...agentRuns.runs.get(agentId)!, state: 'failed', finishedAt: '2026-08-14T10:00:10.000Z',
      failure: { code: 'crash', message: 'Providerprozess endete mit Code 1.', retryable: true },
    });

    const failed = await service.get(importId, started.id);
    expect(failed).toMatchObject({ status: 'failed', failure: { code: 'crash', stage: 'agent' } });

    const shape = new Map(traces
      .filter((entry) => entry.operation === 'agent_failure_shape')
      .map((entry) => [entry.errorClass, entry.eventSequence]));
    expect(shape.get('exit_code')).toBe(1);
    expect(shape.get('termination.crash')).toBe(1);
    expect(shape.get('stderr_chunks')).toBe(1);
    expect(shape.get('stderr_bytes')).toBe(Buffer.byteLength(complaint, 'utf8'));
    expect(shape.get('message_events')).toBe(0);
    expect(JSON.stringify(traces)).not.toContain(complaint);
  });

  it('upgrades a migrated failed run without a mode to the simple replacement flow on retry', async () => {
    const { service, store, agentRuns } = fixture();
    const started = await service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    const agentId = agentIds[0]!;
    agentRuns.runs.set(agentId, { ...agentRuns.runs.get(agentId)!, state: 'failed' });
    const failed = await service.get(importId, started.id);
    const stored = (await store.get(failed.id))!;
    const { mode: _mode, sha256: _sha256, ...legacyBody } = stored;
    const migrated = sealCvAiStructuringRun({ ...legacyBody, revision: stored.revision + 1 });
    await store.compareAndSave(stored.id, stored.revision, stored.sha256, migrated);

    const retried = await service.retry({
      cvImportId: importId, runId: migrated.id, expectedRunRevision: migrated.revision,
      expectedRunSha256: migrated.sha256, expectedCvImportRevision: 3,
      expectedCvImportSha256: 'a'.repeat(64), provider: selection, disclosure,
      mode: 'replace_with_ai_version', actor,
    });

    expect(retried).toMatchObject({
      attempt: 2, retryOf: migrated.id, mode: 'replace_with_ai_version', status: 'queued',
    });
  });

  it('applies only selected validator IDs and atomically stages the merged artifact with pending facts', async () => {
    const { service, agentRuns, validation, imports } = fixture();
    const started = await service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    const agentId = agentIds[0]!;
    agentRuns.runs.set(agentId, { ...agentRuns.runs.get(agentId)!, state: 'succeeded' });
    agentRuns.runEvents.set(agentId, providerEvents(agentId, '{"contract":"ai-cv-structure-proposal"}'));
    const ready = await service.get(importId, started.id);
    const applied = await service.apply({
      cvImportId: importId, runId: ready.id, expectedRunRevision: ready.revision, expectedRunSha256: ready.sha256,
      expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64), confirmed: true, actor,
      selections: [{ suggestionId: suggestion.id, alternativeId: null }],
    });

    expect(applied).toMatchObject({ status: 'applied', result: { cvImportRevision: 4, factsRemainPending: true } });
    expect(validation.applySelections).toHaveBeenCalledWith(expect.objectContaining({
      expectedBaseProposalSha256: 'd'.repeat(64), expectedAiProposalSha256: 'e'.repeat(64),
      selections: [{ suggestionId: suggestion.id, alternativeId: null }],
    }));
    expect(imports.stageAiStructure).toHaveBeenCalledWith(expect.objectContaining({
      mergedArtifact: { contract: 'cv-import-proposal', merged: true },
      facts: [expect.objectContaining({ decision: 'pending' })],
      selections: [{ suggestionId: suggestion.id, alternativeId: null }],
    }));
    expect(JSON.stringify(applied)).not.toContain('applyIntent');
  });

  it('recovers idempotently when the import stage committed but saving the applied run crashed', async () => {
    const value = await leaveApplyingAfterCommittedStage();

    const recovered = await value.service.get(importId, value.ready.id);
    expect(recovered).toMatchObject({ status: 'applied', result: { stagedFactIds: ['fact-1111111111111111'] } });
    expect(value.validation.applySelections).toHaveBeenCalledTimes(1);
    expect(value.imports.stageAiStructure).toHaveBeenCalledTimes(1);
  });

  it('recovers a committed stage through list after its exact AI fact was explicitly confirmed', async () => {
    const value = await leaveApplyingAfterCommittedStage();
    value.committedStage!.facts[0]!.decision = 'confirmed';

    expect(await value.service.list(importId)).toEqual([
      expect.objectContaining({ status: 'applied', result: expect.objectContaining({
        stagedFactIds: ['fact-1111111111111111'],
      }) }),
    ]);
    expect(value.validation.applySelections).toHaveBeenCalledTimes(1);
    expect(value.imports.stageAiStructure).toHaveBeenCalledTimes(1);
  });

  it('recovers a committed stage after rejection and lets import deletion remove the run', async () => {
    const value = await leaveApplyingAfterCommittedStage();
    value.committedStage!.facts[0]!.decision = 'rejected';

    expect(await value.service.deleteForImport(importId)).toEqual([value.ready.id]);
    expect(await value.store.get(value.ready.id)).toBeUndefined();
    expect(value.validation.applySelections).toHaveBeenCalledTimes(1);
    expect(value.imports.stageAiStructure).toHaveBeenCalledTimes(1);
  });

  it('recovers a reviewed committed stage before retention pruning instead of leaving it applying', async () => {
    let current = new Date('2026-08-14T10:00:00.000Z');
    const value = await leaveApplyingAfterCommittedStage(fixture({ now: () => current }));
    value.committedStage!.facts[0]!.decision = 'confirmed';
    current = new Date('2026-08-14T10:02:00.000Z');

    expect(await value.service.expireAndPrune(current)).toEqual([value.ready.id]);
    expect(await value.store.get(value.ready.id)).toBeUndefined();
  });

  it('rejects a validator result unless every selection maps to exactly one pending fact with exact recognition IDs', async () => {
    const value = await makeReady();
    vi.mocked(value.validation.applySelections).mockResolvedValueOnce({
      mergedArtifact: { contract: 'cv-import-proposal', merged: true }, mergedProposalSha256: '8'.repeat(64),
      facts: [{
        id: 'fact-1111111111111111', category: 'employment', recordId: 'experience-1111111111111111',
        field: 'role', value: 'SYNTHETIC ROLE', decision: 'pending', provenance: {
          sourceSha256: 'b'.repeat(64), anchor: 'ai:wrong', origin: 'imported', recognition: {
            method: 'ai_assisted', suggestionId: 'suggestion-2222222222222222',
            sourceSpan: { lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 14 },
          },
        },
      }],
      appliedSuggestionIds: [suggestion.id],
    });
    await expect(value.service.apply({
      cvImportId: importId, runId: value.ready.id, expectedRunRevision: value.ready.revision,
      expectedRunSha256: value.ready.sha256, expectedCvImportRevision: 3,
      expectedCvImportSha256: 'a'.repeat(64), confirmed: true, actor,
      selections: [{ suggestionId: suggestion.id, alternativeId: null }],
    })).rejects.toMatchObject({ code: 'cv_ai_pending_facts_invalid' });
    expect(value.imports.stageAiStructure).not.toHaveBeenCalled();
    expect(await value.store.get(value.ready.id)).toMatchObject({ status: 'failed' });
  });

  it('drops output on capability drift, forbidden tool activity, or a mismatched process attestation', async () => {
    const capabilityDrift = fixture();
    const driftStart = await capabilityDrift.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    const driftAgent = capabilityDrift.agentRuns.runs.get(agentIds[0]!)!;
    capabilityDrift.agentRuns.runs.set(agentIds[0]!, {
      ...driftAgent, state: 'succeeded', capabilities: { ...driftAgent.capabilities!, adapterVersion: '9.9.9' },
    });
    expect(await capabilityDrift.service.get(importId, driftStart.id)).toMatchObject({
      status: 'failed', failure: { code: 'agent_capability_binding_mismatch' },
    });

    const toolActivity = fixture();
    const toolStart = await toolActivity.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    toolActivity.agentRuns.runs.set(agentIds[0]!, { ...toolActivity.agentRuns.runs.get(agentIds[0]!)!, state: 'succeeded' });
    toolActivity.agentRuns.runEvents.set(agentIds[0]!, providerEvents(agentIds[0]!, '{"contract":"ai-cv-structure-proposal"}', [{
      schemaVersion: '1.0', runId: agentIds[0]!, sequence: 2, timestamp: '2026-08-14T10:00:09.500Z', provider: 'fake',
      correlationId: 'synthetic', kind: 'tool_requested', data: { name: 'Read' },
    }]));
    expect(await toolActivity.service.get(importId, toolStart.id)).toMatchObject({
      status: 'failed', failure: { code: 'provider_tool_activity_forbidden' },
    });
    expect(toolActivity.validation.validateProposal).not.toHaveBeenCalled();

    const attestation = fixture();
    const attestationStart = await attestation.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    attestation.agentRuns.runs.set(agentIds[0]!, { ...attestation.agentRuns.runs.get(agentIds[0]!)!, state: 'succeeded' });
    attestation.agentRuns.runEvents.set(agentIds[0]!, providerEvents(agentIds[0]!, '{}').map((event) => event.kind === 'process_started'
      ? { ...event, data: { ...event.data, sandboxEnforcement: 'wrong' } } : event));
    expect(await attestation.service.get(importId, attestationStart.id)).toMatchObject({
      status: 'failed', failure: { code: 'provider_process_attestation_mismatch' },
    });
  });

  it('requires the exact empty-tool Claude initialization heartbeat in addition to process attestation', async () => {
    const value = fixture();
    const started = await value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    const stored = (await value.store.get(started.id))!;
    const checker = value.service as unknown as {
      processAttestationMatches(record: typeof stored, capabilities: AgentCapabilities, events: AgentEvent[]): boolean;
    };
    const claudeRecord = { ...stored, provider: {
      id: 'claude-cli', runtimeTarget: 'wsl' as const, wslDistribution: 'Ubuntu',
      version: '2.1.232 (Claude Code)', adapterVersion: '1.1.0',
    } };
    const claudeCapabilities: AgentCapabilities = {
      ...capabilities(), provider: 'claude-cli', providerVersion: '2.1.232 (Claude Code)', adapterVersion: '1.1.0',
      tools: true, supportedRuntimeTargets: ['wsl'], extensions: {
        externalSandbox: 'wsl-bubblewrap-v1', networkAccessClaim: 'provider-control-plane-only',
        serverOwnedNoToolsMode: 'cv-ai-structuring-v1',
      },
    };
    const processEvent: AgentEvent = {
      schemaVersion: '1.0', runId: stored.agentRunId, sequence: 1, timestamp: stored.createdAt,
      provider: 'claude-cli', correlationId: 'synthetic', kind: 'process_started', data: {
        runtimeTarget: 'wsl', sandboxEnforcement: 'wsl-bubblewrap-v1', networkAccessClaim: 'provider-control-plane-only',
      },
    };
    const heartbeat: AgentEvent = {
      ...processEvent, sequence: 2, kind: 'heartbeat', data: {
        phase: 'initialized', providerVersion: '2.1.232', permissionMode: 'acceptEdits', tools: [],
      },
    };
    expect(checker.processAttestationMatches(claudeRecord, claudeCapabilities, [processEvent, heartbeat])).toBe(true);
    expect(checker.processAttestationMatches(claudeRecord, claudeCapabilities, [processEvent, {
      ...heartbeat, data: { ...heartbeat.data, tools: ['Read'] },
    }])).toBe(false);
  });

  it('attests Codex through its own read-only sandbox identifier without a Claude-style init heartbeat', async () => {
    const value = fixture();
    const started = await value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    const stored = (await value.store.get(started.id))!;
    const checker = value.service as unknown as {
      processAttestationMatches(record: typeof stored, capabilities: AgentCapabilities, events: AgentEvent[]): boolean;
    };
    const codexRecord = { ...stored, provider: {
      id: 'codex-exec', runtimeTarget: 'windows' as const, wslDistribution: undefined,
      version: 'codex-cli 0.147.0', adapterVersion: '1.0.0',
    } };
    // Codex has tools:true (no removal flag) but the server-owned no-tools mode
    // plus its own sandbox identifier stands in for the wsl-bubblewrap boundary.
    const codexCapabilities: AgentCapabilities = {
      ...capabilities(), provider: 'codex-exec', providerVersion: 'codex-cli 0.147.0', adapterVersion: '1.0.0',
      tools: true, supportedRuntimeTargets: ['windows', 'wsl', 'linux', 'darwin'], extensions: {
        externalSandbox: 'codex-cli-sandbox-policy-0.147.0', networkAccessClaim: 'provider-control-plane-only',
        serverOwnedNoToolsMode: 'cv-ai-structuring-v1',
      },
    };
    const processEvent: AgentEvent = {
      schemaVersion: '1.0', runId: stored.agentRunId, sequence: 1, timestamp: stored.createdAt,
      provider: 'codex-exec', correlationId: 'synthetic', kind: 'process_started', data: {
        runtimeTarget: 'windows', sandboxEnforcement: 'codex-cli-sandbox-policy-0.147.0',
        networkAccessClaim: 'provider-control-plane-only',
      },
    };
    // No init heartbeat required for a non-Claude provider.
    expect(checker.processAttestationMatches(codexRecord, codexCapabilities, [processEvent])).toBe(true);
    // A mismatched or absent sandbox identifier fails closed.
    expect(checker.processAttestationMatches(codexRecord, codexCapabilities, [{
      ...processEvent, data: { ...processEvent.data, sandboxEnforcement: 'wsl-bubblewrap-v1' },
    }])).toBe(false);
  });

  it('cancels expired active agent runs before the store may prune them', async () => {
    let current = new Date('2026-08-14T10:00:00.000Z');
    const { service, agentRuns, store } = fixture({ now: () => current });
    const started = await service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    current = new Date('2026-08-14T10:02:00.000Z');
    await service.expireAndPrune(current);
    expect(agentRuns.cancelled).toEqual([agentIds[0]]);
    expect(await store.get(started.id)).toMatchObject({ status: 'cancel_requested', retentionCleanup: {
      cancelAttempts: 1, cancelRequestedAt: current.toISOString(),
    } });
  });

  it('retains metadata on purge failure, reports the sweep failure, and deletes only after a confirmed retry', async () => {
    let current = new Date('2026-08-14T10:00:00.000Z');
    const value = fixture({ now: () => current });
    const started = await value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    current = new Date('2026-08-14T10:02:00.000Z');
    await value.service.expireAndPrune(current);
    vi.mocked(value.purger.deleteRuns).mockRejectedValueOnce(new Error('synthetic_purge_failure'));
    current = new Date('2026-08-14T10:02:01.000Z');
    await expect(value.service.expireAndPrune(current)).rejects.toMatchObject({ code: 'cv_ai_retention_cleanup_incomplete' });
    expect(await value.store.get(started.id)).toBeDefined();
    expect(await value.service.expireAndPrune(current)).toEqual([started.id]);
    expect(await value.store.get(started.id)).toBeUndefined();
  });

  it('uses a hard bounded retention cancel deadline without extending expiresAt indefinitely', async () => {
    let current = new Date('2026-08-14T10:00:00.000Z');
    const value = fixture({ now: () => current }); value.agentRuns.holdCancellation = true;
    const started = await value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    current = new Date('2026-08-14T10:02:00.000Z'); await value.service.expireAndPrune(current);
    const originalExpiry = (await value.store.get(started.id))!.expiresAt;
    current = new Date('2026-08-14T10:02:30.000Z'); await value.service.expireAndPrune(current);
    expect(value.agentRuns.cancelled).toHaveLength(1);
    current = new Date('2026-08-14T10:03:01.000Z'); await value.service.expireAndPrune(current);
    current = new Date('2026-08-14T10:04:02.000Z'); await value.service.expireAndPrune(current);
    current = new Date('2026-08-14T10:05:03.000Z');
    await expect(value.service.expireAndPrune(current)).rejects.toMatchObject({ code: 'cv_ai_retention_cleanup_incomplete' });
    expect(value.agentRuns.cancelled).toHaveLength(3);
    expect(await value.store.get(started.id)).toMatchObject({
      expiresAt: originalExpiry, retentionCleanup: { cancelAttempts: 3 },
    });
  });

  it('runs concurrent retention triggers as one single-flight sweep', async () => {
    let current = new Date('2026-08-14T10:00:00.000Z');
    const value = fixture({ now: () => current }); value.agentRuns.holdCancellation = true;
    await value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    current = new Date('2026-08-14T10:02:00.000Z');
    await Promise.all([value.service.expireAndPrune(current), value.service.expireAndPrune(current)]);
    expect(value.agentRuns.cancelled).toEqual([agentIds[0]]);
  });

  it('cancels and confirmed-purges a recovered orphaned raw run on the next retention sweep', async () => {
    let current = new Date('2026-08-14T10:00:00.000Z');
    const value = fixture({ now: () => current });
    const started = await value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    value.agentRuns.runs.set(agentIds[0]!, { ...value.agentRuns.runs.get(agentIds[0]!)!, state: 'orphaned' });
    current = new Date('2026-08-14T10:02:00.000Z'); await value.service.expireAndPrune(current);
    current = new Date('2026-08-14T10:02:01.000Z');
    expect(await value.service.expireAndPrune(current)).toEqual([started.id]);
    expect(value.purger.deleteRuns).toHaveBeenCalledWith([agentIds[0]]);
  });

  it('cascades import deletion in two phases and waits for an already in-flight start to clean its raw run', async () => {
    const value = fixture();
    const originalEnqueue = value.agentRuns.enqueue.bind(value.agentRuns);
    let release!: () => void; let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(value.agentRuns, 'enqueue').mockImplementationOnce(async (request) => {
      entered(); await barrier; return originalEnqueue(request);
    });
    const starting = value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    await enteredPromise;
    let deleteSettled = false;
    const deleting = value.service.deleteForImport(importId).finally(() => { deleteSettled = true; });
    await Promise.resolve(); expect(deleteSettled).toBe(false);
    release();
    await expect(starting).rejects.toMatchObject({ code: 'cv_import_deletion_in_progress' });
    expect(await deleting).toEqual([]);
    expect(value.agentRuns.runs.size).toBe(0);
    expect(await value.store.listByImport(importId, 1_001)).toEqual([]);
  });

  it('keeps every run metadata record when one raw-run purge in an import-delete cascade fails', async () => {
    const value = fixture();
    await value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    await value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    });
    let purges = 0;
    vi.mocked(value.purger.deleteRuns).mockImplementation(async (ids) => {
      purges += 1;
      if (purges === 2) throw new Error('synthetic_second_purge_failure');
      return ids.map((runId) => {
        value.agentRuns.runs.delete(runId); return { runId, events: 1 };
      });
    });
    await expect(value.service.deleteForImport(importId)).rejects.toMatchObject({ code: 'cv_ai_import_cleanup_failed' });
    expect(await value.store.listByImport(importId, 1_001)).toHaveLength(2);
    expect(await value.service.deleteForImport(importId)).toHaveLength(2);
    expect(await value.store.listByImport(importId, 1_001)).toEqual([]);
  });

  it('cleans an enqueued raw run when metadata creation fails and rejects capacity before enqueue', async () => {
    const failedCreate = fixture();
    vi.spyOn(failedCreate.store, 'create').mockRejectedValueOnce(new Error('synthetic_store_failure'));
    await expect(failedCreate.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    })).rejects.toMatchObject({ code: 'cv_ai_run_store_failed' });
    expect(failedCreate.agentRuns.runs.size).toBe(0);
    expect(failedCreate.purger.deleteRuns).toHaveBeenCalledWith([agentIds[0]]);

    const full = fixture();
    vi.spyOn(full.store, 'assertCanCreate').mockRejectedValueOnce(new Error('cv_ai_import_run_limit'));
    await expect(full.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    })).rejects.toMatchObject({ code: 'cv_ai_run_capacity_exceeded' });
    expect(full.agentRuns.requests).toHaveLength(0);
  });

  it('serializes parallel starts so a newly reached capacity limit creates no second raw run', async () => {
    const value = fixture();
    const originalCheck = value.store.assertCanCreate.bind(value.store); let checks = 0;
    vi.spyOn(value.store, 'assertCanCreate').mockImplementation(async (id) => {
      checks += 1;
      // The next serialized service precheck observes the newly reached limit.
      if (checks === 2) throw new Error('cv_ai_import_run_limit');
      return originalCheck(id);
    });
    const [first, second] = await Promise.allSettled([value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    }), value.service.start({
      cvImportId: importId, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      provider: selection, disclosure, actor,
    })]);
    expect(first.status).toBe('fulfilled'); expect(second.status).toBe('rejected');
    expect(value.agentRuns.requests).toHaveLength(1);
  });
});
