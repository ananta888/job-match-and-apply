import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { matchJob } from '../../services/match-service.js';
import { deduplicateJobs } from '../../services/job-normalization.js';
import { LocalCandidateProfileAdapter } from '../../adapters/local-candidate-profile.js';
import { companyKey } from '../../services/mail-correlation.js';
import { APPLICATION_AGENT_WORKFLOWS } from '../../agents/application-workflows.js';
import { parseApplicationPipelinePackage, renderApplicationPipelinePackageHtml } from '../../agents/application-result-html.js';
import type { Express } from 'express';
import {
  asyncRoute, sourceFor,
} from '../app-support.js';
import type { AppContext } from '../app-context.js';

export function registerAgentOrchestrationRoutes(app: Express, ctx: AppContext): void {
  const {
    store, workspace, mailVault, agentApi, orchestrationService, orchestrationCreateSchema,
    providerForOrchestration, orchestrationConfirmations,
  } = ctx;

  app.get('/api/agent-orchestrations', asyncRoute(async (_request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.json({ orchestrations: await orchestrationService.list() });
  }));

  app.get('/api/agent-orchestrations/:orchestrationId', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.orchestrationId);
    const orchestration = await orchestrationService.get(id);
    if (!orchestration) { response.status(404).json({ error: 'Agentenorchestrierung nicht gefunden.' }); return; }
    response.setHeader('cache-control', 'no-store');
    response.json(orchestration);
  }));

  app.get('/api/agent-orchestrations/:orchestrationId/result.html', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.orchestrationId);
    const query = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.query);
    const orchestration = await orchestrationService.get(id);
    if (!orchestration) throw Object.assign(new Error('Agentenorchestrierung nicht gefunden.'), { statusCode: 404 });
    if (orchestration.workflowId !== 'evidence-application-package' || orchestration.status !== 'succeeded') {
      throw Object.assign(new Error('Die finale HTML-Fassung ist erst nach allen fünf erfolgreichen Agenten verfügbar.'), { statusCode: 409 });
    }
    const references = orchestration.artifactRefs.filter((candidate) => ['final_html', 'package_proposal'].includes(candidate.outputRef));
    const reference = references.length === 1 ? references[0] : undefined;
    const directHtml = reference?.outputRef === 'final_html';
    const finalizer = orchestration.nodes.find((node) => node.nodeId === 'finalizer' && node.role === 'finalizer');
    if (!reference || reference.sha256 !== query.sha256 || finalizer?.status !== 'succeeded'
      || !finalizer.artifacts.some((candidate) => candidate.outputRef === reference.outputRef && candidate.artifactId === reference.artifactId
        && candidate.runId === reference.runId && candidate.sha256 === reference.sha256)) {
      throw Object.assign(new Error('Die HTML-Fassung stimmt nicht mit dem abgeschlossenen Finalizer-Ergebnis überein.'), { statusCode: 409 });
    }
    const { record: artifact, content } = await agentApi.artifacts.read(reference.artifactId);
    if (artifact.sha256 !== reference.sha256 || artifact.provenance.runId !== reference.runId
      || (directHtml
        ? artifact.kind !== 'application-final-html' || artifact.mediaType !== 'text/html; charset=utf-8'
        : artifact.kind !== 'application-pipeline-package' || artifact.mediaType !== 'application/json')
      || artifact.provenance.workflowId !== orchestration.workflowId
      || artifact.provenance.workflowVersion !== orchestration.workflowVersion
      || artifact.provenance.templateId !== 'evidence-application-package-finalizer'
      || artifact.provenance.applicationCaseId !== orchestration.scope.applicationCaseId
      || artifact.provenance.identityMode !== orchestration.scope.identityMode) {
      throw Object.assign(new Error('Die Finalizer-Provenienz der HTML-Fassung ist nicht vollständig gebunden.'), { statusCode: 409 });
    }
    let packageContent: string;
    try { packageContent = new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch { throw Object.assign(new Error('Das Finalizer-Ergebnis ist kein gültiger UTF-8-Text.'), { statusCode: 409 }); }
    if (directHtml && (!/^<!doctype html>/i.test(packageContent)
      || !packageContent.includes('data-result="final-agent-html"')
      || /<(?:script|iframe|object|embed|form|input|button|textarea|select|svg|math)(?:\s|>)/i.test(packageContent))) {
      throw Object.assign(new Error('Das Finalizer-HTML verletzt den sicheren Anzeigevertrag.'), { statusCode: 409 });
    }
    const html = directHtml ? packageContent : renderApplicationPipelinePackageHtml(parseApplicationPipelinePackage(packageContent), {
      artifactSha256: artifact.sha256,
      identityMode: artifact.provenance.identityMode === 'incognito' ? 'incognito' : 'real',
      artifactLifecycle: artifact.lifecycle,
    });
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; sandbox");
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'SAMEORIGIN');
    response.type('html').send(html);
  }));

  app.post('/api/agent-orchestrations', asyncRoute(async (request, response) => {
    if (agentApi.emergencyStop.enabled) throw Object.assign(new Error('Der Emergency Stop blockiert neue Agentenorchestrierungen.'), { statusCode: 409 });
    const payload = orchestrationCreateSchema.parse(request.body);
    const orchestrationProvider = await providerForOrchestration(payload.providerId, payload.runtimeTarget, payload.wslDistribution, payload.installation);
    const workflow = APPLICATION_AGENT_WORKFLOWS.find((candidate) => candidate.id === payload.workflowId)!;
    const configuration = await store.load();
    const application = payload.applicationCaseId ? await workspace.getApplicationCase(payload.applicationCaseId) : undefined;
    if (workflow.requiredScope !== 'search_profile' && !application) {
      throw Object.assign(new Error('Dieser Workflow benoetigt einen expliziten Bewerbungsfall.'), { statusCode: 400 });
    }
    if (payload.documentRevisionId && !application) throw Object.assign(new Error('Eine Dokumentrevision benoetigt einen Bewerbungsfall.'), { statusCode: 400 });
    if (payload.workflowId === 'employer-response-triage' && !payload.mailId) {
      throw Object.assign(new Error('Die Antworttriage benoetigt eine explizit ausgewaehlte Mail.'), { statusCode: 400 });
    }
    let selectedMailId: string | undefined;
    if (payload.mailId) {
      if (payload.workflowId !== 'employer-response-triage' || !application) {
        throw Object.assign(new Error('Eine Mailbindung ist nur fuer die fallgebundene Antworttriage erlaubt.'), { statusCode: 400 });
      }
      const message = (await mailVault.listMessages()).find((candidate) => candidate.id === payload.mailId);
      if (!message) throw Object.assign(new Error('Die ausgewaehlte Nachricht wurde nicht gefunden.'), { statusCode: 404 });
      selectedMailId = message.id;
    }
    if (payload.workflowId === 'guided-job-analysis') {
      const sourceResult = await sourceFor(configuration).searchDetailed(configuration.searchProfile);
      const matches = deduplicateJobs(sourceResult.jobs).map((job) => matchJob(configuration.searchProfile, job))
        .sort((left, right) => right.searchPreferenceScore - left.searchPreferenceScore).slice(0, 20);
      if (!matches.length) throw Object.assign(new Error('Die Trusted-Host-Jobsuche lieferte keine Stellen.'), { statusCode: 409 });
      await workspace.saveSearchRun({
        id: randomUUID(), createdAt: new Date().toISOString(), profile: configuration.searchProfile,
        sourceIds: configuration.searchProfile.sourceIds, matches, partialFailures: sourceResult.failures,
      });
    }
    let claimIds: string[] = [];
    if (payload.workflowId === 'evidence-application-package') {
      const profile = await new LocalCandidateProfileAdapter(configuration.assistant).summary();
      claimIds = profile.claims.filter((claim) => application
        && claim.allowedOutputs.includes(application.documentType)
        && (claim.status === 'user_confirmed' || (claim.status === 'verified' && claim.evidenceRefs.length > 0)))
        .map((claim) => claim.id);
      if (!profile.valid || !claimIds.length) {
        throw Object.assign(new Error('Die Multi-Agent-Bewerbungskette benoetigt mindestens einen belegten Claim im Kandidatenprofil.'), { statusCode: 409 });
      }
    }
    const identity = application
      ? configuration.identities.find((candidate) => candidate.id === application.identityId)
      : configuration.identities.find((candidate) => candidate.id === configuration.activeIdentityId);
    if (!identity) throw Object.assign(new Error('Die gebundene Identitaet wurde nicht gefunden.'), { statusCode: 409 });
    const documentRevisionId = payload.documentRevisionId;
    const scope = {
      applicationCaseId: application?.id,
      applicationCaseRevision: application?.revision,
      jobId: application?.job.id,
      companyKey: application ? companyKey(application.job.company) : undefined,
      mailId: selectedMailId,
      documentRevisionId,
      workspaceRootId: 'workspace-local',
      identityMode: application?.identityMode ?? identity.mode,
    } as const;
    const orchestration = await orchestrationService.create({
      workflowId: workflow.id, providerId: payload.providerId,
      workspaceRoot: agentApi.workspaceRoot, runtimeTarget: payload.runtimeTarget,
      wslDistribution: payload.wslDistribution,
      providerVersion: orchestrationProvider.installation.version,
      providerExecutable: orchestrationProvider.installation.executable,
      model: orchestrationProvider.providerProfile?.model,
      reasoning: orchestrationProvider.providerProfile?.reasoning,
      roleSettings: orchestrationProvider.providerProfile?.roleSettings,
      profile: orchestrationProvider.profile?.profileId,
      approvalMode: orchestrationProvider.providerProfile?.approvalMode,
      ownerId: 'local-user', prompt: payload.prompt,
      correlationId: response.locals.correlationId,
      ...(payload.clarifications === true ? { clarifications: true } : {}),
      scope, claimIds, confirmations: [],
    });
    response.setHeader('cache-control', 'no-store');
    response.status(202).json(orchestration);
  }));

  app.post('/api/agent-orchestrations/:orchestrationId/continue', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.orchestrationId);
    const payload = z.object({
      expectedRevision: z.number().int().min(0),
      review: z.object({ documentRevisionId: z.string().uuid(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).strict().optional(),
      userInput: z.object({ confirmed: z.literal(true) }).strict().optional(),
    }).strict().parse(request.body);
    const current = await orchestrationService.get(id);
    if (!current) { response.status(404).json({ error: 'Agentenorchestrierung nicht gefunden.' }); return; }
    if (current.revision !== payload.expectedRevision) throw Object.assign(new Error('Die Orchestrierung wurde zwischenzeitlich veraendert.'), { statusCode: 409 });
    const application = current.scope.applicationCaseId ? await workspace.getApplicationCase(current.scope.applicationCaseId) : undefined;
    if (!application || application.revision !== current.scope.applicationCaseRevision) {
      throw Object.assign(new Error('Der Bewerbungsfall hat sich seit Start der Orchestrierung veraendert.'), { statusCode: 409 });
    }
    const confirmations = orchestrationConfirmations(
      current.workflowId, current.workflowVersion, application.id, application.revision,
      payload.review, payload.userInput,
    ).filter((confirmation) => current.unresolvedGates.some((gate) => gate.nodeId === confirmation.nodeId && gate.gate === confirmation.gate));
    if (!confirmations.length) throw Object.assign(new Error('Keine offene, passend gebundene Freigabe wurde bestaetigt.'), { statusCode: 409 });
    response.setHeader('cache-control', 'no-store');
    response.json(await orchestrationService.continue(id, confirmations));
  }));

  app.post('/api/agent-orchestrations/:orchestrationId/nodes/:nodeId/retry', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.orchestrationId);
    const nodeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/).parse(request.params.nodeId);
    const payload = z.object({
      confirmed: z.literal(true),
      reasoning: z.enum(['default','off','low','medium','high']).optional(),
      refinement: z.object({
        instructions: z.string().trim().max(8_000).default(''),
        includePreviousVersion: z.boolean().default(false),
        answers: z.array(z.object({
          id: z.string().regex(/^q[1-3]$/),
          question: z.string().trim().min(1).max(400),
          answer: z.string().trim().min(1).max(1_500),
        }).strict()).min(1).max(3).optional(),
      }).strict().optional(),
    }).strict().parse(request.body);
    const current = await orchestrationService.get(id);
    if (!current) throw Object.assign(new Error('Agentenorchestrierung nicht gefunden.'), { statusCode: 404 });
    const refinement = payload.refinement ? {
      instructions: payload.refinement.instructions,
      ...(payload.refinement.answers ? { answers: payload.refinement.answers } : {}),
    } : undefined;
    if (refinement && refinement.answers && payload.refinement?.includePreviousVersion) {
      throw Object.assign(new Error('Antworten und eine vorherige Fassung schließen sich aus.'), { statusCode: 400 });
    }
    response.setHeader('cache-control', 'no-store');
    response.status(202).json(await orchestrationService.retryNode(id, nodeId, refinement, payload.reasoning));
  }));

  app.post('/api/agent-orchestrations/:orchestrationId/cancel', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.orchestrationId);
    const payload = z.object({ expectedRevision: z.number().int().min(0), confirmed: z.literal(true) }).strict().parse(request.body);
    const current = await orchestrationService.get(id);
    if (!current) { response.status(404).json({ error: 'Agentenorchestrierung nicht gefunden.' }); return; }
    if (current.revision !== payload.expectedRevision) throw Object.assign(new Error('Die Orchestrierung wurde zwischenzeitlich veraendert.'), { statusCode: 409 });
    response.setHeader('cache-control', 'no-store');
    response.json(await orchestrationService.cancel(id));
  }));

  app.post('/api/agent-orchestrations/:orchestrationId/conflicts/:conflictId/resolve', asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.orchestrationId);
    const conflictId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(request.params.conflictId);
    const payload = z.object({
      expectedRevision: z.number().int().min(0),
      variantsSha256: z.string().regex(/^[a-f0-9]{64}$/),
      strategy: z.enum(['accept_complementary', 'select_variant']),
      selectedArtifactId: z.string().uuid().optional(),
      confirmed: z.literal(true),
    }).strict().superRefine((value, context) => {
      if ((value.strategy === 'select_variant') !== Boolean(value.selectedArtifactId)) {
        context.addIssue({ code: 'custom', message: 'Eine Variantenauswahl erfordert exakt eine Artefakt-ID.' });
      }
    }).parse(request.body);
    const resolutionReference = `ui-${createHash('sha256').update(JSON.stringify({
      id, conflictId, revision: payload.expectedRevision, variantsSha256: payload.variantsSha256,
      strategy: payload.strategy, selectedArtifactId: payload.selectedArtifactId,
      correlationId: response.locals.correlationId,
    })).digest('hex')}`;
    response.setHeader('cache-control', 'no-store');
    response.json(await orchestrationService.resolveConflict(id, {
      expectedRevision: payload.expectedRevision, conflictId, variantsSha256: payload.variantsSha256,
      strategy: payload.strategy, selectedArtifactId: payload.selectedArtifactId,
      resolverId: 'local-user', resolutionReference,
    }));
  }));
}
