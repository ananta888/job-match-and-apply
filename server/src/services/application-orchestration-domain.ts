import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ApplicationOrchestrationGateAuthority,
  ApplicationOrchestrationInputResolver,
  RevisionBoundGateConfirmation,
} from '../agents/application-orchestration-service.js';
import type { ApplicationOrchestrationScope } from '../agents/application-orchestration-store.js';
import { LocalCandidateProfileAdapter } from '../adapters/local-candidate-profile.js';
import { LocalApplicationAssistantAdapter } from '../adapters/local-application-assistant.js';
import type { ConfigStore } from './config-store.js';
import type { WorkspaceStore } from './workspace-store.js';
import type { EncryptedMailVault } from './mail-vault.js';
import { companyKey } from './mail-correlation.js';
import { canonicalJson } from '../agents/security-approval.js';
import { readVerifiedArtifactRevision } from './artifact-revisions.js';
import type { ApplicationPipelineProofAuthority } from './application-pipeline-proof.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

interface ConfirmationBody {
  v: 1;
  workflowId: string;
  workflowVersion: string;
  nodeId: string;
  gate: 'review_complete' | 'user_input';
  applicationCaseId: string;
  applicationCaseRevision: number;
  documentRevisionId?: string;
  documentRevisionSha256?: string;
  issuedAt: number;
}

function sourceReference(value: string): string {
  return `local:${sha256(value)}`;
}

function safeMail(message: Awaited<ReturnType<EncryptedMailVault['listMessages']>>[number]) {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    subject: message.subject,
    sentAt: message.sentAt,
    text: message.text,
    responseKind: message.responseKind,
    correlation: message.correlation,
    sourceReference: sourceReference(`mail:${message.id}`),
    trust: 'untrusted_data',
  };
}

