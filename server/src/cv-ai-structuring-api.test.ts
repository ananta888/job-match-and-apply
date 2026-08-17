import { createHash } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentCapabilities, AgentEvent, AgentProviderInstallation, AgentRun, AgentRunRequest, AgentRunnerPort,
} from './ports/agent-runner.js';
import type { CvFact } from './ports/cv-normalization.js';
import { createApp } from './app.js';
import { allowedRootDomainTools } from './agents/agent-domain-tool-policy.js';
import {
  ApplicationPipelineProofAuthority, StaticApplicationPipelineProofKeyProvider,
} from './services/application-pipeline-proof.js';
import { MemoryConfigStore } from './services/config-store.js';
import {
  CvAiStructuringService, type CvAiAgentRunPort, type CvAiStructuringImportPort,
  type CvAiStructuringValidationPort,
} from './services/cv-ai-structuring.js';
import {
  MemoryCvAiStructuringRunStore, type CvAiStructuringSuggestion,
} from './services/cv-ai-structuring-store.js';

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const importId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];
const agentRunIds = [
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];
const sourceTextCanary = 'PRIVATE-CV-SOURCE-CANARY';
const baseArtifactCanary = 'PRIVATE-BASE-ARTIFACT-CANARY';
const validatedArtifactCanary = 'PRIVATE-VALIDATED-ARTIFACT-CANARY';
const lineManifestJson = JSON.stringify({
  contract: 'cv-line-manifest', contract_version: '1.0',
  lines: [{ line: 1, text: sourceTextCanary, sha256: digest(sourceTextCanary) }],
});
const schemaJson = JSON.stringify({
  type: 'object', additionalProperties: false,
  required: ['contract'], properties: { contract: { const: 'ai-cv-structure-proposal' } },
});

const providerSelection = {
  providerId: 'fake', runtimeTarget: 'windows' as const, expectedVersion: 'fake 1.0.0',
};
const disclosure = {
  version: '1.0' as const, confirmed: true as const, sendExtractedCvTextToProvider: true as const,
  acknowledgeProviderControlPlaneNetwork: true as const,
};
const startBody = {
  expectedRevision: 3, expectedSha256: 'a'.repeat(64), provider: providerSelection, disclosure,
};

const suggestion: CvAiStructuringSuggestion = {
  id: 'suggestion-1111111111111111', path: 'employment[0].role', collection: 'experience',
  recordId: 'experience-1111111111111111', field: 'role', category: 'employment', mergeable: true,
  value: 'Synthetic Engineer',
  sourceAnchor: { lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 18, quote: 'Synthetic Engineer' },
  confidence: 0.8, alternatives: [], questions: [], status: 'unverified',
};

function capabilities(): AgentCapabilities {
  return {
    schemaVersion: '1.0', provider: 'fake', providerVersion: 'fake 1.0.0', adapterVersion: '1.0.0',
    protocolVersion: '1.0', streaming: true, resume: false, interactiveInput: false, approvals: false,
    tools: false, images: false, structuredOutput: true, sandboxPolicies: ['read-only'], usage: true,
    supportedRuntimeTargets: ['windows'], extensions: {
      networkControl: true, externalSandbox: 'synthetic-no-tools-v1', networkAccessClaim: 'provider-control-plane-only',
    },
  };
}

function fakeProvider(): AgentRunnerPort {
  const installation: AgentProviderInstallation = {
    provider: 'fake', runtimeTarget: 'windows', executable: 'synthetic-provider', version: 'fake 1.0.0',
    support: 'supported', authStatus: 'not_required', capabilities: capabilities(),
  };
  return {
    provider: 'fake', discover: vi.fn(async () => [installation]), capabilities: vi.fn(async () => capabilities()),
    start: vi.fn(), sendInput: vi.fn(), resolveApproval: vi.fn(), cancel: vi.fn(), resume: vi.fn(), dispose: vi.fn(),
  } as unknown as AgentRunnerPort;
}

class FakeAgentRuns implements CvAiAgentRunPort {
  readonly requests: AgentRunRequest[] = [];
  readonly runs = new Map<string, AgentRun>();
  readonly runEvents = new Map<string, AgentEvent[]>();
  readonly cancelled: string[] = [];

  async enqueue(input: AgentRunRequest): Promise<AgentRun> {
    const id = agentRunIds[this.requests.length]!;
    this.requests.push(structuredClone(input));
    const run: AgentRun = {
      schemaVersion: '1.0', id, provider: input.provider, state: 'queued', request: structuredClone(input),
      capabilities: capabilities(),
      requestedAt: '2026-08-14T10:00:00.000Z', updatedAt: '2026-08-14T10:00:00.000Z', currentSequence: 0,
    };
    this.runs.set(id, run);
    return structuredClone(run);
  }

