import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AppConfig, JobPosting, SearchProfile, SourceStatus } from '../domain/models.js';
import type { JobSourcePort, LoginResult } from '../ports/job-source.js';

type McpSettings = AppConfig['mcp'];

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

function asJob(raw: Record<string, unknown>, index: number): JobPosting {
  const model = String(raw.arbeitsmodell ?? '').toLocaleLowerCase('de-DE');
  const workModel = model.includes('remote') ? 'remote' : model.includes('hybrid') ? 'hybrid' : 'onsite';
  return {
    id: String(raw.id ?? raw.link ?? `mcp-${index}`),
    sourceId: String(raw.portal ?? 'mcp'),
    title: String(raw.titel ?? ''),
    company: String(raw.firma ?? ''),
    location: String(raw.ort ?? ''),
    workModel,
    employmentType: 'full_time',
    description: String(raw.beschreibung ?? ''),
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : [],
    salaryMin: typeof raw.gehalt_min === 'number' ? raw.gehalt_min : undefined,
    salaryMax: typeof raw.gehalt_max === 'number' ? raw.gehalt_max : undefined,
    url: typeof raw.link === 'string' ? raw.link : undefined
  };
}

export class McpJobSourceAdapter implements JobSourcePort {
  constructor(private readonly settings: McpSettings) {}

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const command = resolve(process.cwd(), '..', this.settings.command);
    await access(command);
    const transport = new StdioClientTransport({
      command,
      args: this.settings.args,
      env: { ...process.env, ...this.settings.env } as Record<string, string>
    });
    const client = new Client({ name: 'job-match-and-apply', version: '0.1.0' });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name, arguments: args });
      if ('isError' in result && result.isError) throw new Error(`MCP-Werkzeug ${name} meldete einen Fehler.`);
      return parseToolResult(result);
    } finally {
      await client.close();
    }
  }

  async statuses(): Promise<SourceStatus[]> {
    const result = await this.call('browser_status', {}) as Record<string, unknown>;
    const portals = Array.isArray(result.portale) ? result.portale as Record<string, unknown>[] : [];
    return portals.map((portal) => ({
      id: String(portal.portal_id),
      name: String(portal.portal_id),
      kind: 'mcp',
      enabled: true,
      connected: Boolean(portal.treiber_verfuegbar),
      supportsLogin: true,
      sessionAvailable: Boolean(portal.sitzung_vorhanden),
      note: Array.isArray(portal.anmerkungen) ? portal.anmerkungen.map(String).join(' ') : ''
    }));
  }

  async search(profile: SearchProfile): Promise<JobPosting[]> {
    const result = await this.call('mehrportal_suche', {
      portal_ids: profile.sourceIds.filter((id) => id !== 'linkedin-profile'),
      query: profile.query,
      ort: profile.regions[0] ?? null
    }) as Record<string, unknown>;
    const jobs = Array.isArray(result.angebote) ? result.angebote as Record<string, unknown>[] : [];
    return jobs.map(asJob);
  }

  async login(portalId: string): Promise<LoginResult> {
    const result = await this.call('portal_login', { portal_id: portalId, sichtbar: true, auto: true }) as Record<string, unknown>;
    return { status: String(result.status ?? 'ok'), portalId, note: typeof result.hinweis === 'string' ? result.hinweis : undefined };
  }
}
