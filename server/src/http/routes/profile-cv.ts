import express from 'express';
import { z } from 'zod';
import { LocalApplicationAssistantAdapter } from '../../adapters/local-application-assistant.js';
import type { SearchPreferenceMatch } from '../../domain/models.js';
import { MemoryConfigStore } from '../../services/config-store.js';
import { findIdentityLeaks } from '../../services/identity-service.js';
import { LocalCandidateProfileAdapter } from '../../adapters/local-candidate-profile.js';
import { importProfileDocument } from '../../services/profile-import.js';
import { readVerifiedArtifactRevision } from '../../services/artifact-revisions.js';
import { ApplicationProfileOnboardingService } from '../../services/profile-onboarding.js';
import { publicCvImportRecord, publicCvImportSummary } from '../../services/cv-imports.js';
import type { Express } from 'express';
import {
  editableStyleProfileSchema, cvCasSchema, cvThemeSchema, cvFactOperationSchema,
  cvAiProviderSchema, cvAiDisclosureSchema, cvAiModeSchema, cvAiRunCasSchema, asyncRoute,
} from '../app-support.js';
import type { AppContext } from '../app-context.js';

export function registerProfileCvRoutes(app: Express, ctx: AppContext): void {
  const {
    store, workspace, agentApi, applicationPipeline, cvImports, cvAiStructuring, styleProfiles,
    artifactRun, artifactForRun, hasCvAiStructuringService,
  } = ctx;

  app.get('/api/assistant/status', asyncRoute(async (_request, response) => {
    const config = await store.load();
    response.json(await new LocalApplicationAssistantAdapter(config.assistant).status());
  }));

  app.get('/api/application-pipeline/setup', asyncRoute(async (_request, response) => {
    const config = await store.load();
    let containsCandidateFacts = false;
    try {
      const summary = await new LocalCandidateProfileAdapter(config.assistant).summary();
      containsCandidateFacts = summary.valid && summary.claims.some((claim) =>
        (claim.status === 'verified' || claim.status === 'user_confirmed') && claim.evidenceRefs.length > 0
      );
    } catch { /* Missing templates are represented by the setup status below. */ }
    response.setHeader('Cache-Control', 'no-store');
    response.json(await new ApplicationProfileOnboardingService(config.assistant).status(containsCandidateFacts));
  }));

  app.post('/api/application-pipeline/setup/profiles', asyncRoute(async (request, response) => {
    z.object({ confirmed: z.literal(true) }).strict().parse(request.body);
    const config = await store.load();
    response.setHeader('Cache-Control', 'no-store');
    response.status(201).json(await new ApplicationProfileOnboardingService(config.assistant).initialize(true));
  }));

  app.get('/api/application-pipeline/style-profile', asyncRoute(async (_request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.json(await (await styleProfiles()).get());
  }));

  app.put('/api/application-pipeline/style-profile', asyncRoute(async (request, response) => {
    const payload = z.object({
      expectedRevision: z.number().int().min(0), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
      confirmed: z.literal(true), profile: editableStyleProfileSchema,
    }).strict().parse(request.body);
    response.setHeader('cache-control', 'no-store');
    response.json(await (await styleProfiles()).update(payload));
  }));

  app.get('/api/assistant/capabilities', asyncRoute(async (_request, response) => {
    const config = await store.load();
    const capabilities = await new LocalApplicationAssistantAdapter(config.assistant).capabilities();
    response.status(capabilities.compatible ? 200 : 503).json(capabilities);
  }));

  app.get('/api/candidate-profile', asyncRoute(async (_request, response) => {
    const config = await store.load();
    response.json(await new LocalCandidateProfileAdapter(config.assistant).summary());
  }));

  app.patch('/api/candidate-profile/claims', asyncRoute(async (request, response) => {
    const payload = z.object({
      confirmed: z.literal(true),
      operations: z.array(z.object({
        claimId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        field: z.enum(['statement', 'status', 'evidence_refs', 'allowed_outputs', 'valid_from', 'valid_to']),
        value: z.unknown()
      })).min(1).max(100)
    }).parse(request.body);
    const config = await store.load();
    response.json(await new LocalCandidateProfileAdapter(config.assistant).patch(payload.operations, payload.confirmed));
  }));

  app.post('/api/cv-imports', express.json({ limit: '15mb' }), asyncRoute(async (request, response) => {
    const payload = z.object({
      fileName: z.string().trim().min(1).max(240),
      mimeType: z.enum([
        'text/html', 'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.oasis.opendocument.text',
      ]),
      base64: z.string().min(1).max(14_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      confirmed: z.literal(true),
    }).strict().parse(request.body);
    const data = Buffer.from(payload.base64, 'base64');
    if (data.toString('base64') !== payload.base64) throw Object.assign(new Error('Base64-Daten sind nicht kanonisch kodiert.'), { statusCode: 400 });
    response.setHeader('cache-control', 'no-store');
    response.status(201).json(publicCvImportRecord(await (await cvImports()).import({
      fileName: payload.fileName, mimeType: payload.mimeType, data,
    })));
  }));

  app.get('/api/cv-imports', asyncRoute(async (request, response) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(100) }).parse(request.query);
    response.setHeader('cache-control', 'no-store');
    response.json((await (await cvImports()).list(limit)).map(publicCvImportSummary));
  }));

  app.get('/api/cv-imports/:importId', asyncRoute(async (request, response) => {
    const record = await (await cvImports()).get(z.string().uuid().parse(request.params.importId));
    if (!record) { response.status(404).json({ error: 'CV-Import nicht gefunden.' }); return; }
    response.setHeader('cache-control', 'no-store'); response.json(publicCvImportRecord(record));
  }));

  app.get('/api/cv-imports/:importId/recognition-versions', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    response.setHeader('cache-control', 'no-store');
    response.json(await (await cvImports()).recognitionVersions(id));
  }));

  app.post('/api/cv-imports/:importId/recognition-versions/:versionId/activate', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    const versionId = z.string().regex(/^recognition-[a-f0-9]{16}$/).parse(request.params.versionId);
    const payload = cvCasSchema.parse(request.body);
    response.setHeader('cache-control', 'no-store');
    response.json(publicCvImportRecord(await (await cvImports()).activateRecognitionVersion(
      id, payload.expectedRevision, payload.expectedSha256, versionId, payload.confirmed,
    )));
  }));

  app.post('/api/cv-imports/:importId/recognition-versions/:versionId/confirm', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    const versionId = z.string().regex(/^recognition-[a-f0-9]{16}$/).parse(request.params.versionId);
    const payload = cvCasSchema.parse(request.body);
    response.setHeader('cache-control', 'no-store');
    response.json(publicCvImportRecord(await (await cvImports()).confirmActiveRecognitionVersion(
      id, payload.expectedRevision, payload.expectedSha256, versionId, payload.confirmed,
    )));
  }));

  app.get('/api/cv-imports/:importId/ai-structuring/options', asyncRoute(async (request, response) => {
    const cvImportId = z.string().uuid().parse(request.params.importId);
    const query = z.object({
      expectedRevision: z.coerce.number().int().positive(),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().parse(request.query);
    const service = await cvAiStructuring(); await service.expireAndPrune();
    response.setHeader('cache-control', 'no-store');
    response.json(await service.options({
      cvImportId, expectedCvImportRevision: query.expectedRevision,
      expectedCvImportSha256: query.expectedSha256,
    }));
  }));

  app.post('/api/cv-imports/:importId/ai-structuring/runs', asyncRoute(async (request, response) => {
    const cvImportId = z.string().uuid().parse(request.params.importId);
    const payload = z.object({
      expectedRevision: z.number().int().positive(),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
      provider: cvAiProviderSchema,
      mode: cvAiModeSchema.default('review_suggestions'),
      disclosure: cvAiDisclosureSchema,
    }).strict().parse(request.body);
    const service = await cvAiStructuring(); await service.expireAndPrune();
    response.setHeader('cache-control', 'no-store');
    response.status(202).json(await service.start({
      cvImportId, expectedCvImportRevision: payload.expectedRevision,
      expectedCvImportSha256: payload.expectedSha256, provider: payload.provider,
      disclosure: payload.disclosure, mode: payload.mode, actor: { id: 'local-user', type: 'local' },
      correlationId: String(response.locals.correlationId),
    }));
  }));

  app.get('/api/cv-imports/:importId/ai-structuring/runs', asyncRoute(async (request, response) => {
    const cvImportId = z.string().uuid().parse(request.params.importId);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().parse(request.query);
    const service = await cvAiStructuring(); await service.expireAndPrune();
    response.setHeader('cache-control', 'no-store');
    response.json((await service.list(cvImportId)).slice(0, limit));
  }));

  app.get('/api/cv-imports/:importId/ai-structuring/runs/:runId', asyncRoute(async (request, response) => {
    const cvImportId = z.string().uuid().parse(request.params.importId);
    const runId = z.string().uuid().parse(request.params.runId);
    const service = await cvAiStructuring(); await service.expireAndPrune();
    response.setHeader('cache-control', 'no-store'); response.json(await service.get(cvImportId, runId));
  }));

  app.delete('/api/cv-imports/:importId/ai-structuring/runs/:runId', asyncRoute(async (request, response) => {
    const cvImportId = z.string().uuid().parse(request.params.importId);
    const runId = z.string().uuid().parse(request.params.runId);
    const payload = cvAiRunCasSchema.extend({ confirmed: z.literal(true) }).strict().parse(request.body);
    const service = await cvAiStructuring(); await service.expireAndPrune();
    response.setHeader('cache-control', 'no-store'); response.json(await service.deleteRun({
      cvImportId, runId, ...payload, actor: { id: 'local-user', type: 'local' },
    }));
  }));

  app.post('/api/cv-imports/:importId/ai-structuring/runs/:runId/cancel', asyncRoute(async (request, response) => {
    const cvImportId = z.string().uuid().parse(request.params.importId);
    const runId = z.string().uuid().parse(request.params.runId);
    const payload = cvAiRunCasSchema.extend({ confirmed: z.literal(true) }).strict().parse(request.body);
    const service = await cvAiStructuring(); await service.expireAndPrune();
    response.setHeader('cache-control', 'no-store'); response.json(await service.cancel({
      cvImportId, runId, ...payload, actor: { id: 'local-user', type: 'local' },
      correlationId: String(response.locals.correlationId),
    }));
  }));

  app.post('/api/cv-imports/:importId/ai-structuring/runs/:runId/retry', asyncRoute(async (request, response) => {
    const cvImportId = z.string().uuid().parse(request.params.importId);
    const runId = z.string().uuid().parse(request.params.runId);
    const payload = cvAiRunCasSchema.extend({
      expectedCvImportRevision: z.number().int().positive(),
      expectedCvImportSha256: z.string().regex(/^[a-f0-9]{64}$/),
      provider: cvAiProviderSchema,
      mode: cvAiModeSchema.optional(),
      disclosure: cvAiDisclosureSchema,
    }).strict().parse(request.body);
    const service = await cvAiStructuring(); await service.expireAndPrune();
    response.setHeader('cache-control', 'no-store'); response.status(202).json(await service.retry({
      cvImportId, runId, ...payload, actor: { id: 'local-user', type: 'local' },
      correlationId: String(response.locals.correlationId),
    }));
  }));

  app.post('/api/cv-imports/:importId/ai-structuring/runs/:runId/apply', asyncRoute(async (request, response) => {
    const cvImportId = z.string().uuid().parse(request.params.importId);
    const runId = z.string().uuid().parse(request.params.runId);
    const payload = cvAiRunCasSchema.extend({
      expectedCvImportRevision: z.number().int().positive(),
      expectedCvImportSha256: z.string().regex(/^[a-f0-9]{64}$/),
      selections: z.array(z.object({
        suggestionId: z.string().regex(/^suggestion-[a-f0-9]{16}$/),
        alternativeId: z.string().regex(/^alternative-[a-f0-9]{16}$/).nullable(),
      }).strict()).min(1).max(2_000),
      confirmed: z.literal(true),
    }).strict().parse(request.body);
    const service = await cvAiStructuring(); await service.expireAndPrune();
    response.setHeader('cache-control', 'no-store'); response.json(await service.apply({
      cvImportId, runId, ...payload, actor: { id: 'local-user', type: 'local' },
      correlationId: String(response.locals.correlationId),
    }));
  }));

  app.delete('/api/cv-imports/:importId', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    const payload = z.object({
      confirmation: z.literal(`DELETE cv-import ${id}`), expectedRevision: z.number().int().positive(),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().parse(request.body);
    const imports = await cvImports();
    const current = await imports.get(id);
    if (!current) { response.status(404).json({ error: 'CV-Import nicht gefunden.' }); return; }
    if (current.revision !== payload.expectedRevision || current.sha256 !== payload.expectedSha256) {
      throw Object.assign(new Error('CV-Import wurde zwischenzeitlich geändert.'), { statusCode: 409 });
    }
    // Persistent CV-AI runs may still hold encrypted, source-bound suggestions.
    // Purge those records and their raw AgentRun payloads before deleting the
    // authoritative import. Memory-only compositions without a CV-AI service
    // cannot have durable CV-AI residue and therefore need no cascade.
    if (hasCvAiStructuringService() || !(store instanceof MemoryConfigStore)) {
      await (await cvAiStructuring()).deleteForImport(id);
    }
    response.setHeader('cache-control', 'no-store');
    response.json({ removed: await imports.delete(id, payload.expectedRevision, payload.expectedSha256) ? 1 : 0 });
  }));

  app.patch('/api/cv-imports/:importId/facts', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    const payload = cvCasSchema.extend({ operations: z.array(cvFactOperationSchema).min(1).max(500) }).parse(request.body);
    response.setHeader('cache-control', 'no-store');
    response.json(publicCvImportRecord(await (await cvImports()).review(
      id, payload.expectedRevision, payload.expectedSha256, payload.operations,
    )));
  }));

  app.put('/api/cv-imports/:importId/theme', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    const payload = cvCasSchema.extend({ theme: cvThemeSchema.nullable() }).parse(request.body);
    response.setHeader('cache-control', 'no-store');
    response.json(publicCvImportRecord(await (await cvImports()).setTheme(
      id, payload.expectedRevision, payload.expectedSha256, payload.theme ?? undefined,
    )));
  }));

  app.post('/api/cv-imports/:importId/incognito-preview', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    const payload = z.object({
      applicationCaseId: z.string().uuid(),
      runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
      artifactId: z.string().uuid(),
      confirmed: z.literal(true),
    }).strict().parse(request.body);
    const application = await workspace.getApplicationCase(payload.applicationCaseId);
    if (!application) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    // This path exists only because adoption and case release are closed for
    // incognito. A real identity must keep using the approved-revision path,
    // which binds the document to a released revision and its hash.
    if (application.identityMode !== 'incognito') {
      throw Object.assign(new Error('Reale Bewerbungsfälle rendern über die freigegebene Dokumentrevision, nicht über die Inkognito-Vorschau.'), { statusCode: 409 });
    }
    if (application.documentType !== 'cv') throw Object.assign(new Error('HTML-CV kann nur für einen Bewerbungsfall vom Typ Lebenslauf gerendert werden.'), { statusCode: 409 });
    const run = await artifactRun(payload.runId);
    const artifact = await artifactForRun(run.id, payload.artifactId);
    if (artifact.lifecycle !== 'proposed' && artifact.lifecycle !== 'approved') {
      throw Object.assign(new Error('Nur vorgeschlagene oder bestätigte Artefakte können als Inkognito-Vorschau gerendert werden.'), { statusCode: 409 });
    }
    if (artifact.provenance.identityMode !== 'incognito' || artifact.provenance.applicationCaseId !== application.id) {
      throw Object.assign(new Error('Das Artefakt gehört nicht zu diesem Inkognito-Bewerbungsfall.'), { statusCode: 409 });
    }
    const { content } = await agentApi.artifacts.read(artifact.id);
    let documentContent: string;
    try { documentContent = new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch { throw Object.assign(new Error('Artefaktinhalt ist kein gültiger UTF-8-Text.'), { statusCode: 409 }); }
    response.setHeader('cache-control', 'no-store');
    response.json(await (await cvImports()).renderIncognitoPreview(id, {
      artifactId: artifact.id, artifactLifecycle: artifact.lifecycle, documentContent,
    }));
  }));

  app.post('/api/cv-imports/:importId/theme/preview', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    const payload = z.object({ theme: cvThemeSchema }).strict().parse(request.body);
    response.setHeader('cache-control', 'no-store');
    response.json(await (await cvImports()).previewTheme(id, payload.theme));
  }));

  app.post('/api/cv-imports/:importId/ats-check', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    const payload = z.object({
      source: z.enum(['theme-preview', 'proposal']).default('theme-preview'),
      mustHave: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
      niceToHave: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
    }).strict().parse(request.body);
    response.setHeader('cache-control', 'no-store');
    response.json(await (await cvImports()).atsCheck(id, payload.source, { mustHave: payload.mustHave, niceToHave: payload.niceToHave }));
  }));

  app.post('/api/cv-imports/:importId/adopt', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId); const payload = cvCasSchema.parse(request.body);
    response.setHeader('cache-control', 'no-store');
    response.json(publicCvImportRecord(await (await cvImports()).adopt(id, payload.expectedRevision, payload.expectedSha256)));
  }));

  app.get('/api/cv-imports/:importId/adoption/revocable', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    response.setHeader('cache-control', 'no-store');
    response.json(await (await cvImports()).revocableAdoptions(id));
  }));

  app.post('/api/cv-imports/:importId/adoption/revoke', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    const payload = cvCasSchema.extend({ transactionId: z.string().regex(/^[a-f0-9]{32}$/) }).parse(request.body);
    response.setHeader('cache-control', 'no-store');
    response.json(publicCvImportRecord(await (await cvImports()).revokeAdoption(
      id, payload.expectedRevision, payload.expectedSha256, payload.transactionId,
    )));
  }));

  app.get('/api/cv-imports/:importId/profile-snapshots', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    response.setHeader('cache-control', 'no-store');
    response.json(await (await cvImports()).profileSnapshots(id));
  }));

  app.post('/api/cv-imports/:importId/profile-snapshots/:snapshotId/restore', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    const snapshotId = z.string().regex(/^profile-snapshot-[a-f0-9]{16}$/).parse(request.params.snapshotId);
    const payload = cvCasSchema.parse(request.body);
    response.setHeader('cache-control', 'no-store');
    response.json(publicCvImportRecord(await (await cvImports()).restoreProfileSnapshot(
      id, payload.expectedRevision, payload.expectedSha256, snapshotId,
    )));
  }));

  app.post('/api/application-cases/:caseId/cv-proposals', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId);
    const payload = cvCasSchema.extend({
      importId: z.string().uuid(), documentRevisionId: z.string().uuid(),
      expectedDocumentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).parse(request.body);
    const application = await workspace.getApplicationCase(caseId);
    if (!application) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    if (application.documentType !== 'cv') throw Object.assign(new Error('HTML-CV kann nur für einen CV-Bewerbungsfall gerendert werden.'), { statusCode: 409 });
    const verified = await readVerifiedArtifactRevision(
      workspace, application, payload.documentRevisionId, applicationPipeline.proofAuthority, applicationPipeline.workRoot,
    );
    const sourceAgentArtifact = verified.revision.sourceAgentArtifactId
      ? await agentApi.artifacts.get(verified.revision.sourceAgentArtifactId) : undefined;
    if (verified.revision.type !== 'cv' || verified.revision.sha256 !== payload.expectedDocumentSha256
      || verified.revision.lifecycle !== 'approved' || verified.revision.review?.decision !== 'approved'
      || verified.revision.review.expectedSha256 !== payload.expectedDocumentSha256
      || !verified.revision.sourceAgentArtifactId
      || !sourceAgentArtifact || sourceAgentArtifact.lifecycle !== 'used'
      || sourceAgentArtifact.kind !== 'application-pipeline-package' || sourceAgentArtifact.mediaType !== 'application/json'
      || sourceAgentArtifact.provenance.workflowId !== 'evidence-application-package'
      || sourceAgentArtifact.provenance.workflowVersion !== '1.0.0'
      || sourceAgentArtifact.provenance.templateId !== 'evidence-application-package-finalizer'
      || sourceAgentArtifact.provenance.applicationCaseId !== application.id
      || sourceAgentArtifact.provenance.jobId !== application.job.id
      || sourceAgentArtifact.provenance.applicationCaseRevision === undefined
      || sourceAgentArtifact.provenance.applicationCaseRevision > application.revision
      || sourceAgentArtifact.adoption?.sourceReference !== `application-revision:${verified.revision.id}`
      || !['approved', 'exported'].includes(application.state)
      || application.approvedArtifactRevisionId !== verified.revision.id
      || application.approvedArtifactSha256 !== verified.revision.sha256) {
      throw Object.assign(new Error('HTML-Rendern benötigt die exakt menschlich freigegebene CV-Dokumentrevision.'), { statusCode: 409 });
    }
    const proof = verified.revision.pipelineProof!; const style = await (await styleProfiles()).get();
    const record = await (await cvImports()).renderApproved(
      payload.importId, payload.expectedRevision, payload.expectedSha256, {
        applicationCaseId: caseId, jobId: application.job.id, identityMode: application.identityMode,
        documentRevisionId: verified.revision.id, documentSha256: verified.revision.sha256,
        documentContent: verified.content,
        pipeline: {
          candidateProfileSha256: proof.candidateProfileSha256, styleProfileSha256: proof.styleProfileSha256,
          artifactSha256: proof.artifactSha256, pipelineContractVersion: proof.pipelineContractVersion,
          completedStages: proof.completedStages,
        },
        styleProfile: { revision: style.revision, sha256: style.sha256 },
        sourceAgentArtifactId: verified.revision.sourceAgentArtifactId!,
      },
    );
    response.setHeader('cache-control', 'no-store'); response.status(201).json(publicCvImportRecord(record));
  }));

  app.get('/api/cv-imports/:importId/proposal.html', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.importId);
    const query = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), download: z.enum(['true', 'false']).default('false') }).parse(request.query);
    const record = await (await cvImports()).get(id);
    if (!record?.proposal) { response.status(404).json({ error: 'HTML-CV nicht gefunden.' }); return; }
    if (record.proposal.htmlSha256 !== query.sha256) throw Object.assign(new Error('HTML-CV-Hash stimmt nicht mit der aktuellen Revision überein.'), { statusCode: 409 });
    if (query.download === 'true' && !record.proposal.downloadAllowed) throw Object.assign(new Error('Inkognito-CVs dürfen nicht heruntergeladen werden.'), { statusCode: 409 });
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-disposition', `${query.download === 'true' ? 'attachment' : 'inline'}; filename="lebenslauf.html"`);
    response.type('html').send(record.proposal.html);
  }));

  app.post('/api/profile-imports/preview', asyncRoute(async (request, response) => {
    const payload = z.object({
      fileName: z.string().min(1).max(240),
      mimeType: z.enum(['text/plain', 'text/markdown', 'application/json', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
      base64: z.string().min(1).max(14_000_000),
      sourceKind: z.enum(['cv', 'linkedin_export', 'stepstone_export', 'user_upload'])
    }).parse(request.body);
    const buffer = Buffer.from(payload.base64, 'base64');
    const config = await store.load();
    let existingClaims: Array<{ id: string; statement: string }> = [];
    try {
      const summary = await new LocalCandidateProfileAdapter(config.assistant).summary();
      existingClaims = summary.claims.map((claim) => ({ id: claim.id, statement: claim.statement }));
    } catch { /* Import preview remains usable before private profiles are configured. */ }
    response.json(await importProfileDocument(payload.fileName, payload.mimeType, buffer, payload.sourceKind, existingClaims));
  }));

  app.post('/api/profile-imports/accept', asyncRoute(async (request, response) => {
    const payload = z.object({ confirmed: z.literal(true), proposals: z.array(z.object({
      id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), statement: z.string().min(3).max(5000), sha256: z.string().regex(/^[a-f0-9]{64}$/)
    })).min(1).max(200) }).parse(request.body);
    const config = await store.load();
    response.json(await new LocalCandidateProfileAdapter(config.assistant).addImportProposals(payload.proposals, true));
  }));

  app.post('/api/applications/draft', asyncRoute(async (request, response) => {
    const payload = z.object({
      match: z.custom<SearchPreferenceMatch>((value) => Boolean(value && typeof value === 'object')),
      identityId: z.string().min(1),
      documentType: z.enum(['cv', 'cover_letter', 'email']).default('cover_letter')
    }).parse(request.body);
    const config = await store.load();
    const identity = config.identities.find((candidate) => candidate.id === payload.identityId);
    if (!identity) {
      response.status(404).json({ error: 'Identität nicht gefunden.' });
      return;
    }
    const assistant = new LocalApplicationAssistantAdapter(config.assistant);
    const draft = await assistant.preview(payload.match.job, identity, payload.documentType);
    if (identity.mode === 'incognito') {
      const leaks = findIdentityLeaks(draft.content, config.identities);
      if (leaks.length > 0) throw Object.assign(new Error('Inkognito-Ausgabe enthält Werte einer realen Identität.'), { statusCode: 409 });
    }
    response.json(draft);
  }));

  app.post('/api/applications/analyze', asyncRoute(async (request, response) => {
    const payload = z.object({
      match: z.custom<SearchPreferenceMatch>((value) => Boolean(value && typeof value === 'object')),
      documentType: z.enum(['cv', 'cover_letter', 'email']).default('cover_letter')
    }).parse(request.body);
    const config = await store.load();
    response.json(await new LocalApplicationAssistantAdapter(config.assistant).analyze(payload.match.job, payload.documentType));
  }));

  app.post('/api/applications/validate-match', asyncRoute(async (request, response) => {
    const payload = z.object({ matrix: z.record(z.string(), z.unknown()), documentType: z.enum(['cv', 'cover_letter', 'email']) }).parse(request.body);
    const config = await store.load();
    response.json(await new LocalApplicationAssistantAdapter(config.assistant).validateMatchMatrix(payload.matrix, payload.documentType));
  }));

  app.post('/api/applications/finalize', asyncRoute(async (request, response) => {
    const payload = z.object({
      match: z.custom<SearchPreferenceMatch>((value) => Boolean(value && typeof value === 'object')),
      identityId: z.string().min(1),
      documentType: z.enum(['cv', 'cover_letter', 'email']),
      annotatedContent: z.string().min(1).max(200_000),
      iterationManifest: z.string().min(1).max(200_000)
    }).parse(request.body);
    const config = await store.load();
    const identity = config.identities.find((candidate) => candidate.id === payload.identityId);
    if (!identity) {
      response.status(404).json({ error: 'Identität nicht gefunden.' });
      return;
    }
    if (identity.mode !== 'incognito') {
      throw Object.assign(new Error('Finalisierung ist nur fallgebunden ueber /api/application-cases/:caseId/pipeline/finalize erlaubt.'), { statusCode: 409 });
    }
    const assistant = new LocalApplicationAssistantAdapter(config.assistant);
    response.json(await assistant.finalize({
      job: payload.match.job,
      identity,
      documentType: payload.documentType,
      annotatedContent: payload.annotatedContent,
      iterationManifest: payload.iterationManifest
    }));
  }));
}