  async get(id: string): Promise<AgentRun | undefined> {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : undefined;
  }

  async events(id: string): Promise<AgentEvent[]> {
    return structuredClone(this.runEvents.get(id) ?? []);
  }

  async cancel(id: string): Promise<void> {
    this.cancelled.push(id);
  }

  finish(id: string, state: 'cancelled' | 'succeeded', output?: string): void {
    const current = this.runs.get(id)!;
    this.runs.set(id, {
      ...current, state, updatedAt: '2026-08-14T10:00:10.000Z', finishedAt: '2026-08-14T10:00:10.000Z',
    });
    if (output !== undefined) {
      this.runEvents.set(id, [{
        schemaVersion: '1.0', runId: id, sequence: 1, timestamp: '2026-08-14T10:00:09.000Z',
        provider: 'fake', correlationId: 'synthetic-event', kind: 'process_started', data: {
          runtimeTarget: 'windows', sandboxEnforcement: 'synthetic-no-tools-v1', networkAccessClaim: 'provider-control-plane-only',
        },
      }, {
        schemaVersion: '1.0', runId: id, sequence: 2, timestamp: '2026-08-14T10:00:10.000Z',
        provider: 'fake', correlationId: 'synthetic-event', kind: 'agent_message_completed', data: { text: output },
      }]);
    }
  }
}

function fixture() {
  const store = new MemoryCvAiStructuringRunStore();
  const agentRuns = new FakeAgentRuns();
  const baseProposalArtifact = { contract: 'cv-import-proposal', privateCanary: baseArtifactCanary };
  let committedStage: { revision: number; sha256: string; facts: CvFact[] } | undefined;
  const imports: CvAiStructuringImportPort = {
    loadAiSource: vi.fn(async (id) => id === importId ? {
      id: importId, revision: 3, sha256: 'a'.repeat(64), sourceId: 'source-cv-aaaaaaaaaaaaaaaa',
      sourceSha256: 'b'.repeat(64), extractedTextSha256: 'c'.repeat(64), baseProposalSha256: 'd'.repeat(64),
      baseProposalArtifact, lineManifestJson, lineManifestSha256: digest(lineManifestJson),
      deterministicRecognitionVersionId: 'recognition-aaaaaaaaaaaaaaaa',
    } : undefined),
    findAiStage: vi.fn(async () => committedStage ? structuredClone(committedStage) : undefined),
    stageAiStructure: vi.fn(async (input) => {
      committedStage = { revision: 4, sha256: '9'.repeat(64), facts: input.facts.map((fact: CvFact) => ({
        ...structuredClone(fact), provenance: { ...structuredClone(fact.provenance), recognition: {
          ...structuredClone(fact.provenance.recognition!), runId: input.runId, proposalSha256: input.aiProposalSha256,
        } },
      })) };
      return { revision: 4, sha256: '9'.repeat(64), stagedFactIds: committedStage.facts.map((fact) => fact.id) };
    }),
    createAiRecognitionVersion: vi.fn(async (input) => ({
      revision: 4, sha256: '9'.repeat(64), recognitionVersionId: 'recognition-bbbbbbbbbbbbbbbb',
      recognitionVersionCount: 2, factIds: input.facts.map((fact: CvFact) => fact.id),
    })),
  };
  const facts: CvFact[] = [{
    id: 'fact-1111111111111111', category: 'employment', recordId: 'experience-1111111111111111',
    field: 'role', value: 'Synthetic Engineer', decision: 'pending',
    provenance: { sourceSha256: 'b'.repeat(64), anchor: 'ai:suggestion-1111111111111111', origin: 'imported', recognition: {
      method: 'ai_assisted', suggestionId: suggestion.id,
      sourceSpan: { lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 18 },
    } },
  }];
  const validation: CvAiStructuringValidationPort = {
    contract: vi.fn(async () => ({
      outputContract: 'ai-cv-structure-proposal' as const, outputContractVersion: '1.0' as const,
      outputSchemaJson: schemaJson, outputSchemaSha256: digest(schemaJson),
    })),
    validateProposal: vi.fn(async () => ({
      contract: 'validated-ai-cv-structure-proposal' as const, contractVersion: '1.0' as const,
      status: 'unverified' as const,
      binding: {
        sourceId: 'source-cv-aaaaaaaaaaaaaaaa', sourceSha256: 'b'.repeat(64),
        extractedTextSha256: 'c'.repeat(64), baseProposalSha256: 'd'.repeat(64),
      },
      proposalSha256: 'e'.repeat(64), suggestions: [suggestion],
      privateArtifact: { privateCanary: validatedArtifactCanary },
    })),
    applySelections: vi.fn(async () => ({
      mergedArtifact: { contract: 'cv-import-proposal', merged: true },
      mergedProposalSha256: '8'.repeat(64), facts,
      appliedSuggestionIds: [suggestion.id],
    })),
    materializeRecognitionVersion: vi.fn(async () => ({
      materializedArtifact: { contract: 'cv-import-proposal', materialized: true },
      materializedProposalSha256: '7'.repeat(64), facts,
      warnings: [], unresolvedConflicts: [],
      appliedSuggestionIds: [suggestion.id],
    })),
  };
  let idIndex = 0;
  const service = new CvAiStructuringService({
    store, imports, validation, agentRuns, purger: {
      deleteRuns: vi.fn(async (ids: readonly string[]) => ids.map((runId) => ({ runId, events: 1 }))),
    },
    providers: [fakeProvider()],
    configProfiles: { load: async () => ({ profile: {
      schemaVersion: 3, profileId: 'cv-ai-api-test', updatedAt: '2026-08-14T09:00:00.000Z',
      providers: [{
        provider: 'fake', enabled: true, runtimeTarget: 'windows', sandbox: 'read-only',
        network: 'disabled', approvalMode: 'deny',
      }],
      budgets: { warningAtPercent: 80, maxRunDurationMs: 60_000 },
      features: {
        multiAgentExperimental: true,
        realtimeWebSocketExperimental: false, rawProviderLogs: false,
      },
    }, source: 'primary' as const }) },
    workspaceRoot: '.application-work/cv-ai-structuring-api-test',
    now: () => new Date('2026-08-14T10:00:00.000Z'), id: () => runIds[idIndex++]!, runTtlMs: 60_000,
    allowSyntheticProviders: true,
  });
  const app = createApp(new MemoryConfigStore(), undefined, undefined, undefined, undefined, {
    proofAuthority: new ApplicationPipelineProofAuthority(
      new StaticApplicationPipelineProofKeyProvider(Buffer.alloc(32, 23)),
    ),
    workRoot: '.application-work', cvAiStructuring: service,
  });
  return { app, agentRuns, imports, validation };
}

