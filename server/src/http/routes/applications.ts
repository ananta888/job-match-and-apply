import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { LocalApplicationAssistantAdapter } from '../../adapters/local-application-assistant.js';
import type {
  ApplicationCase, ApplicationCaseState, SearchPreferenceMatch,
} from '../../domain/models.js';
import { LocalCandidateProfileAdapter } from '../../adapters/local-candidate-profile.js';
import { transitionApplicationCase } from '../../services/application-case.js';
import { createApplicationPackage, createSubmissionDryRun } from '../../services/application-package.js';
import { exportDocument, validateExport } from '../../services/document-export.js';
import { LocalLanguageChecker } from '../../services/language-check.js';
import { dataInventory, portableExport } from '../../services/data-management.js';
import { dueReminders, trackingCsv } from '../../services/application-tracking.js';
import { applyRetention } from '../../services/retention.js';
import { companyKey, parseAndCorrelateMail } from '../../services/mail-correlation.js';
import { syncImapAccount, testImapAccount } from '../../services/imap-mail-source.js';
import { buildCompanyCrm } from '../../services/application-crm.js';
import {
  assertApplicationApprovalReady,
  createArtifactRevision,
  markArtifactUsed,
  readVerifiedArtifactRevision,
  reviewArtifactRevision
} from '../../services/artifact-revisions.js';
import { importLocalMailDrop } from '../../services/local-mail-drop.js';
import type { Express } from 'express';
import {
  asyncRoute,
} from '../app-support.js';
import type { AppContext } from '../app-context.js';

