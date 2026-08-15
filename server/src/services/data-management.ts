import type { AppConfig } from '../domain/models.js';
import type { WorkspaceStore } from './workspace-store.js';

export function dataInventory(config: AppConfig, workspace: Awaited<ReturnType<WorkspaceStore['exportSnapshot']>>) {
  return {
    generatedAt: new Date().toISOString(),
    stores: [
      { id: 'configuration', location: '.local-data/config.json', purpose: 'Such-, MCP- und Assistentenkonfiguration', records: 1, encryptedFields: ['identities'] },
      { id: 'identities', location: '.local-data/config.json (verschlüsselt)', purpose: 'Lokale Vorschau- und Bewerbungsidentitäten', records: config.identities.length, encryptedFields: ['all'] },
      { id: 'search_runs', location: '.local-data/workspace.json', purpose: 'Reproduzierbare Suchhistorie', records: workspace.searchRuns.length, encryptedFields: [] },
      { id: 'application_cases', location: '.local-data/workspace.json', purpose: 'Bewerbungsstatus und Historie', records: workspace.applicationCases.length, encryptedFields: [] },
      { id: 'application_tracking', location: '.local-data/workspace.json', purpose: 'Append-only Tracking mit Quellenreferenzen', records: workspace.trackingEvents.length, encryptedFields: [] },
      { id: 'application_artifacts', location: '.local-data/workspace.json + .application-work/', purpose: 'Hash- und Nutzungshistorie stellenbezogener Dokumentrevisionen', records: workspace.artifactRevisions.length, encryptedFields: [] },
      { id: 'mail_vault', location: '.local-data/mail-vault.json', purpose: 'IMAP-Konten und korrelierte Unternehmensantworten', records: null, encryptedFields: ['all'] },
      { id: 'mail_drop', location: '.local-data/mail-drop/', purpose: 'Unverarbeitete lokale SMTP-EML-Dateien', records: null, encryptedFields: [] },
      { id: 'search_schedules', location: '.local-data/workspace.json', purpose: 'Explizit aktivierte Suchpläne', records: workspace.searchSchedules.length, encryptedFields: [] },
      { id: 'follow_up_reminders', location: '.local-data/workspace.json', purpose: 'Lokale Wiedervorlagen', records: workspace.reminders.length, encryptedFields: [] },
      { id: 'job_decisions', location: '.local-data/workspace.json', purpose: 'Merk- und Ausblendentscheidungen', records: workspace.jobDecisions.length, encryptedFields: [] },
      { id: 'comparison_notes', location: '.local-data/workspace.json', purpose: 'Subjektive Vergleichsnotizen', records: workspace.comparisonNotes.length, encryptedFields: [] },
      { id: 'work_artifacts', location: '.application-work/', purpose: 'Temporäre Evidence- und Exportartefakte', records: null, encryptedFields: [] },
      { id: 'agent_runs', location: '.local-data/agent-runs/', purpose: 'Append-only Agentenlauf-Snapshots und kanonische Ereignisse', records: null, encryptedFields: ['prompt', 'message', 'input', 'output'] },
      { id: 'agent_artifacts', location: '.local-data/agent-artifacts/', purpose: 'Content-addressed Vorschläge mit Run- und Bewerbungs-Provenance; Inhalte sind nicht verschlüsselt', records: null, encryptedFields: [] },
      { id: 'agent_keys', location: '.local-data/keys/', purpose: 'Lokale Schlüssel für Run-Vault und Freigabetokens', records: null, encryptedFields: ['all'] },
      {
        id: 'cv_imports', location: '.local-data/cv-imports/',
        purpose: 'Versionierte Lebenslauf-Fakten, Entscheidungen, Themes und HTML-Provenienz; nur manuell per revisionsgebundener CV-Import-Löschung aufbewahrt oder entfernt',
        records: null, encryptedFields: ['all'], retention: 'manual_delete_only',
      },
      {
        id: 'cv_ai_structuring_runs', location: '.local-data/cv-ai-structuring-runs/',
        purpose: 'Kurzlebige, verschlüsselte KI-Strukturvorschläge und deren Hash-, Provider- und Einwilligungsprovenienz; fehlgeschlagene Bereinigung bleibt für Wiederholungen getrackt',
        records: null, encryptedFields: ['all'], retention: 'automatic_ttl_with_tracked_retry',
      },
      { id: 'portal_sessions', location: 'JOB_MCP_STATE_DIR', purpose: 'Upstream-Browsersitzungen und verschlüsselte Credentials', records: null, encryptedFields: ['credentials'] }
    ]
  };
}

export function portableExport(config: AppConfig, workspace: Awaited<ReturnType<WorkspaceStore['exportSnapshot']>>, includeIdentities: boolean) {
  const { identities, ...safeConfig } = config;
  const redactedMcp = {
    ...safeConfig.mcp,
    env: Object.fromEntries(Object.keys(safeConfig.mcp.env).map((key) => [key, '[REDACTED]']))
  };
  return {
    contract: 'job-match-and-apply-export', contractVersion: '1.0', exportedAt: new Date().toISOString(),
    config: includeIdentities
      ? { ...config, mcp: redactedMcp }
      : { ...safeConfig, mcp: redactedMcp, identities: [], activeIdentityId: '' },
    workspace,
    containsPersonalData: includeIdentities
  };
}