function assertPublicRun(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain('agentRunId');
  expect(serialized).not.toContain('privateArtifact');
  expect(serialized).not.toContain(baseArtifactCanary);
  expect(serialized).not.toContain(validatedArtifactCanary);
}

describe('CV AI structuring API', () => {
  it('returns no-store, data-minimized options and keeps every Root/Job-Search MCP allowlist empty', async () => {
    const { app } = fixture();
    const response = await request(app)
      .get(`/api/cv-imports/${importId}/ai-structuring/options`)
      .query({ expectedRevision: 3, expectedSha256: 'a'.repeat(64) })
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      contract: 'cv-ai-structuring-options', contractVersion: '1.0',
      disclosure: {
        required: true, extractedCvTextSentToSelectedProvider: true, toolNetwork: 'disabled',
        rootMcpTools: [], jobSearchMcpAccessible: false,
        providerControlPlane: 'provider_managed_may_use_network',
      },
      providers: [{ installations: [{
        ready: true, network: { toolNetwork: 'disabled', rootMcpTools: [], jobSearchMcpAccessible: false },
      }] }],
    });
    expect(JSON.stringify(response.body)).not.toContain(sourceTextCanary);
    expect(JSON.stringify(response.body)).not.toContain(lineManifestJson);
    expect(JSON.stringify(response.body)).not.toContain(baseArtifactCanary);
    expect(allowedRootDomainTools({ metadata: { workflowId: 'cv-ai-structuring' } })).toEqual([]);
  });

  it('requires literal disclosure, rejects caller-owned actor fields, and starts with the server-owned local actor', async () => {
    const { app, agentRuns } = fixture();
    await request(app).post(`/api/cv-imports/${importId}/ai-structuring/runs`).send({
      ...startBody, disclosure: { ...disclosure, confirmed: false },
    }).expect(400);
    await request(app).post(`/api/cv-imports/${importId}/ai-structuring/runs`).send({
      ...startBody, actor: { id: 'attacker-controlled', type: 'authenticated' },
    }).expect(400);

    const response = await request(app)
      .post(`/api/cv-imports/${importId}/ai-structuring/runs`)
      .set('x-correlation-id', 'cv-ai-start-correlation')
      .send(startBody)
      .expect(202);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      status: 'queued', disclosure: {
        confirmedBy: { id: 'local-user', type: 'local' }, extractedCvTextShared: true,
        toolNetwork: 'disabled', rootMcpTools: [], jobSearchMcpAccessible: false,
      },
    });
    expect(agentRuns.requests).toHaveLength(1);
    expect(agentRuns.requests[0]).toMatchObject({
      sandbox: 'read-only', network: 'disabled', approvalMode: 'deny',
      metadata: {
        workflowId: 'cv-ai-structuring', requiredRootMcpTools: [], providerToolMode: 'none', ownerId: 'local-user',
        correlationId: 'cv-ai-start-correlation',
      },
    });
    expect(allowedRootDomainTools(agentRuns.requests[0]!)).toEqual([]);
    assertPublicRun(response.body);
  });

  it('keeps all mutation bodies closed before invoking the structuring service', async () => {
    const { app, agentRuns } = fixture();
    const runId = runIds[0]!;
    const runCas = { expectedRunRevision: 1, expectedRunSha256: 'f'.repeat(64) };
    const requests = [
      request(app).post(`/api/cv-imports/${importId}/ai-structuring/runs`).send({ ...startBody, unexpected: true }),
      request(app).post(`/api/cv-imports/${importId}/ai-structuring/runs/${runId}/cancel`).send({
        ...runCas, confirmed: true, unexpected: true,
      }),
      request(app).post(`/api/cv-imports/${importId}/ai-structuring/runs/${runId}/retry`).send({
        ...runCas, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
        provider: providerSelection, disclosure, unexpected: true,
      }),
      request(app).post(`/api/cv-imports/${importId}/ai-structuring/runs/${runId}/apply`).send({
        ...runCas, expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
        selections: [{ suggestionId: suggestion.id, alternativeId: null }], confirmed: true, unexpected: true,
      }),
    ];
    for (const pending of requests) await pending.expect(400);
    expect(agentRuns.requests).toHaveLength(0);
  });

  it('lists and gets only public suggestion DTOs without the agent ID or validator-private artifact', async () => {
    const { app, agentRuns } = fixture();
    const started = await request(app)
      .post(`/api/cv-imports/${importId}/ai-structuring/runs`).send(startBody).expect(202);
    agentRuns.finish(agentRunIds[0]!, 'succeeded', '{"contract":"ai-cv-structure-proposal"}');

    const fetched = await request(app)
      .get(`/api/cv-imports/${importId}/ai-structuring/runs/${started.body.id}`).expect(200);
    expect(fetched.headers['cache-control']).toBe('no-store');
    expect(fetched.body).toMatchObject({
      status: 'suggestions_ready', proposal: { sha256: 'e'.repeat(64), suggestions: [suggestion] },
    });
    assertPublicRun(fetched.body);

    const listed = await request(app)
      .get(`/api/cv-imports/${importId}/ai-structuring/runs`).query({ limit: 1 }).expect(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ id: started.body.id, status: 'suggestions_ready' });
    assertPublicRun(listed.body);
  });

  it('accepts the simple replacement mode and returns an applied recognition-version witness without suggestion review', async () => {
    const { app, agentRuns, imports } = fixture();
    const started = await request(app)
      .post(`/api/cv-imports/${importId}/ai-structuring/runs`)
      .send({ ...startBody, mode: 'replace_with_ai_version' })
      .expect(202);
    expect(started.body).toMatchObject({ mode: 'replace_with_ai_version', status: 'queued' });
    expect(agentRuns.requests[0]?.metadata).toMatchObject({
      cvAiStructuringMode: 'replace_with_ai_version', requiredRootMcpTools: [], providerToolMode: 'none',
    });
    agentRuns.finish(agentRunIds[0]!, 'succeeded', '{"contract":"ai-cv-structure-proposal"}');

    const applied = await request(app)
      .get(`/api/cv-imports/${importId}/ai-structuring/runs/${started.body.id}`)
      .expect(200);

    expect(applied.body).toMatchObject({
      mode: 'replace_with_ai_version', status: 'applied',
      result: {
        recognitionVersionId: 'recognition-bbbbbbbbbbbbbbbb', recognitionVersionCount: 2,
        factsRemainPending: true,
      },
    });
    expect(applied.body).not.toHaveProperty('proposal');
    expect(imports.createAiRecognitionVersion).toHaveBeenCalledTimes(1);
    assertPublicRun(applied.body);
  });

  it('enforces run/import CAS for cancel, retry and apply while staging only pending facts', async () => {
    const { app, agentRuns, imports, validation } = fixture();
    const started = await request(app)
      .post(`/api/cv-imports/${importId}/ai-structuring/runs`).send(startBody).expect(202);

    const staleCancel = await request(app)
      .post(`/api/cv-imports/${importId}/ai-structuring/runs/${started.body.id}/cancel`)
      .set('x-correlation-id', 'cv-ai-cas-correlation')
      .send({ expectedRunRevision: started.body.revision, expectedRunSha256: '0'.repeat(64), confirmed: true })
      .expect(409);
    expect(staleCancel.headers['x-correlation-id']).toBe('cv-ai-cas-correlation');
    expect(staleCancel.body).toMatchObject({
      status: 409, category: 'policy', errorCode: 'cv_ai_run_sha_conflict', stage: 'preflight',
      retryable: false, correlationId: 'cv-ai-cas-correlation',
    });
    expect(JSON.stringify(staleCancel.body)).not.toContain(sourceTextCanary);

    const cancelRequested = await request(app)
      .post(`/api/cv-imports/${importId}/ai-structuring/runs/${started.body.id}/cancel`)
      .send({
        expectedRunRevision: started.body.revision, expectedRunSha256: started.body.sha256, confirmed: true,
      }).expect(200);
    expect(cancelRequested.body.status).toBe('cancel_requested');
    agentRuns.finish(agentRunIds[0]!, 'cancelled');
    const cancelled = await request(app)
      .get(`/api/cv-imports/${importId}/ai-structuring/runs/${started.body.id}`).expect(200);
    expect(cancelled.body.status).toBe('cancelled');

    await request(app)
      .post(`/api/cv-imports/${importId}/ai-structuring/runs/${cancelled.body.id}/retry`)
      .send({
        expectedRunRevision: cancelled.body.revision, expectedRunSha256: cancelled.body.sha256,
        expectedCvImportRevision: 3, expectedCvImportSha256: '0'.repeat(64),
        provider: providerSelection, disclosure,
      }).expect(409);
    const retried = await request(app)
      .post(`/api/cv-imports/${importId}/ai-structuring/runs/${cancelled.body.id}/retry`)
      .send({
        expectedRunRevision: cancelled.body.revision, expectedRunSha256: cancelled.body.sha256,
        expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
        provider: providerSelection, disclosure,
      }).expect(202);
    expect(retried.body).toMatchObject({ status: 'queued', attempt: 2, retryOf: cancelled.body.id });

    agentRuns.finish(agentRunIds[1]!, 'succeeded', '{"contract":"ai-cv-structure-proposal"}');
    const ready = await request(app)
      .get(`/api/cv-imports/${importId}/ai-structuring/runs/${retried.body.id}`).expect(200);
    expect(ready.body.status).toBe('suggestions_ready');
    await request(app)
      .post(`/api/cv-imports/${importId}/ai-structuring/runs/${ready.body.id}/apply`)
      .send({
        expectedRunRevision: ready.body.revision + 1, expectedRunSha256: ready.body.sha256,
        expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
        selections: [{ suggestionId: suggestion.id, alternativeId: null }], confirmed: true,
      }).expect(409);
    const applied = await request(app)
      .post(`/api/cv-imports/${importId}/ai-structuring/runs/${ready.body.id}/apply`)
      .send({
        expectedRunRevision: ready.body.revision, expectedRunSha256: ready.body.sha256,
        expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
        selections: [{ suggestionId: suggestion.id, alternativeId: null }], confirmed: true,
      }).expect(200);

    expect(applied.body).toMatchObject({
      status: 'applied', result: {
        cvImportRevision: 4, stagedFactIds: ['fact-1111111111111111'], factsRemainPending: true,
      },
    });
    expect(validation.applySelections).toHaveBeenCalledWith(expect.objectContaining({
      expectedBaseProposalSha256: 'd'.repeat(64), expectedAiProposalSha256: 'e'.repeat(64),
      selections: [{ suggestionId: suggestion.id, alternativeId: null }],
    }));
    expect(imports.stageAiStructure).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 3, expectedSha256: 'a'.repeat(64),
      facts: [expect.objectContaining({ decision: 'pending' })],
    }));
    assertPublicRun(applied.body);
  });
});