export function registerApplicationRoutes(app: Express, ctx: AppContext): void {
  const {
    store, workspace, mailVault, applicationPipeline,
  } = ctx;

  app.get('/api/application-cases', asyncRoute(async (_request, response) => {
    response.json(await workspace.listApplicationCases());
  }));

  app.get('/api/application-cases/source-cv-candidates', asyncRoute(async (_request, response) => {
    const [applications, revisions] = await Promise.all([
      workspace.listApplicationCases(),
      workspace.listArtifactRevisions()
    ]);
    const cases = new Map(applications.map((item) => [item.id, item]));
    response.json(revisions
      .filter((revision) => revision.type === 'cv' && revision.lifecycle === 'approved' && cases.has(revision.applicationCaseId))
      .map((revision) => {
        const application = cases.get(revision.applicationCaseId)!;
        return {
          caseId: revision.applicationCaseId,
          revisionId: revision.id,
          sha256: revision.sha256,
          jobTitle: application.job.title,
          company: application.job.company,
          createdAt: revision.createdAt
        };
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }));

  app.get('/api/crm/companies', asyncRoute(async (_request, response) => {
    const applications = await workspace.listApplicationCases();
    const tracking = (await Promise.all(applications.map((item) => workspace.listTrackingEvents(item.id)))).flat();
    response.json(buildCompanyCrm(applications, tracking, await mailVault.listMessages(), await workspace.listArtifactRevisions()));
  }));

  app.get('/api/mail/accounts', asyncRoute(async (_request, response) => { response.json(await mailVault.listAccounts()); }));
  app.post('/api/mail/accounts', asyncRoute(async (request, response) => {
    const payload = z.object({
      label: z.string().min(1).max(100), email: z.string().email(), host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535).default(993), secure: z.boolean().default(true), username: z.string().min(1).max(320),
      secret: z.string().min(1).max(10_000), authType: z.enum(['password', 'access_token']).default('password'),
      enabled: z.boolean().default(false), mailbox: z.string().min(1).max(200).default('INBOX')
    }).parse(request.body);
    response.status(201).json(await mailVault.saveAccount(payload));
  }));
  app.patch('/api/mail/accounts/:accountId', asyncRoute(async (request, response) => {
    const accountId = z.string().uuid().parse(request.params.accountId);
    const payload = z.object({ enabled: z.boolean(), confirmed: z.literal(true) }).parse(request.body);
    response.json(await mailVault.setAccountEnabled(accountId, payload.enabled));
  }));
  app.delete('/api/mail/accounts/:accountId', asyncRoute(async (request, response) => {
    const accountId = z.string().uuid().parse(request.params.accountId); const confirmation = z.object({ confirmation: z.string() }).parse(request.body).confirmation;
    if (confirmation !== `DELETE mail-account ${accountId}`) throw Object.assign(new Error(`Bestätigung muss exakt DELETE mail-account ${accountId} lauten.`), { statusCode: 409 });
    response.json({ removed: await mailVault.deleteAccount(accountId) ? 1 : 0 });
  }));
  app.post('/api/mail/accounts/:accountId/sync', asyncRoute(async (request, response) => {
    const accountId = z.string().uuid().parse(request.params.accountId); const payload = z.object({ confirmed: z.literal(true), limit: z.number().int().min(1).max(500).default(100) }).parse(request.body);
    response.json(await syncImapAccount(mailVault, accountId, await workspace.listApplicationCases(), payload.limit));
  }));
  app.post('/api/mail/accounts/:accountId/test', asyncRoute(async (request, response) => {
    const accountId = z.string().uuid().parse(request.params.accountId); z.object({ confirmed: z.literal(true) }).parse(request.body);
    response.json(await testImapAccount(mailVault, accountId));
  }));
  app.get('/api/mail/messages', asyncRoute(async (_request, response) => { response.json(await mailVault.listMessages()); }));
  app.post('/api/mail/import-eml', asyncRoute(async (request, response) => {
    const payload = z.object({ fileName: z.string().min(1).max(240), base64: z.string().min(1).max(28_000_000), confirmed: z.literal(true) }).parse(request.body);
    if (!payload.fileName.toLowerCase().endsWith('.eml')) throw Object.assign(new Error('Nur .eml-Dateien werden akzeptiert.'), { statusCode: 400 });
    const message = await parseAndCorrelateMail(Buffer.from(payload.base64, 'base64'), 'manual-eml', 'eml', await workspace.listApplicationCases());
    await mailVault.saveMessages([message]); response.status(201).json(message);
  }));
  app.post('/api/mail/import-local-drop', asyncRoute(async (request, response) => {
    const payload = z.object({ confirmed: z.literal(true), limit: z.number().int().min(1).max(500).default(100) }).parse(request.body);
    response.json(await importLocalMailDrop(mailVault, await workspace.listApplicationCases(), undefined, payload.limit));
  }));
  app.post('/api/mail/messages/:messageId/correlation', asyncRoute(async (request, response) => {
    const messageId = z.string().uuid().parse(request.params.messageId); const payload = z.object({ applicationCaseId: z.string().uuid(), confirmed: z.literal(true) }).parse(request.body);
    const application = await workspace.getApplicationCase(payload.applicationCaseId);
    if (!application) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    response.json(await mailVault.confirmCorrelation(messageId, application.id, companyKey(application.job.company)));
  }));

  app.get('/api/application-cases/:caseId/artifacts', asyncRoute(async (request, response) => {
    response.json(await workspace.listArtifactRevisions(z.string().uuid().parse(request.params.caseId)));
  }));
  app.post('/api/application-cases/:caseId/artifacts', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId); const application = await workspace.getApplicationCase(caseId);
    if (!application) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    const payload = z.object({
      type: z.enum(['cv', 'cover_letter', 'application_email']),
      content: z.string().min(1).max(2_000_000)
    }).strict().parse(request.body);
    response.status(201).json(await createArtifactRevision(workspace, application, payload, applicationPipeline.workRoot));
  }));
  app.post('/api/application-cases/:caseId/artifacts/:revisionId/review', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId);
    const revisionId = z.string().uuid().parse(request.params.revisionId);
    const payload = z.object({
      decision: z.enum(['approved', 'rejected']),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
      acknowledgedLanguageIssueCount: z.number().int().nonnegative().max(10_000),
      confirmed: z.literal(true)
    }).strict().parse(request.body);
    const application = await workspace.getApplicationCase(caseId);
    if (!application) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    response.json(await reviewArtifactRevision(
      workspace, application, revisionId, payload, applicationPipeline.proofAuthority, applicationPipeline.workRoot
    ));
  }));
  app.post('/api/application-cases/:caseId/artifacts/:revisionId/use', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId); const revisionId = z.string().uuid().parse(request.params.revisionId);
    const payload = z.object({ confirmed: z.literal(true) }).parse(request.body); void payload;
    const application = await workspace.getApplicationCase(caseId); if (!application) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    response.json(await markArtifactUsed(
      workspace, application, revisionId, applicationPipeline.proofAuthority, applicationPipeline.workRoot
    ));
  }));

  app.post('/api/application-cases/:caseId/pipeline/finalize', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId);
    const payload = z.object({
      annotatedContent: z.string().min(1).max(200_000),
      iterationManifest: z.string().min(1).max(200_000)
    }).strict().parse(request.body);
    const application = await workspace.getApplicationCase(caseId);
    if (!application) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    if (application.state !== 'review') {
      throw Object.assign(new Error('Serverseitige Finalisierung ist nur im Review-Status zul\u00e4ssig.'), { statusCode: 409 });
    }
    const config = await store.load();
    const identity = config.identities.find((candidate) => candidate.id === application.identityId);
    if (!identity || identity.mode !== application.identityMode) {
      throw Object.assign(new Error('Die serverseitig gebundene Identit\u00e4t ist nicht verf\u00fcgbar.'), { statusCode: 409 });
    }
    const draft = await new LocalApplicationAssistantAdapter(config.assistant, applicationPipeline.workRoot).finalize({
      job: application.job,
      identity,
      documentType: application.documentType,
      annotatedContent: payload.annotatedContent,
      iterationManifest: payload.iterationManifest
    });
    if (!draft.pipelineEvidence || draft.lifecycle !== 'final') {
      throw Object.assign(new Error('Die Pipeline hat keinen serverseitig pr\u00fcfbaren Nachweis erzeugt.'), { statusCode: 409 });
    }
    const artifactType = application.documentType === 'email' ? 'application_email' : application.documentType;
    const pipelineProof = await applicationPipeline.proofAuthority.issue({
      applicationCaseId: application.id,
      jobId: application.job.id,
      identityId: application.identityId,
      documentType: artifactType,
      evidence: draft.pipelineEvidence
    });
    const revision = await createArtifactRevision(workspace, application, {
      type: artifactType,
      content: draft.content,
      pipelineProof
    }, applicationPipeline.workRoot, applicationPipeline.proofAuthority);
    response.status(201).json({ draft, revision });
  }));

  app.post('/api/application-cases', asyncRoute(async (request, response) => {
    const payload = z.object({
      match: z.custom<SearchPreferenceMatch>((value) => Boolean(value && typeof value === 'object')),
      identityId: z.string().min(1), documentType: z.enum(['cv', 'cover_letter', 'email']).default('cover_letter'),
      documentPurpose: z.enum(['profile_cv', 'vacancy_cv']).optional(),
      sourceCv: z.object({
        caseId: z.string().uuid(), revisionId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }).strict().optional(),
    }).strict().parse(request.body);
    const config = await store.load();
    const identity = config.identities.find((item) => item.id === payload.identityId);
    if (!identity) { response.status(404).json({ error: 'Identität nicht gefunden.' }); return; }
    let sourceCv: ApplicationCase['sourceCv'];
    if (payload.sourceCv) {
      const bound = (await workspace.listArtifactRevisions(payload.sourceCv.caseId))
        .find((revision) => revision.id === payload.sourceCv!.revisionId);
      if (!bound || bound.sha256 !== payload.sourceCv.sha256 || bound.type !== 'cv' || bound.lifecycle !== 'approved') {
        throw Object.assign(new Error('Gebundene CV-Revision existiert nicht, ist kein freigegebener Lebenslauf oder der Hash stimmt nicht.'), { statusCode: 409 });
      }
      const profileAdapter = new LocalCandidateProfileAdapter(config.assistant);
      if (!profileAdapter.candidateFileSha256) throw Object.assign(new Error('Profiladapter unterstützt keine Bindungsprüfung.'), { statusCode: 409 });
      sourceCv = { ...payload.sourceCv, profileSha256: await profileAdapter.candidateFileSha256() };
    }
    const now = new Date().toISOString();
    const application = {
      id: randomUUID(), job: payload.match.job, identityId: identity.id, identityMode: identity.mode,
      documentType: payload.documentType, documentPurpose: payload.documentPurpose, sourceCv,
      state: 'selected' as const, createdAt: now, updatedAt: now,
      artifactNames: [], warnings: [], revision: 1
    };
    await workspace.saveApplicationCase(application);
    await workspace.appendApplicationEvent({ id: randomUUID(), applicationCaseId: application.id, from: null, to: 'selected', occurredAt: now, source: 'user' });
    response.status(201).json(application);
  }));

  app.delete('/api/application-cases/:caseId', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId);
    const confirmation = z.object({ confirmation: z.string() }).strict().parse(request.body).confirmation;
    if (confirmation !== `DELETE application-case ${caseId}`) throw Object.assign(new Error(`Bestätigung muss exakt DELETE application-case ${caseId} lauten.`), { statusCode: 409 });
    const cascade = await workspace.deleteApplicationCase(caseId);
    if (!cascade.removed) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    response.json({ removed: 1, id: caseId, cascade: { events: cascade.events, trackingEvents: cascade.trackingEvents, artifacts: cascade.artifacts } });
  }));

  app.post('/api/application-cases/:caseId/transition', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId);
    const payload = z.discriminatedUnion('state', [
      z.object({
        state: z.literal('approved'), revisionId: z.string().uuid(),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true),
      }).strict(),
      z.object({
        state: z.enum(['selected', 'analysis', 'questions', 'draft', 'review', 'exported', 'dry_run', 'submitted', 'closed'])
      }).strict(),
    ]).parse(request.body);
    const target = payload.state as ApplicationCaseState;
    const current = await workspace.getApplicationCase(caseId);
    if (!current) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    let approvalBinding: { approvedArtifactRevisionId: string; approvedArtifactSha256: string; approvedAt: string } | undefined;
    if (payload.state === 'approved') {
      if (current.identityMode === 'incognito') {
        throw Object.assign(new Error('Inkognito-Bewerbungsfaelle duerfen Vorschau und Review nicht verlassen.'), { statusCode: 409 });
      }
      const revision = await assertApplicationApprovalReady(
        workspace, current, payload.revisionId, payload.expectedSha256,
        applicationPipeline.proofAuthority, applicationPipeline.workRoot,
      );
      approvalBinding = {
        approvedArtifactRevisionId: revision.id,
        approvedArtifactSha256: revision.sha256,
        approvedAt: new Date().toISOString(),
      };
    }
    const transitioned = transitionApplicationCase(current, target, new Date().toISOString());
    const updated = approvalBinding ? { ...transitioned, ...approvalBinding } : transitioned;
    await workspace.saveApplicationCase(updated);
    await workspace.appendApplicationEvent({
      id: randomUUID(), applicationCaseId: updated.id, from: current.state, to: updated.state,
      occurredAt: updated.updatedAt, source: 'user'
    });
    response.json(updated);
  }));

  app.get('/api/application-cases/:caseId/history', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId);
    response.json(await workspace.listApplicationEvents(caseId));
  }));

  app.post('/api/application-cases/:caseId/notes', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId);
    const note = z.object({ note: z.string().min(1).max(2000) }).parse(request.body).note;
    const application = await workspace.getApplicationCase(caseId);
    if (!application) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    const event = { id: randomUUID(), applicationCaseId: caseId, from: application.state, to: application.state, occurredAt: new Date().toISOString(), source: 'user' as const, note };
    await workspace.appendApplicationEvent(event);
    response.status(201).json(event);
  }));

  app.get('/api/application-cases/:caseId/tracking', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId);
    response.json(await workspace.listTrackingEvents(caseId));
  }));

  app.post('/api/application-cases/:caseId/tracking', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId);
    if (!await workspace.getApplicationCase(caseId)) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    const payload = z.object({
      status: z.enum(['planned', 'approved', 'manually_submitted', 'confirmed', 'interview', 'rejected', 'withdrawn', 'completed']),
      source: z.enum(['user', 'portal']).default('user'), sourceReference: z.string().url().max(1000).optional(),
      correctionOf: z.string().uuid().optional(), note: z.string().max(1000).optional()
    }).refine((value) => value.source !== 'portal' || Boolean(value.sourceReference), { message: 'Portalstatus benötigt eine eindeutige Quellenreferenz.', path: ['sourceReference'] }).parse(request.body);
    const previous = await workspace.listTrackingEvents(caseId);
    if (payload.correctionOf && !previous.some((item) => item.id === payload.correctionOf)) throw Object.assign(new Error('Korrekturreferenz gehört nicht zu diesem Bewerbungsfall.'), { statusCode: 409 });
    const event = { ...payload, id: randomUUID(), applicationCaseId: caseId, occurredAt: new Date().toISOString() };
    await workspace.appendTrackingEvent(event);
    response.status(201).json(event);
  }));

  app.get('/api/application-cases-export.csv', asyncRoute(async (_request, response) => {
    const applications = await workspace.listApplicationCases();
    const events = (await Promise.all(applications.map((item) => workspace.listApplicationEvents(item.id)))).flat();
    response.type('text/csv').send(trackingCsv(applications, events));
  }));

  app.post('/api/reminders', asyncRoute(async (request, response) => {
    const payload = z.object({ applicationCaseId: z.string().uuid(), dueAt: z.string().datetime(), timeZone: z.string().min(1).max(80), note: z.string().min(1).max(500) }).parse(request.body);
    try { new Intl.DateTimeFormat('de-DE', { timeZone: payload.timeZone }); } catch { throw Object.assign(new Error('Unbekannte Zeitzone.'), { statusCode: 400 }); }
    if (!await workspace.getApplicationCase(payload.applicationCaseId)) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    const reminder = { ...payload, id: randomUUID(), completed: false, createdAt: new Date().toISOString() };
    await workspace.saveReminder(reminder);
    response.status(201).json(reminder);
  }));

  app.get('/api/reminders/due', asyncRoute(async (_request, response) => {
    response.json(dueReminders(await workspace.listReminders(), new Date()));
  }));

  app.post('/api/application-cases/:caseId/package', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId);
    const payload = z.object({
      revisionIds: z.array(z.string().uuid()).min(1).max(20),
      confirmed: z.literal(true)
    }).strict().parse(request.body);
    const application = await workspace.getApplicationCase(caseId);
    if (!application) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    const verified = await Promise.all(payload.revisionIds.map((revisionId) =>
      readVerifiedArtifactRevision(workspace, application, revisionId, applicationPipeline.proofAuthority, applicationPipeline.workRoot)
    ));
    if (verified.some(({ revision }) => !['approved', 'used'].includes(revision.lifecycle) || revision.review?.decision !== 'approved')) {
      throw Object.assign(new Error('Das Paket darf nur menschlich freigegebene Pipeline-Revisionen enthalten.'), { statusCode: 409 });
    }
    response.json(createApplicationPackage(application, verified.map(({ revision, content }) => ({
      name: `${revision.type}-${revision.id}.md`, content
    })), [], new Date().toISOString()));
  }));

  app.post('/api/application-cases/:caseId/submission-dry-run', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId);
    const payload = z.object({ revisionIds: z.array(z.string().uuid()).min(1).max(20), confirmed: z.literal(true) }).strict().parse(request.body);
    const application = await workspace.getApplicationCase(caseId);
    if (!application) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    const verified = await Promise.all(payload.revisionIds.map((revisionId) =>
      readVerifiedArtifactRevision(workspace, application, revisionId, applicationPipeline.proofAuthority, applicationPipeline.workRoot)
    ));
    if (verified.some(({ revision }) => revision.lifecycle !== 'used' || revision.usedForApplicationCaseId !== caseId)) {
      throw Object.assign(new Error('Dry Run ben\u00f6tigt exakt die beim Export verwendeten Dokumentrevisionen.'), { statusCode: 409 });
    }
    const manifest = createApplicationPackage(application, verified.map(({ revision, content }) => ({
      name: `${revision.type}-${revision.id}.md`, content
    })), [], new Date().toISOString());
    response.json(createSubmissionDryRun(application, manifest));
  }));

  app.post('/api/application-cases/:caseId/export', asyncRoute(async (request, response) => {
    const caseId = z.string().uuid().parse(request.params.caseId);
    const payload = z.object({
      revisionId: z.string().uuid(),
      format: z.enum(['docx', 'pdf']),
      confirmed: z.literal(true)
    }).strict().parse(request.body);
    const application = await workspace.getApplicationCase(caseId);
    if (!application) { response.status(404).json({ error: 'Bewerbungsfall nicht gefunden.' }); return; }
    if (application.identityMode !== 'real' || application.state !== 'approved') {
      throw Object.assign(new Error('Export benötigt einen freigegebenen Bewerbungsfall mit realer Identität.'), { statusCode: 409 });
    }
    const verified = await readVerifiedArtifactRevision(
      workspace, application, payload.revisionId, applicationPipeline.proofAuthority, applicationPipeline.workRoot
    );
    if (application.approvedArtifactRevisionId !== verified.revision.id
      || application.approvedArtifactSha256 !== verified.revision.sha256) {
      throw Object.assign(new Error('Export ist nur fuer die exakt am Bewerbungsfall freigegebene Dokumentrevision erlaubt.'), { statusCode: 409 });
    }
    if (verified.revision.lifecycle !== 'approved' || verified.revision.review?.decision !== 'approved') {
      throw Object.assign(new Error('Export ben\u00f6tigt die exakt menschlich freigegebene Dokumentrevision.'), { statusCode: 409 });
    }
    const exported = await exportDocument(verified.content, payload.format);
    const quality = await validateExport(exported.data, payload.format);
    if (!quality.valid) throw Object.assign(new Error(`Export-Qualitätsprüfung fehlgeschlagen: ${quality.warnings.join(' ')}`), { statusCode: 409 });
    await markArtifactUsed(
      workspace, application, verified.revision.id, applicationPipeline.proofAuthority, applicationPipeline.workRoot
    );
    const updated = transitionApplicationCase(application, 'exported', new Date().toISOString());
    await workspace.saveApplicationCase(updated);
    await workspace.appendApplicationEvent({ id: randomUUID(), applicationCaseId: caseId, from: application.state, to: 'exported', occurredAt: updated.updatedAt, source: 'user' });
    response.json({
      fileName: `bewerbung-${application.job.id}.${exported.extension}`, mimeType: exported.mimeType,
      bytes: exported.data.length, base64: exported.data.toString('base64'), revision: updated.revision,
      artifactRevisionId: verified.revision.id, artifactSha256: verified.revision.sha256, quality
    });
  }));

  app.post('/api/language-check', asyncRoute(async (request, response) => {
    const payload = z.object({ content: z.string().min(1).max(2_000_000), language: z.string().max(20).default('de-DE') }).parse(request.body);
    const config = await store.load();
    const skillRoot = isAbsolute(config.assistant.skillPath) ? config.assistant.skillPath : resolve(process.cwd(), '..', config.assistant.skillPath);
    const workRoot = resolve(process.cwd(), '..', '.application-work', 'language-checks');
    await mkdir(workRoot, { recursive: true });
    const document = resolve(workRoot, `${randomUUID()}.md`);
    await writeFile(document, payload.content, { encoding: 'utf8', mode: 0o600 });
    try { response.json(await new LocalLanguageChecker(skillRoot).check(document, payload.language)); }
    finally { await rm(document, { force: true }); }
  }));

  app.get('/api/data/inventory', asyncRoute(async (_request, response) => {
    response.json(dataInventory(await store.load(), await workspace.exportSnapshot()));
  }));

  app.post('/api/data/export', asyncRoute(async (request, response) => {
    const payload = z.object({ includeIdentities: z.boolean().default(false), confirmed: z.boolean().default(false) }).parse(request.body);
    if (payload.includeIdentities && !payload.confirmed) throw Object.assign(new Error('Export personenbezogener Identitäten benötigt eine ausdrückliche Bestätigung.'), { statusCode: 409 });
    response.json(portableExport(await store.load(), await workspace.exportSnapshot(), payload.includeIdentities));
  }));

  app.post('/api/data/retention/run', asyncRoute(async (request, response) => {
    const policy = z.object({ enabled: z.boolean(), days: z.number().int().min(1).max(3650), confirmed: z.literal(true) }).parse(request.body);
    response.json(await applyRetention(workspace, policy, new Date()));
  }));

  app.delete('/api/data/:scope', asyncRoute(async (request, response) => {
    const scope = z.enum(['search_runs', 'application_cases', 'search_schedules', 'reminders', 'job_decisions', 'comparison_notes', 'job_inventory', 'work_artifacts']).parse(request.params.scope);
    const confirmation = z.object({ confirmation: z.string() }).parse(request.body).confirmation;
    if (confirmation !== `DELETE ${scope}`) throw Object.assign(new Error(`Bestätigung muss exakt DELETE ${scope} lauten.`), { statusCode: 409 });
    if (scope === 'work_artifacts') {
      const workRoot = resolve(process.cwd(), '..', '.application-work');
      await rm(workRoot, { recursive: true, force: true });
      response.json({ scope, removed: null, location: '.application-work/', residuals: [] });
      return;
    }
    response.json({ scope, removed: await workspace.clear(scope), residuals: [] });
  }));
}
