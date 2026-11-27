import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { inspectTrustedHostMcpRuntime } from '../../adapters/mcp-job-source.js';
import type { SearchPreferenceMatch } from '../../domain/models.js';
import { createIncognitoIdentity } from '../../services/identity-service.js';
import { matchJob } from '../../services/match-service.js';
import { deduplicateJobs } from '../../services/job-normalization.js';
import { buildInventoryView } from '../../services/job-inventory.js';
import { buildJobSearchMcpRuntimeSettings, discoverJobSearchMcpRuntimes } from '../../services/job-search-mcp-discovery.js';
import { compareJobs } from '../../services/job-comparison.js';
import { completeScheduleRun, scheduleDecision } from '../../services/search-scheduler.js';
import type { Express } from 'express';
import {
  inventoryMatch, discoverySettingsFrom, searchProfileSchema, configSchema, asyncRoute, sourceFor,
  publicConfigView, withServerOwnedIntegrationSettings,
} from '../app-support.js';
import type { AppContext } from '../app-context.js';

export function registerSearchRoutes(app: Express, ctx: AppContext): void {
  const {
    store, workspace,
  } = ctx;

  app.get('/api/config', asyncRoute(async (_request, response) => {
    const snapshot = await store.loadSnapshot();
    response.setHeader('cache-control', 'no-store');
    response.json(publicConfigView(snapshot.config, snapshot.revision));
  }));

  app.put('/api/config', asyncRoute(async (request, response) => {
    const { revision, ...submitted } = configSchema.parse(request.body);
    const saved = await store.compareAndSave(
      revision,
      (current) => withServerOwnedIntegrationSettings(submitted, current)
    );
    response.setHeader('cache-control', 'no-store');
    response.json(publicConfigView(saved.config, saved.revision));
  }));

  app.put('/api/config/mcp/portal-access', asyncRoute(async (request, response) => {
    const input = z.object({
      enabled: z.boolean(), confirmed: z.literal(true), expectedRevision: z.number().int().nonnegative()
    }).strict().parse(request.body);
    const saved = await store.compareAndSave(input.expectedRevision, async (config) => {
      if (input.enabled) {
        if (config.mcp.mode !== 'stdio') {
          throw Object.assign(new Error('Portalzugriff setzt einen validierten Trusted-Host-MCP-Startpfad voraus.'), { statusCode: 409 });
        }
        const runtime = await inspectTrustedHostMcpRuntime(config.mcp);
        if (runtime.state === 'invalid') {
          throw Object.assign(new Error('Portalzugriff bleibt gesperrt, weil der Trusted-Host-MCP-Startpfad ungültig ist.'), { statusCode: 409 });
        }
      }
      config.mcp.env = { ...config.mcp.env, ALLOW_EXTERNAL_PORTALS: input.enabled ? '1' : '0' };
      return config;
    });
    response.setHeader('cache-control', 'no-store');
    response.json(publicConfigView(saved.config, saved.revision));
  }));

  app.post('/api/identities/incognito', asyncRoute(async (request, response) => {
    const template = z.object({
      location: z.string().max(120).optional(), firstName: z.string().max(80).optional(),
      lastName: z.string().max(80).optional(), label: z.string().max(80).optional()
    }).strict().parse(request.body);
    const saved = await store.update((config) => {
      const identity = createIncognitoIdentity(template.location || config.searchProfile.regions[0] || 'Deutschland', template);
      config.identities.push(identity);
      config.activeIdentityId = identity.id;
      return config;
    });
    const identity = saved.config.identities.find((item) => item.id === saved.config.activeIdentityId)!;
    response.status(201).json(identity);
  }));

  app.get('/api/sources', asyncRoute(async (_request, response) => {
    const config = await store.load();
    try {
      response.json(await sourceFor(config).statuses());
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : String(error), sources: [] });
    }
  }));

  app.get('/api/sources/runtime', asyncRoute(async (_request, response) => {
    const config = await store.load();
    if (config.mcp.mode === 'demo') {
      response.json({
        contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'demo',
        state: 'demo', launchValidated: false, connected: false,
        note: 'Demoquelle aktiv; es wurde kein job-search-mcp-Prozess validiert oder verbunden.'
      });
      return;
    }
    const status = await inspectTrustedHostMcpRuntime(config.mcp);
    response.status(status.state === 'invalid' ? 503 : 200).json(status);
  }));

  app.get('/api/sources/runtime/candidates', asyncRoute(async (_request, response) => {
    const config = await store.load();
    response.setHeader('cache-control', 'no-store');
    response.json({
      contract: 'job-search-mcp-runtime-candidates', contractVersion: '1.0',
      candidates: await discoverJobSearchMcpRuntimes(config),
    });
  }));

  app.post('/api/sources/runtime/select', asyncRoute(async (request, response) => {
    const input = z.object({
      runtimeTarget: z.enum(['windows', 'wsl', 'darwin']), confirmed: z.literal(true), expectedRevision: z.number().int().nonnegative(),
    }).strict().parse(request.body);
    const projectRoot = resolve(process.cwd(), '..');
    const saved = await store.compareAndSave(input.expectedRevision, async (config) => {
      const settings = await buildJobSearchMcpRuntimeSettings(input.runtimeTarget, config, projectRoot);
      return { ...config, mcp: settings };
    });
    response.setHeader('cache-control', 'no-store');
    response.json(publicConfigView(saved.config, saved.revision));
  }));

  app.delete('/api/identities/:identityId', asyncRoute(async (request, response) => {
    const identityId = z.string().min(1).max(120).parse(request.params.identityId);
    const confirmation = z.object({ confirmation: z.string() }).strict().parse(request.body).confirmation;
    if (confirmation !== `DELETE identity ${identityId}`) throw Object.assign(new Error(`Bestätigung muss exakt DELETE identity ${identityId} lauten.`), { statusCode: 409 });
    const saved = await store.update((config) => {
      if (config.identities.length <= 1) throw Object.assign(new Error('Die letzte Identität kann nicht gelöscht werden.'), { statusCode: 409 });
      const before = config.identities.length;
      config.identities = config.identities.filter((item) => item.id !== identityId);
      if (config.identities.length === before) throw Object.assign(new Error('Identität nicht gefunden.'), { statusCode: 404 });
      if (config.activeIdentityId === identityId) config.activeIdentityId = config.identities[0]!.id;
      return config;
    });
    response.json({ scope: `identity:${identityId}`, removed: 1, remainingActiveIdentityId: saved.config.activeIdentityId });
  }));

  app.get('/api/capabilities', asyncRoute(async (_request, response) => {
    const config = await store.load();
    const capabilities = await sourceFor(config).capabilities();
    response.status(capabilities.compatible ? 200 : 503).json(capabilities);
  }));

  app.post('/api/sources/:sourceId/login', asyncRoute(async (request, response) => {
    const sourceId = z.string().regex(/^[a-z0-9-]+$/).parse(request.params.sourceId);
    const config = await store.load();
    response.json(await sourceFor(config).login(sourceId));
  }));

  app.delete('/api/sources/:sourceId/session', asyncRoute(async (request, response) => {
    const sourceId = z.string().regex(/^[a-z0-9-]+$/).parse(request.params.sourceId);
    const config = await store.load();
    response.json(await sourceFor(config).logout(sourceId));
  }));

  app.post('/api/jobs/search', asyncRoute(async (request, response) => {
    // fold=false previews results without adding them to the central list, so the
    // Jobsuche page can offer an explicit, deduplicated "In Meine Jobs übernehmen"
    // button. Default stays true for backward compatibility.
    const fold = request.query.fold !== 'false';
    const config = await store.load();
    const profile = request.body && Object.keys(request.body).length > 0
      ? searchProfileSchema.parse(request.body)
      : config.searchProfile;
    const sourceResult = await sourceFor(config).searchDetailed(profile);
    const matches = deduplicateJobs(sourceResult.jobs).map((job) => matchJob(profile, job)).sort((a, b) => b.searchPreferenceScore - a.searchPreferenceScore);
    const now = new Date().toISOString();
    const runId = randomUUID();
    const newKeys = fold
      ? (await workspace.foldJobsIntoInventory(matches.map((match) => ({ job: match.job, match: inventoryMatch(match) })), runId, now, discoverySettingsFrom(profile))).newKeys
      : [];
    const run = { id: runId, createdAt: now, profile, sourceIds: profile.sourceIds, matches, partialFailures: sourceResult.failures, newInventoryKeys: newKeys };
    await workspace.saveSearchRun(run);
    response.json({ runId, matches, partialFailures: sourceResult.failures, newJobCount: newKeys.length, folded: fold });
  }));

  app.post('/api/search-runs/:runId/adopt', asyncRoute(async (request, response) => {
    const runId = z.string().uuid().parse(request.params.runId);
    const run = await workspace.getSearchRun(runId);
    if (!run) { response.status(404).json({ error: 'Suchlauf nicht gefunden.' }); return; }
    const now = new Date().toISOString();
    const { newKeys } = await workspace.foldJobsIntoInventory(
      run.matches.map((match) => ({ job: match.job, match: inventoryMatch(match) })), runId, now, discoverySettingsFrom(run.profile),
    );
    await workspace.saveSearchRun({ ...run, newInventoryKeys: [...new Set([...(run.newInventoryKeys ?? []), ...newKeys])] });
    response.json({ runId, total: run.matches.length, added: newKeys.length, duplicates: run.matches.length - newKeys.length });
  }));

  app.get('/api/search-runs', asyncRoute(async (_request, response) => {
    response.json(await workspace.listSearchRuns());
  }));

  app.get('/api/search-runs-summary', asyncRoute(async (_request, response) => {
    const runs = await workspace.listSearchRuns();
    response.json(runs.map((run) => ({
      id: run.id, createdAt: run.createdAt, sourceIds: run.sourceIds,
      matchCount: run.matches.length,
      acceptedCount: run.matches.filter((match) => match.accepted).length,
      newJobCount: run.newInventoryKeys?.length ?? 0,
      partialFailureCount: run.partialFailures?.length ?? 0,
    })));
  }));

  app.get('/api/search-runs/:runId', asyncRoute(async (request, response) => {
    const runId = z.string().uuid().parse(request.params.runId);
    const run = await workspace.getSearchRun(runId);
    if (!run) { response.status(404).json({ error: 'Suchlauf nicht gefunden.' }); return; }
    response.json(run);
  }));

  app.post('/api/jobs/compare', asyncRoute(async (request, response) => {
    const payload = z.object({
      matches: z.array(z.custom<SearchPreferenceMatch>((value) => Boolean(value && typeof value === 'object'))).min(2).max(10),
      coverage: z.array(z.object({ jobId: z.string(), direct: z.number().int().nonnegative(), transferable: z.number().int().nonnegative(), partial: z.number().int().nonnegative(), gaps: z.number().int().nonnegative() })),
      weights: z.object({ searchPreference: z.number().min(0).max(10), evidenceCoverage: z.number().min(0).max(10), gaps: z.number().min(0).max(10), salary: z.number().min(0).max(10) })
    }).parse(request.body);
    response.json({ comparison: compareJobs(payload.matches, payload.coverage, payload.weights), disclaimer: 'Die Reihenfolge ist eine erklärbare Entscheidungshilfe, keine Bewerbungs- oder Einstellungsgarantie.' });
  }));

  app.get('/api/job-decisions', asyncRoute(async (_request, response) => {
    response.json(await workspace.listJobDecisions());
  }));

  app.put('/api/job-decisions/:jobId', asyncRoute(async (request, response) => {
    const jobId = z.string().min(1).max(240).parse(request.params.jobId);
    const state = z.object({ state: z.enum(['saved', 'hidden', 'neutral']) }).parse(request.body).state;
    const decision = { jobId, state, updatedAt: new Date().toISOString() };
    await workspace.saveJobDecision(decision);
    response.json(decision);
  }));

  app.get('/api/job-inventory', asyncRoute(async (_request, response) => {
    const snapshot = await workspace.exportSnapshot();
    response.json(snapshot.jobInventory.map((entry) =>
      buildInventoryView(entry, snapshot.applicationCases, snapshot.artifactRevisions, snapshot.trackingEvents)));
  }));

  app.put('/api/job-inventory/:key/category', asyncRoute(async (request, response) => {
    const key = z.string().min(1).max(400).parse(decodeURIComponent(z.string().min(1).max(600).parse(request.params.key)));
    const category = z.object({ category: z.enum(['inbox', 'apply', 'watchlist', 'archive']) }).parse(request.body).category;
    const entry = await workspace.setJobInventoryCategory(key, category, new Date().toISOString());
    if (!entry) { response.status(404).json({ error: 'Job nicht in der zentralen Liste gefunden.' }); return; }
    const snapshot = await workspace.exportSnapshot();
    response.json(buildInventoryView(entry, snapshot.applicationCases, snapshot.artifactRevisions, snapshot.trackingEvents));
  }));

  app.post('/api/job-inventory/:key/applied', asyncRoute(async (request, response) => {
    const key = z.string().min(1).max(400).parse(decodeURIComponent(z.string().min(1).max(600).parse(request.params.key)));
    const payload = z.object({ applied: z.boolean(), note: z.string().trim().max(500).optional() }).parse(request.body);
    const entry = await workspace.setJobInventoryApplied(key, payload.applied, payload.note, new Date().toISOString());
    if (!entry) { response.status(404).json({ error: 'Job nicht in der zentralen Liste gefunden.' }); return; }
    const snapshot = await workspace.exportSnapshot();
    response.json(buildInventoryView(entry, snapshot.applicationCases, snapshot.artifactRevisions, snapshot.trackingEvents));
  }));

  app.delete('/api/job-inventory/:key', asyncRoute(async (request, response) => {
    const key = z.string().min(1).max(400).parse(decodeURIComponent(z.string().min(1).max(600).parse(request.params.key)));
    const confirmation = z.object({ confirmation: z.string() }).strict().parse(request.body).confirmation;
    if (confirmation !== `DELETE job-inventory ${key}`) throw Object.assign(new Error('Bestätigung muss exakt DELETE job-inventory <key> lauten.'), { statusCode: 409 });
    const removed = await workspace.deleteJobInventoryEntry(key);
    if (!removed) { response.status(404).json({ error: 'Job nicht in der zentralen Liste gefunden.' }); return; }
    response.json({ removed: 1, key });
  }));

  app.get('/api/comparison-notes', asyncRoute(async (_request, response) => {
    response.json(await workspace.listComparisonNotes());
  }));

  app.post('/api/comparison-notes', asyncRoute(async (request, response) => {
    const payload = z.object({
      jobIds: z.array(z.string().min(1)).min(3).max(10), note: z.string().min(1).max(10_000),
      weights: z.object({ searchPreference: z.number().min(0).max(10), evidenceCoverage: z.number().min(0).max(10), gaps: z.number().min(0).max(10), salary: z.number().min(0).max(10) })
    }).parse(request.body);
    const now = new Date().toISOString();
    const note = { ...payload, id: randomUUID(), createdAt: now, updatedAt: now };
    await workspace.saveComparisonNote(note);
    response.status(201).json(note);
  }));

  app.get('/api/comparison-notes-export.json', asyncRoute(async (_request, response) => {
    response.type('application/json').send(JSON.stringify({ contract: 'comparison-notes-export', contractVersion: '1.0', notes: await workspace.listComparisonNotes() }, null, 2));
  }));

  app.delete('/api/comparison-notes/:noteId', asyncRoute(async (request, response) => {
    const noteId = z.string().uuid().parse(request.params.noteId);
    const confirmation = z.object({ confirmation: z.string() }).parse(request.body).confirmation;
    if (confirmation !== `DELETE comparison-note ${noteId}`) throw Object.assign(new Error(`Bestätigung muss exakt DELETE comparison-note ${noteId} lauten.`), { statusCode: 409 });
    const removed = await workspace.deleteComparisonNote(noteId);
    if (!removed) { response.status(404).json({ error: 'Vergleichsnotiz nicht gefunden.' }); return; }
    response.json({ removed: 1, id: noteId });
  }));

  app.get('/api/search-schedules', asyncRoute(async (_request, response) => {
    response.json(await workspace.listSearchSchedules());
  }));

  app.post('/api/search-schedules', asyncRoute(async (request, response) => {
    const payload = z.object({
      name: z.string().min(1).max(80), enabled: z.boolean().default(false), profile: searchProfileSchema,
      intervalMinutes: z.number().int().min(15).max(10_080),
      quietHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23), timeZone: z.string().min(1).max(80) })
    }).parse(request.body);
    const now = new Date();
    const schedule = { ...payload, id: randomUUID(), nextRunAt: new Date(now.getTime() + payload.intervalMinutes * 60_000).toISOString(), lastSeenJobIds: [], updatedAt: now.toISOString() };
    await workspace.saveSearchSchedule(schedule);
    response.status(201).json(schedule);
  }));

  app.delete('/api/search-schedules/:scheduleId', asyncRoute(async (request, response) => {
    const scheduleId = z.string().uuid().parse(request.params.scheduleId);
    const confirmation = z.object({ confirmation: z.string() }).strict().parse(request.body).confirmation;
    if (confirmation !== `DELETE search-schedule ${scheduleId}`) throw Object.assign(new Error(`Bestätigung muss exakt DELETE search-schedule ${scheduleId} lauten.`), { statusCode: 409 });
    const removed = await workspace.deleteSearchSchedule(scheduleId);
    if (!removed) { response.status(404).json({ error: 'Suchplan nicht gefunden.' }); return; }
    response.json({ removed: 1, id: scheduleId });
  }));

  app.post('/api/search-schedules/run-due', asyncRoute(async (_request, response) => {
    const now = new Date();
    const config = await store.load();
    const results: unknown[] = [];
    for (const schedule of await workspace.listSearchSchedules()) {
      const decision = scheduleDecision(schedule, now);
      if (!decision.due) { results.push({ scheduleId: schedule.id, status: 'skipped', reason: decision.reason }); continue; }
      try {
        const jobs = deduplicateJobs((await sourceFor({ ...config, searchProfile: schedule.profile }).searchDetailed(schedule.profile)).jobs);
        const matches = jobs.map((job) => matchJob(schedule.profile, job)).sort((a, b) => b.searchPreferenceScore - a.searchPreferenceScore);
        const runId = randomUUID();
        const nowIso = now.toISOString();
        const { newKeys } = await workspace.foldJobsIntoInventory(matches.map((match) => ({ job: match.job, match: inventoryMatch(match) })), runId, nowIso);
        const run = { id: runId, createdAt: nowIso, profile: schedule.profile, sourceIds: schedule.profile.sourceIds, matches, newInventoryKeys: newKeys };
        await workspace.saveSearchRun(run);
        const completed = completeScheduleRun(schedule, now, jobs.map((job) => job.id));
        await workspace.saveSearchSchedule(completed.schedule);
        results.push({ scheduleId: schedule.id, status: 'completed', runId: run.id, notification: completed.notification });
      } catch {
        results.push({ scheduleId: schedule.id, status: 'failed', retryScheduled: false });
      }
    }
    response.json({ evaluatedAt: now.toISOString(), results });
  }));
}