/** Server-owned workflow inputs and cryptographic gate bindings. */
export class LocalApplicationOrchestrationDomain
implements ApplicationOrchestrationGateAuthority, ApplicationOrchestrationInputResolver {
  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly config: ConfigStore,
    private readonly mailVault: EncryptedMailVault,
    private readonly proofAuthority: ApplicationPipelineProofAuthority,
    private readonly workRoot: string,
    private readonly confirmationKey: Buffer,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (confirmationKey.byteLength < 32) throw new Error('application_orchestration_confirmation_key_too_short');
  }

  issueConfirmation(input: Omit<ConfirmationBody, 'v' | 'issuedAt'>): string {
    const body: ConfirmationBody = { v: 1, ...structuredClone(input), issuedAt: this.clock().getTime() };
    const encoded = Buffer.from(canonicalJson(body), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.confirmationKey).update(encoded, 'utf8').digest('base64url');
    return `${encoded}.${signature}`;
  }

  async evidenceComplete(input: {
    workflowId: string;
    workflowVersion: string;
    nodeId: string;
    scope: Readonly<ApplicationOrchestrationScope>;
    claimIds: readonly string[];
  }): Promise<{ complete: boolean; bindingSha256?: string }> {
    if (input.workflowId !== 'evidence-application-package' || !input.scope.applicationCaseId || !input.claimIds.length) return { complete: false };
    const settings = (await this.config.load()).assistant;
    const summary = await new LocalCandidateProfileAdapter(settings).summary();
    if (!summary.valid) return { complete: false };
    const claims = input.claimIds.map((id) => summary.claims.find((claim) => claim.id === id));
    if (claims.some((claim) => !claim || !['verified', 'user_confirmed'].includes(claim.status) || claim.evidenceRefs.length === 0)) {
      return { complete: false };
    }
    return { bindingSha256: sha256(canonicalJson({
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
      nodeId: input.nodeId,
      applicationCaseId: input.scope.applicationCaseId,
      claims: claims.map((claim) => ({
        id: claim!.id, status: claim!.status, evidenceRefs: [...claim!.evidenceRefs].sort(), statementSha256: sha256(claim!.statement),
      })).sort((left, right) => left.id.localeCompare(right.id)),
    })), complete: true };
  }

  async verifyRevisionConfirmation(input: {
    workflowId: string;
    workflowVersion: string;
    scope: Readonly<ApplicationOrchestrationScope>;
    confirmation: Readonly<RevisionBoundGateConfirmation>;
  }): Promise<{ valid: boolean; bindingSha256?: string }> {
    const body = this.verifyReference(input.confirmation.confirmationReference);
    if (!body || body.workflowId !== input.workflowId || body.workflowVersion !== input.workflowVersion
      || body.nodeId !== input.confirmation.nodeId || body.gate !== input.confirmation.gate
      || body.applicationCaseId !== input.confirmation.applicationCaseId
      || body.applicationCaseRevision !== input.confirmation.applicationCaseRevision
      || body.documentRevisionId !== input.confirmation.documentRevisionId
      || body.documentRevisionSha256 !== input.confirmation.documentRevisionSha256
      || body.applicationCaseId !== input.scope.applicationCaseId
      || body.applicationCaseRevision !== input.scope.applicationCaseRevision
      || this.clock().getTime() - body.issuedAt > 15 * 60_000 || body.issuedAt > this.clock().getTime() + 5_000) return { valid: false };
    const application = await this.workspace.getApplicationCase(body.applicationCaseId);
    if (!application || application.revision !== body.applicationCaseRevision) return { valid: false };
    if (body.gate === 'review_complete') {
      if (!body.documentRevisionId || !body.documentRevisionSha256) return { valid: false };
      try {
        const { revision } = await readVerifiedArtifactRevision(
          this.workspace, application, body.documentRevisionId, this.proofAuthority, this.workRoot,
        );
        if (revision.sha256 !== body.documentRevisionSha256 || revision.lifecycle !== 'approved'
          || revision.review?.decision !== 'approved') return { valid: false };
      } catch { return { valid: false }; }
    }
    return { valid: true, bindingSha256: sha256(canonicalJson(body)) };
  }

  async resolve(input: {
    orchestrationId: string;
    workflowId: string;
    workflowVersion: string;
    nodeId: string;
    role: string;
    reference: string;
    scope: Readonly<ApplicationOrchestrationScope>;
    signal: AbortSignal;
  }): Promise<{ content: string; sha256?: string }> {
    if (input.signal.aborted) throw new Error('orchestration_cancelled');
    const configuration = await this.config.load();
    const application = input.scope.applicationCaseId
      ? await this.workspace.getApplicationCase(input.scope.applicationCaseId) : undefined;
    let value: unknown;
    switch (input.reference) {
      case 'search_profile':
        value = { ...configuration.searchProfile, meaning: 'preference_only_not_candidate_evidence' };
        break;
      case 'job_source_results': {
        const latest = (await this.workspace.listSearchRuns())[0];
        value = latest ? {
          searchRunId: latest.id,
          matches: latest.matches.slice(0, 20).map((match) => ({
            job: match.job, searchPreferenceScore: match.searchPreferenceScore,
            acceptedByPreferences: match.accepted, matchedMustHave: match.matchedMustHave,
            missingMustHave: match.missingMustHave, sourceReference: sourceReference(`search:${latest.id}:${match.job.id}`),
          })),
        } : { matches: [] };
        break;
      }
      case 'job':
        if (!application) throw new Error('orchestration_application_case_not_found');
        value = { ...application.job, trust: 'untrusted_job_posting', sourceReference: sourceReference(`job:${application.job.id}`) };
        break;
      case 'candidate_evidence': {
        const profile = await new LocalCandidateProfileAdapter(configuration.assistant).summary();
        if (!profile.valid) throw new Error('orchestration_candidate_profile_invalid');
        value = {
          contractVersion: profile.contractVersion,
          claims: profile.claims.filter((claim) => ['verified', 'user_confirmed'].includes(claim.status) && claim.evidenceRefs.length)
            .map((claim) => ({ ...claim, sourceReference: sourceReference(`claim:${claim.id}`) })),
        };
        break;
      }
      case 'application_pipeline_analysis': {
        if (!application) throw new Error('orchestration_application_case_not_found');
        const assistant = new LocalApplicationAssistantAdapter(configuration.assistant, this.workRoot);
        const analysis = await assistant.analyze(application.job, application.documentType);
        const validation = await assistant.validateMatchMatrix(analysis.matchMatrix, application.documentType);
        if (!validation.valid) throw new Error('orchestration_application_match_matrix_invalid');
        value = {
          contract: 'bewerbungs-pipeline-analysis',
          contractVersion: '1.0',
          jobAnalysis: analysis.jobAnalysis,
          matchMatrix: analysis.matchMatrix,
          unresolvedQuestions: Array.isArray(analysis.matchMatrix.unresolved_questions)
            ? analysis.matchMatrix.unresolved_questions : [],
          validation: { valid: true },
          sourceReference: sourceReference(`application-analysis:${application.id}:${application.revision}`),
        };
        break;
      }
      case 'application_case':
        if (!application) throw new Error('orchestration_application_case_not_found');
        if (input.workflowId === 'employer-response-triage') {
          const key = companyKey(application.job.company);
          value = {
            primaryApplicationCaseId: application.id,
            candidates: (await this.workspace.listApplicationCases())
              .filter((candidate) => companyKey(candidate.job.company) === key)
              .slice(0, 100)
              .map((candidate) => ({
                id: candidate.id, revision: candidate.revision, state: candidate.state,
                documentType: candidate.documentType, identityMode: candidate.identityMode,
                jobId: candidate.job.id, jobTitle: candidate.job.title, company: candidate.job.company,
                sourceReference: sourceReference(`application:${candidate.id}:${candidate.revision}`),
              })),
          };
        } else {
          value = {
            id: application.id, revision: application.revision, state: application.state,
            documentType: application.documentType, identityMode: application.identityMode,
            jobId: application.job.id, company: application.job.company,
            sourceReference: sourceReference(`application:${application.id}:${application.revision}`),
          };
        }
        break;
      case 'untrusted_mail': {
        if (!application) throw new Error('orchestration_application_case_not_found');
        const messages = await this.mailVault.listMessages();
        value = input.scope.mailId
          ? messages.filter((message) => message.id === input.scope.mailId).map(safeMail)
          : messages.filter((message) => message.correlation.applicationCaseId === application.id).slice(0, 20).map(safeMail);
        if (input.scope.mailId && (value as unknown[]).length !== 1) throw new Error('orchestration_mail_not_found');
        break;
      }
      case 'company_cases': {
        if (!input.scope.companyKey) throw new Error('orchestration_company_scope_required');
        value = (await this.workspace.listApplicationCases())
          .filter((candidate) => companyKey(candidate.job.company) === input.scope.companyKey)
          .map((candidate) => ({
            id: candidate.id, revision: candidate.revision, state: candidate.state,
            job: { id: candidate.job.id, title: candidate.job.title, company: candidate.job.company },
            sourceReference: sourceReference(`application:${candidate.id}:${candidate.revision}`),
          }));
        break;
      }
      case 'tracking_events': {
        if (!input.scope.companyKey) throw new Error('orchestration_company_scope_required');
        const cases = (await this.workspace.listApplicationCases())
          .filter((candidate) => companyKey(candidate.job.company) === input.scope.companyKey);
        value = (await Promise.all(cases.map(async (candidate) => ({
          applicationCaseId: candidate.id,
          events: (await this.workspace.listTrackingEvents(candidate.id)).map((event) => ({
            ...event,
            sourceReference: event.sourceReference
              ?? sourceReference(`tracking:${candidate.id}:${event.id}`),
          })),
        }))));
        break;
      }
      default:
        throw new Error(`orchestration_input_reference_not_supported:${input.reference}`);
    }
    const content = JSON.stringify(value);
    return { content, sha256: sha256(content) };
  }

  private verifyReference(reference: string): ConfirmationBody | undefined {
    const [encoded, signature, extra] = reference.split('.');
    if (!encoded || !signature || extra !== undefined) return undefined;
    const expected = createHmac('sha256', this.confirmationKey).update(encoded, 'utf8').digest();
    let actual: Buffer;
    try { actual = Buffer.from(signature, 'base64url'); }
    catch { return undefined; }
    if (actual.toString('base64url') !== signature || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    try {
      const decoded = Buffer.from(encoded, 'base64url');
      if (decoded.toString('base64url') !== encoded) return undefined;
      const body = JSON.parse(decoded.toString('utf8')) as ConfirmationBody;
      if (body.v !== 1 || !['review_complete', 'user_input'].includes(body.gate)
        || !Number.isSafeInteger(body.applicationCaseRevision) || !Number.isFinite(body.issuedAt)) return undefined;
      return body;
    } catch { return undefined; }
  }
}
