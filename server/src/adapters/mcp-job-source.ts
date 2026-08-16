import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AppConfig, JobPosting, JobSourceCapabilities, SearchProfile, SourceStatus } from '../domain/models.js';
import type { JobSourcePort, LoginResult } from '../ports/job-source.js';
import { launchFromMcpSettings, validateJobSearchMcpRuntime } from '../services/job-search-mcp-launch.mjs';

type McpSettings = AppConfig['mcp'];

const JOB_MCP_BASE_ENVIRONMENT_KEYS = [
  'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'LANG', 'LC_ALL', 'PATH', 'Path'
] as const;

/** Portal credentials stay in the upstream store; unrelated server secrets are not inherited. */
export function buildTrustedHostMcpEnvironment(explicit: Readonly<Record<string, string>>, host: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of JOB_MCP_BASE_ENVIRONMENT_KEYS) if (host[key] !== undefined) environment[key] = host[key]!;
  for (const [key, value] of Object.entries(explicit)) environment[key] = value;
  return environment;
}

/**
 * Job search owns browser sessions, portal login and outbound portal access.
 * It therefore runs as an explicitly trusted stdio host service and must never
 * inherit an agent/container sandbox wrapper. This is separate from the agent
 * provider sandbox policy.
 */
export function assertTrustedHostMcpLaunch(settings: McpSettings): void {
  launchFromMcpSettings(settings as unknown as Record<string, unknown>, resolve(process.cwd(), '..'));
}

export interface McpRuntimeStatus {
  contract: 'job-search-mcp-runtime-status';
  contractVersion: '1.0';
  mode: 'stdio';
  state: 'ready_to_connect' | 'invalid';
  runtimeTarget?: 'windows' | 'wsl';
  distribution?: string;
  launchValidated: boolean;
  /** Launch validation is not protocol connectivity; /api/sources proves the latter. */
  connected: false;
  note: string;
}

export async function inspectTrustedHostMcpRuntime(
  settings: McpSettings,
  projectRoot = resolve(process.cwd(), '..'),
  dependencies: Parameters<typeof validateJobSearchMcpRuntime>[1] = { projectRoot }
): Promise<McpRuntimeStatus> {
  try {
    const launch = launchFromMcpSettings(settings as unknown as Record<string, unknown>, projectRoot);
    const validated = await validateJobSearchMcpRuntime(launch, { ...dependencies, projectRoot });
    return {
      contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'stdio',
      state: 'ready_to_connect', runtimeTarget: validated.runtimeTarget,
      ...(validated.distribution ? { distribution: validated.distribution } : {}),
      launchValidated: true, connected: false,
      note: 'Direkter trusted-host-Startpfad und Integration-Venv sind validiert; eine MCP-Protokollverbindung wurde noch nicht hergestellt.'
    };
  } catch (error) {
    return {
      contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'stdio',
      state: 'invalid', launchValidated: false, connected: false,
      note: error instanceof Error ? error.message.slice(0, 240) : 'job_search_mcp_runtime_invalid'
    };
  }
}

function parseToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) {
    throw new Error('Der MCP lieferte kein direktes Werkzeugergebnis. Asynchrone MCP-Tasks werden noch nicht unterstützt.');
  }
  const text = result.content
    .filter((item): item is { type: 'text'; text: string } => Boolean(item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string'))
    .map((item: { text: string }) => item.text)
    .join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}

export function normalizeMcpJob(raw: Record<string, unknown>, index: number): JobPosting {
  const rawReference = raw.source_reference;
  const reference = rawReference && typeof rawReference === 'object' && !Array.isArray(rawReference)
    ? rawReference as Record<string, unknown>
    : {};
  const model = String(raw.arbeitsmodell ?? '').toLocaleLowerCase('de-DE');
  const workModel = model.includes('remote') ? 'remote' : model.includes('hybrid') ? 'hybrid' : model.includes('onsite') || model.includes('vor ort') ? 'onsite' : 'unknown';
  const topLevelUrl = typeof raw.link === 'string' ? raw.link : typeof raw.url === 'string' ? raw.url : undefined;
  const sourceId = String(reference.source_id ?? raw.source_id ?? raw.portal ?? 'mcp');
  const externalId = String(reference.external_id ?? raw.external_id ?? raw.id ?? topLevelUrl ?? `mcp-${index}`);
  const id = String(raw.id ?? externalId);
  const fetchedAt = typeof raw.fetched_at === 'string' ? raw.fetched_at : new Date().toISOString();
  const referenceFetchedAt = typeof reference.fetched_at === 'string' ? reference.fetched_at : fetchedAt;
  const referenceUrl = typeof reference.url === 'string' ? reference.url : topLevelUrl;
  return {
    id,
    sourceId,
    title: String(raw.titel ?? ''),
    company: String(raw.firma ?? raw.unternehmen ?? ''),
    location: String(raw.ort ?? ''),
    workModel,
    employmentType: ['full_time', 'part_time', 'contract', 'freelance', 'internship'].includes(String(raw.beschaeftigungsart))
      ? String(raw.beschaeftigungsart) as JobPosting['employmentType'] : 'unknown',
    description: String(raw.beschreibung ?? ''),
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : [],
    salaryMin: typeof raw.gehalt_min === 'number' ? raw.gehalt_min : undefined,
    salaryMax: typeof raw.gehalt_max === 'number' ? raw.gehalt_max : undefined,
    url: topLevelUrl,
    fetchedAt,
    sourceReferences: [{ sourceId, externalId, url: referenceUrl, fetchedAt: referenceFetchedAt }],
    normalizationWarnings: Array.isArray(raw.normalization_warnings) ? raw.normalization_warnings.map(String) : []
  };
}

function major(version: string): number { return Number.parseInt(version.split('.')[0] ?? '', 10); }

export class McpJobSourceAdapter implements JobSourcePort {
  constructor(private readonly settings: McpSettings) {}

  private async call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const launch = launchFromMcpSettings(this.settings as unknown as Record<string, unknown>, resolve(process.cwd(), '..'));
    const validated = await validateJobSearchMcpRuntime(launch, { projectRoot: resolve(process.cwd(), '..') });
    const transport = new StdioClientTransport({
      command: validated.command,
      args: validated.args,
      env: buildTrustedHostMcpEnvironment(validated.env)
    });
    const client = new Client({ name: 'job-match-and-apply', version: '0.1.0' });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name, arguments: args }, undefined, timeoutMs ? { timeout: timeoutMs } : undefined);
      if ('isError' in result && result.isError) throw new Error(`MCP-Werkzeug ${name} meldete einen Fehler.`);
      return parseToolResult(result);
    } finally {
      await client.close();
    }
  }

  async capabilities(): Promise<JobSourceCapabilities> {
    const result = await this.call('capabilities', {}) as Record<string, unknown>;
    const contractVersion = String(result.contract_version ?? '0');
    const compatible = result.contract === 'job-search-mcp' && major(contractVersion) === 1;
    const sources = Array.isArray(result.sources) ? result.sources as Record<string, unknown>[] : [];
    return {
      contract: 'job-search-mcp', contractVersion, compatible,
      tools: Array.isArray(result.tools) ? result.tools.map(String) : [],
      errorCategories: Array.isArray(result.error_categories) ? result.error_categories.map(String) : [],
      sources: sources.map((source) => ({
        id: String(source.id), name: String(source.name), enabled: Boolean(source.enabled), access: String(source.access ?? 'unknown'),
        supportsLogin: Boolean(source.supports_login), loginRequiredForSearch: Boolean(source.login_required_for_search),
        filters: Array.isArray(source.filters) ? source.filters.map(String) : [], pagination: Boolean(source.pagination),
        policyStatus: String(source.policy_status ?? 'unknown')
        ,contractVersion: String(source.contract_version ?? contractVersion),
        compatible: major(String(source.contract_version ?? contractVersion)) === 1
      }))
    };
  }

  async statuses(): Promise<SourceStatus[]> {
    // The source catalog comes from the fast `capabilities` tool and must always
    // populate the list. The live `browser_status` probe can be slow (it inspects
    // the visible-login driver), so it is best-effort behind a short timeout: a
    // failure or timeout still returns every configured source, just without the
    // live driver/session overlay, instead of hanging or returning an empty list.
    const capabilities = await this.capabilities();
    let statusById = new Map<string, Record<string, unknown>>();
    let liveProbe = false;
    try {
      const result = await this.call('browser_status', {}, 4_000) as Record<string, unknown>;
      const portals = Array.isArray(result.portale) ? result.portale as Record<string, unknown>[] : [];
      statusById = new Map(portals.map((portal) => [String(portal.portal_id), portal]));
      liveProbe = true;
    } catch { /* Live driver status unavailable; report the catalog with unknown live status. */ }
    return capabilities.sources.filter((source) => source.enabled).map((source) => {
      const portal = statusById.get(source.id);
      return {
      id: source.id,
      name: source.name,
      kind: 'mcp',
      enabled: source.enabled,
      connected: source.supportsLogin ? Boolean(portal?.treiber_verfuegbar) : true,
      supportsLogin: source.supportsLogin,
      sessionAvailable: Boolean(portal?.sitzung_vorhanden),
      note: Array.isArray(portal?.anmerkungen) ? portal.anmerkungen.map(String).join(' ')
        : liveProbe ? `${source.access}; Policy: ${source.policyStatus}`
        : `${source.access}; Policy: ${source.policyStatus} · Live-Status derzeit nicht verfügbar`
    }; });
  }

  async search(profile: SearchProfile): Promise<JobPosting[]> {
    return (await this.searchDetailed(profile)).jobs;
  }

  async searchDetailed(profile: SearchProfile): Promise<{ jobs: JobPosting[]; failures: Array<{ sourceId: string; category: string; retryable: boolean; detail: string }> }> {
    const result = await this.call('mehrportal_suche', {
      portal_ids: profile.sourceIds.filter((id) => id !== 'linkedin-profile'),
      query: profile.query,
      ort: profile.regions[0] ?? null
    }) as Record<string, unknown>;
    const jobs = Array.isArray(result.angebote) ? result.angebote as Record<string, unknown>[] : [];
    const errors = Array.isArray(result.errors) ? result.errors as Record<string, unknown>[] : [];
    return {
      jobs: jobs.map(normalizeMcpJob),
      failures: errors.map((item) => ({
        sourceId: String(item.portal_id ?? item.source_id ?? 'unknown'), category: String(item.category ?? 'internal'),
        retryable: Boolean(item.retryable), detail: String(item.detail ?? item.message ?? 'Quelle fehlgeschlagen.').slice(0, 500)
      }))
    };
  }

  async login(portalId: string): Promise<LoginResult> {
    const result = await this.call('portal_login', { portal_id: portalId, sichtbar: true, auto: true }) as Record<string, unknown>;
    return { status: String(result.status ?? 'ok'), portalId, note: typeof result.hinweis === 'string' ? result.hinweis : undefined };
  }

  async logout(portalId: string): Promise<LoginResult> {
    const result = await this.call('portal_sitzung_loeschen', { portal_id: portalId }) as Record<string, unknown>;
    return { status: String(result.status ?? 'ok'), portalId };
  }
}
