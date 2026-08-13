import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { DemoJobSourceAdapter } from './adapters/demo-job-source.js';
import { LocalApplicationAssistantAdapter } from './adapters/local-application-assistant.js';
import { McpJobSourceAdapter } from './adapters/mcp-job-source.js';
import type { AppConfig, JobMatch } from './domain/models.js';
import type { JobSourcePort } from './ports/job-source.js';
import type { ConfigStore } from './services/config-store.js';
import { JsonConfigStore } from './services/config-store.js';
import { createIncognitoIdentity } from './services/identity-service.js';
import { matchJob } from './services/match-service.js';

const searchProfileSchema = z.object({
  name: z.string().min(1).max(80),
  query: z.string().min(2).max(120),
  regions: z.array(z.string().min(1)).max(20),
  radiusKm: z.number().int().min(0).max(500),
  workModels: z.array(z.enum(['remote', 'hybrid', 'onsite'])),
  employmentTypes: z.array(z.enum(['full_time', 'part_time', 'contract', 'freelance', 'internship'])),
  mustHave: z.array(z.string().min(1)).max(50),
  niceToHave: z.array(z.string().min(1)).max(50),
  exclude: z.array(z.string().min(1)).max(50),
  minSalary: z.number().int().positive().optional(),
  sourceIds: z.array(z.string().min(1)).max(30)
});

const identitySchema = z.object({
  id: z.string().min(1), label: z.string().min(1), mode: z.enum(['real', 'incognito']),
  fullName: z.string(), email: z.string(), phone: z.string(), location: z.string(), linkedin: z.string(),
  placeholders: z.record(z.string(), z.string())
});

const configSchema = z.object({
  searchProfile: searchProfileSchema,
  identities: z.array(identitySchema).min(1),
  activeIdentityId: z.string().min(1),
  mcp: z.object({
    mode: z.enum(['demo', 'stdio']), command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string())
  }),
  assistant: z.object({ skillPath: z.string(), candidateProfilePath: z.string(), styleProfilePath: z.string() })
}).refine((config) => config.identities.some((identity) => identity.id === config.activeIdentityId), {
  message: 'Die aktive Identität muss in identities enthalten sein.', path: ['activeIdentityId']
});

const asyncRoute = (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction): void => { handler(request, response).catch(next); };

const sourceFor = (config: AppConfig): JobSourcePort =>
  config.mcp.mode === 'stdio' ? new McpJobSourceAdapter(config.mcp) : new DemoJobSourceAdapter();

export function createApp(store: ConfigStore = new JsonConfigStore()) {
  const app = express();
  app.use(cors({ origin: ['http://localhost:4200', 'http://127.0.0.1:4200'] }));
  app.use(express.json({ limit: '512kb' }));

  app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));

  app.get('/api/config', asyncRoute(async (_request, response) => {
    response.json(await store.load());
  }));

  app.put('/api/config', asyncRoute(async (request, response) => {
    const config = configSchema.parse(request.body);
    response.json(await store.save(config));
  }));

  app.post('/api/identities/incognito', asyncRoute(async (request, response) => {
    const config = await store.load();
    const location = z.object({ location: z.string().max(120).optional() }).parse(request.body).location;
    const identity = createIncognitoIdentity(location || config.searchProfile.regions[0] || 'Deutschland');
    config.identities.push(identity);
    config.activeIdentityId = identity.id;
    await store.save(config);
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

  app.post('/api/sources/:sourceId/login', asyncRoute(async (request, response) => {
    const sourceId = z.string().regex(/^[a-z0-9-]+$/).parse(request.params.sourceId);
    const config = await store.load();
    response.json(await sourceFor(config).login(sourceId));
  }));

  app.post('/api/jobs/search', asyncRoute(async (request, response) => {
    const config = await store.load();
    const profile = request.body && Object.keys(request.body).length > 0
      ? searchProfileSchema.parse(request.body)
      : config.searchProfile;
    const jobs = await sourceFor(config).search(profile);
    response.json({ matches: jobs.map((job) => matchJob(profile, job)).sort((a, b) => b.score - a.score) });
  }));

  app.get('/api/assistant/status', asyncRoute(async (_request, response) => {
    const config = await store.load();
    response.json(await new LocalApplicationAssistantAdapter(config.assistant).status());
  }));

  app.post('/api/applications/draft', asyncRoute(async (request, response) => {
    const payload = z.object({
      match: z.custom<JobMatch>((value) => Boolean(value && typeof value === 'object')),
      identityId: z.string().min(1),
      documentType: z.enum(['cover_letter', 'email']).default('cover_letter')
    }).parse(request.body);
    const config = await store.load();
    const identity = config.identities.find((candidate) => candidate.id === payload.identityId);
    if (!identity) {
      response.status(404).json({ error: 'Identität nicht gefunden.' });
      return;
    }
    const assistant = new LocalApplicationAssistantAdapter(config.assistant);
    response.json(await assistant.draft(payload.match, identity, payload.documentType));
  }));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: 'Ungültige Eingabe.', details: error.issues });
      return;
    }
    const statusCode = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    response.status(statusCode).json({ error: error instanceof Error ? error.message : 'Unbekannter Fehler' });
  });

  return app;
}
