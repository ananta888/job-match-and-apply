import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function fixture(name: string): Promise<Record<string, unknown>> {
  const path = resolve(process.cwd(), '..', 'contracts', 'fixtures', 'v1', name);
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

async function contract(name: string): Promise<Record<string, unknown>> {
  const path = resolve(process.cwd(), '..', 'contracts', 'v1', name);
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

describe('cross-repository contract fixtures', () => {
  it('pins the additive job-search v1 envelope with synthetic provenance', async () => {
    const value = await fixture('synthetic-job-search.json');
    expect(value).toMatchObject({ contract: 'job-search-mcp', contract_version: '1.0' });
    const offer = (value.angebote as Array<Record<string, unknown>>)[0]!;
    expect(offer.source_reference).toEqual({
      source_id: 'synthetic-feed', external_id: 'offline-1',
      url: 'https://example.invalid/jobs/offline-1', fetched_at: '2026-01-01T00:00:00Z'
    });
    expect(offer).toMatchObject({ id: 'synthetic-1', normalization_warnings: [] });
    expect(JSON.stringify(value)).toContain('example.invalid');
  });

  it('pins the application-pipeline v1 status without private content', async () => {
    const value = await fixture('synthetic-pipeline-status.json');
    expect(value).toEqual({
      contract: 'bewerbungs-pipeline', contract_version: '1.0', run_id: 'synthetic-run',
      state: 'analysis', artifacts: ['job-analysis.yaml']
    });
  });

  it('pins the closed Root application audit to the v1 submodule and non-executable adoption route', async () => {
    const [schema, value] = await Promise.all([
      contract('application-pipeline-root-proxy.schema.json'),
      fixture('synthetic-application-pipeline-audit.json'),
    ]);
    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
    });
    expect(schema.required).toEqual(expect.arrayContaining([
      'applicationCaseRevision', 'sourceVersion', 'jobAnalysis', 'matchMatrix', 'validation', 'finalization',
    ]));
    expect(value).toMatchObject({
      contract: 'application-pipeline-root-proxy', contractVersion: '1.0',
      upstream: { contract: 'bewerbungs-pipeline', contractVersion: '1.0', networkRequired: false },
      validation: { valid: true, errors: [] },
      finalization: {
        executable: false, route: 'approved-artifact-review-adoption',
        proofContract: 'application-pipeline-proof@1.0',
      },
    });
    expect(JSON.stringify(value)).not.toMatch(/candidateProfilePath|styleProfilePath|annotatedContent|iterationManifest|pipelineProof|finalize/i);
  });

  it('pins a provider-neutral agent run with ordered synthetic events', async () => {
    const value = await fixture('synthetic-agent-run.json');
    expect(value).toMatchObject({ contract: 'agent-control-api', contract_version: '1.0' });
    const events = value.events as Array<{ sequence: number; kind: string }>;
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.at(-1)?.kind).toBe('run_completed');
    expect(JSON.stringify(value)).not.toMatch(/@gmail\.com|sk-[A-Za-z0-9]/);
  });

  it('publishes additive run, event and provider-manifest schemas', async () => {
    const [run, event, manifest, artifact] = await Promise.all([
      contract('agent-run.schema.json'),
      contract('agent-event.schema.json'),
      contract('agent-provider-manifest.schema.json'),
      contract('agent-artifact.schema.json')
    ]);
    expect(run).toMatchObject({ type: 'object', additionalProperties: true });
    expect(event).toMatchObject({ type: 'object', additionalProperties: true });
    expect(manifest).toMatchObject({ type: 'object', additionalProperties: false });
    expect((event.required as string[])).toContain('sequence');
    expect((manifest.required as string[])).toContain('argumentTemplate');
    expect((artifact.required as string[])).toEqual(expect.arrayContaining(['sha256', 'revision', 'provenance']));
  });

  it('pins Codex App Server 0.147.0 to the server-owned offline launch contract', async () => {
    const manifest = await contract('codex-app-server-manifest.json');
    expect(manifest).toMatchObject({
      adapter: 'codex-app-server',
      testedVersionRanges: ['=0.147.0'],
      argumentTemplate: [
        'app-server', '--strict-config',
        '-c', 'sandbox_workspace_write.network_access=false',
        '-c', 'web_search="disabled"',
        '--listen', 'stdio://'
      ],
      networkControl: true,
      offlineConfigOverrides: [
        'sandbox_workspace_write.network_access=false',
        'web_search="disabled"'
      ],
      webSearch: 'disabled',
      sandboxNetworkAccess: false,
      networkEnforcement: 'codex-cli-0.147.0-fixed-offline-config-v1',
      networkAccessClaim: 'provider-control-plane-only'
    });
  });

  it('publishes the closed, versioned trusted-host job-search launch schema', async () => {
    const launch = await contract('job-search-mcp-launch.schema.json');
    expect(launch).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false
    });
    expect(launch.required as string[]).toEqual(expect.arrayContaining([
      'contractVersion', 'executionIsolation', 'runtimeTarget', 'command', 'args', 'env'
    ]));
    expect((launch.properties as Record<string, Record<string, unknown>>).contractVersion).toEqual({ const: '1.0' });
    expect((launch.properties as Record<string, Record<string, unknown>>).executionIsolation).toEqual({ const: 'trusted-host' });
    expect(launch.oneOf).toHaveLength(2);
  });

  it('publishes a closed preflight contract with an exact Root domain-tool allowlist', async () => {
    const preflight = await contract('agent-run-preflight.schema.json');
    expect(preflight).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false
    });
    const properties = preflight.properties as Record<string, Record<string, unknown>>;
    expect((properties.network!.properties as Record<string, unknown>).effective).toEqual({ const: 'disabled' });
    expect((properties.tools!.properties as Record<string, { items?: { enum?: string[] }; maxItems?: number }>).allowedRootMcpTools)
      .toMatchObject({ type: 'array', maxItems: 15, uniqueItems: true, items: { enum: expect.arrayContaining(['jobs.search', 'job_search.capabilities', 'job_search.search', 'companies.get', 'application.tracking.list', 'messages.list', 'application.pipeline.audit', 'reminder.propose', 'document.revision.propose']) } });
  });

  it('publishes closed orchestration and artifact-adoption contracts', async () => {
    const [orchestration, adoption] = await Promise.all([
      contract('application-agent-orchestration.schema.json'),
      contract('agent-artifact-adoption.schema.json')
    ]);
    expect(orchestration).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false
    });
    const properties = orchestration.properties as Record<string, Record<string, unknown>>;
    expect(properties.producesSuggestionsOnly).toEqual({ const: true });
    expect(properties.promptSha256).toEqual({ $ref: '#/$defs/sha256' });
    expect(properties.nodes).toMatchObject({ type: 'array', minItems: 1, maxItems: 32 });
    expect(adoption).toMatchObject({ type: 'object', additionalProperties: false });
    expect(adoption.required).toEqual(['artifact', 'documentRevisionId']);
  });

  it('publishes a closed, local-only editable style-profile contract', async () => {
    const style = await contract('application-style-profile.schema.json');
    expect(style).toMatchObject({ type: 'object', additionalProperties: false });
    const properties = style.properties as Record<string, Record<string, unknown>>;
    expect(properties.languageBackend).toMatchObject({ type: 'object', additionalProperties: false });
    expect((properties.languageBackend!.properties as Record<string, unknown>)).toMatchObject({
      backend: { const: 'nspell' }, localOnly: { const: true }, remoteServiceAllowed: { const: false }
    });
    expect(JSON.stringify(style)).not.toContain('local_server');
  });

  it('publishes a fail-closed provider support and upgrade policy', async () => {
    const support = await contract('agent-provider-support.json') as {
      unknownVersionPolicy: string;
      securityDefaultChangePolicy: string;
      deprecation: { minimumNoticeDays: number };
      providers: Array<{ id: string; status: string; testedVersionPatterns: string[]; fixture: string }>;
      upgradeChecklist: string[];
    };
    expect(support.unknownVersionPolicy).toBe('block');
    expect(support.securityDefaultChangePolicy).toContain('explicit_contract_major');
    expect(support.deprecation.minimumNoticeDays).toBeGreaterThanOrEqual(90);
    expect(support.providers.find((provider) => provider.id === 'codex-exec')).toEqual(expect.objectContaining({
      testedVersionPatterns: ['^(?:codex-cli|codex)\\s+0\\.147\\.0$'],
      networkControl: true,
      offlineConfigOverrides: [
        'sandbox_workspace_write.network_access=false',
        'web_search="disabled"'
      ],
      networkEnforcement: 'codex-cli-0.147.0-fixed-offline-config-v1',
      networkAccessClaim: 'provider-control-plane-only'
    }));
    for (const provider of support.providers) {
      await expect(readFile(resolve(process.cwd(), '..', provider.fixture), 'utf8')).resolves.toContain('{');
      if (provider.status === 'blocked_pending_conformance') expect(provider.testedVersionPatterns).toEqual([]);
    }
    expect(support.upgradeChecklist).toEqual(expect.arrayContaining([
      'verify_sandbox_and_network_effective_policy',
      'verify_approval_defaults_unchanged',
      'run_secret_pii_canaries'
    ]));
  });

  it('publishes a synthetic, versioned cross-provider quality gold contract', async () => {
    const [schema, gold] = await Promise.all([
      contract('agent-quality-eval.schema.json'), fixture('synthetic-agent-quality-gold.json')
    ]);
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(gold).toMatchObject({ contract: 'agent-quality-gold', contractVersion: '1.0', containsRealPersonalData: false });
    expect(new Set((gold.cases as Array<{ category: string }>).map((entry) => entry.category)))
      .toEqual(new Set(['job', 'claim', 'mail', 'appointment', 'document']));
  });
});
