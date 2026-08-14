import type { OrchestrationPlan } from './security-orchestration.js';

const noRetrySideEffect = { maxAttempts: 1, initialBackoffMs: 0, maxBackoffMs: 0, transientCategories: [] } as const;
const safeRetry = { maxAttempts: 2, initialBackoffMs: 500, maxBackoffMs: 2_000, transientCategories: ['rate_limit', 'provider_unavailable', 'transport_interrupted'] } as const;

function budget(tokens: number, toolCalls = 4) {
  return { wallTimeMs: 10 * 60_000, tokens, costMicros: 2_000_000, toolCalls, iterations: 2 };
}

export interface ApplicationAgentWorkflowTemplate {
  id: string;
  version: '1.0.0';
  title: string;
  description: string;
  requiredScope: 'search_profile' | 'application_case' | 'company';
  producesSuggestionsOnly: true;
  prohibitedActions: readonly string[];
  plan(providerId: string): OrchestrationPlan;
}

export const APPLICATION_AGENT_WORKFLOWS: readonly ApplicationAgentWorkflowTemplate[] = [
  {
    id: 'guided-job-analysis', version: '1.0.0', title: 'Jobsuche und Stellenanalyse',
    description: 'Vergleicht normalisierte JobSource-Ergebnisse, ohne den erklärbaren searchPreferenceScore als ATS-Score umzudeuten.',
    requiredScope: 'search_profile', producesSuggestionsOnly: true,
    prohibitedActions: ['submit_application', 'hide_job', 'portal_login'],
    plan: (providerId) => ({
      id: 'guided-job-analysis', version: '1.0.0', allowedProviders: [providerId], inputRefs: ['search_profile', 'job_source_results'],
      totalBudget: { wallTimeMs: 10 * 60_000, tokens: 12_000, costMicros: 4_000_000, toolCalls: 10, iterations: 4 },
      nodes: [
        { id: 'source-analysis', role: 'job_analyst', providerId, dependsOn: [], inputRefs: ['search_profile', 'job_source_results'], outputRefs: ['job_analysis'], gates: [], contextIsolationKey: 'jobs', declaredIndependentAgent: true, sideEffect: 'none', budget: budget(5_000), retry: safeRetry, failureStrategy: 'continue_unrelated' },
        { id: 'evidence-ranking', role: 'ranking_explainer', providerId, dependsOn: ['source-analysis'], inputRefs: ['search_profile', 'job_analysis'], outputRefs: ['ranking_suggestion'], gates: [], contextIsolationKey: 'ranking', declaredIndependentAgent: false, sideEffect: 'none', budget: budget(5_000), retry: safeRetry, failureStrategy: 'fail_fast' }
      ]
    })
  },
  {
    id: 'evidence-application-package', version: '1.0.0', title: 'Evidence-basierte Bewerbungsunterlagen',
    description: 'Deklariert getrennte Author-, Evidence-, ATS-, Recruiter/Style- und Finalizer-Rollen der Bewerbungs-Pipeline.',
    requiredScope: 'application_case', producesSuggestionsOnly: true,
    prohibitedActions: ['invent_claim', 'publish_unverified_claim', 'finalize_incognito', 'send_application'],
    plan: (providerId) => ({
      id: 'evidence-application-package', version: '1.0.0', allowedProviders: [providerId], inputRefs: ['job', 'candidate_evidence', 'application_case', 'application_pipeline_analysis'],
      totalBudget: { wallTimeMs: 30 * 60_000, tokens: 50_000, costMicros: 15_000_000, toolCalls: 25, iterations: 10 },
      nodes: [
        { id: 'evidence', role: 'evidence_reviewer', providerId, dependsOn: [], inputRefs: ['job', 'candidate_evidence', 'application_pipeline_analysis'], outputRefs: ['evidence_matrix'], gates: ['evidence_complete'], contextIsolationKey: 'evidence', declaredIndependentAgent: true, sideEffect: 'none', budget: budget(8_000), retry: safeRetry, failureStrategy: 'fail_fast' },
        { id: 'author', role: 'author', providerId, dependsOn: ['evidence'], inputRefs: ['job', 'application_case', 'evidence_matrix'], outputRefs: ['annotated_draft'], gates: [], contextIsolationKey: 'author', declaredIndependentAgent: false, sideEffect: 'none', budget: budget(12_000), retry: safeRetry, failureStrategy: 'fail_fast' },
        { id: 'ats', role: 'ats_reviewer', providerId, dependsOn: ['author'], inputRefs: ['annotated_draft', 'evidence_matrix'], outputRefs: ['ats_review'], gates: [], contextIsolationKey: 'ats', declaredIndependentAgent: false, sideEffect: 'none', budget: budget(6_000), retry: safeRetry, failureStrategy: 'continue_unrelated' },
        { id: 'style', role: 'recruiter_style_reviewer', providerId, dependsOn: ['author'], inputRefs: ['annotated_draft', 'evidence_matrix'], outputRefs: ['style_review'], gates: [], contextIsolationKey: 'style', declaredIndependentAgent: false, sideEffect: 'none', budget: budget(6_000), retry: safeRetry, failureStrategy: 'continue_unrelated' },
        { id: 'finalizer', role: 'finalizer', providerId, dependsOn: ['ats', 'style'], inputRefs: ['annotated_draft', 'ats_review', 'style_review', 'evidence_matrix'], outputRefs: ['package_proposal'], gates: ['user_input'], contextIsolationKey: 'final', declaredIndependentAgent: false, sideEffect: 'idempotent_local', idempotencyKey: 'assigned-per-run', budget: budget(10_000), retry: noRetrySideEffect, failureStrategy: 'fail_fast' }
      ]
    })
  },
  {
    id: 'employer-response-triage', version: '1.0.0', title: 'Unternehmensantworten und Termine',
    description: 'Behandelt Mailinhalte als untrusted, schlägt Zuordnung, Termin und Antwort vor und versendet niemals automatisch.',
    requiredScope: 'application_case', producesSuggestionsOnly: true,
    prohibitedActions: ['send_mail', 'confirm_uncertain_correlation', 'execute_calendar_invite'],
    plan: (providerId) => ({
      id: 'employer-response-triage', version: '1.0.0', allowedProviders: [providerId], inputRefs: ['untrusted_mail', 'application_case'],
      totalBudget: { wallTimeMs: 10 * 60_000, tokens: 12_000, costMicros: 4_000_000, toolCalls: 8, iterations: 4 },
      nodes: [
        { id: 'classify', role: 'mail_classifier', providerId, dependsOn: [], inputRefs: ['untrusted_mail'], outputRefs: ['classification'], gates: [], contextIsolationKey: 'mail', declaredIndependentAgent: true, sideEffect: 'none', budget: budget(4_000), retry: safeRetry, failureStrategy: 'continue_unrelated' },
        { id: 'correlate', role: 'case_correlator', providerId, dependsOn: ['classify'], inputRefs: ['classification', 'application_case'], outputRefs: ['correlation_proposal'], gates: [], contextIsolationKey: 'correlation', declaredIndependentAgent: false, sideEffect: 'none', budget: budget(3_000), retry: safeRetry, failureStrategy: 'fail_fast' },
        { id: 'respond', role: 'response_drafter', providerId, dependsOn: ['correlate'], inputRefs: ['classification', 'correlation_proposal', 'untrusted_mail', 'application_case'], outputRefs: ['response_and_calendar_proposal'], gates: ['user_input'], contextIsolationKey: 'response', declaredIndependentAgent: false, sideEffect: 'none', budget: budget(3_000), retry: safeRetry, failureStrategy: 'fail_fast' }
      ]
    })
  },
  {
    id: 'application-next-actions', version: '1.0.0', title: 'Sichere nächste Schritte',
    description: 'Erzeugt optionale, begründete nächste Schritte und firmenweite Kollisionshinweise bei getrennten Bewerbungsfällen.',
    requiredScope: 'company', producesSuggestionsOnly: true,
    prohibitedActions: ['auto_reminder', 'auto_status_change', 'merge_application_cases'],
    plan: (providerId) => ({
      id: 'application-next-actions', version: '1.0.0', allowedProviders: [providerId], inputRefs: ['company_cases', 'tracking_events'],
      totalBudget: { wallTimeMs: 10 * 60_000, tokens: 8_000, costMicros: 3_000_000, toolCalls: 6, iterations: 3 },
      nodes: [
        { id: 'next-actions', role: 'application_coordinator', providerId, dependsOn: [], inputRefs: ['company_cases', 'tracking_events'], outputRefs: ['suggestions'], gates: [], contextIsolationKey: 'company', declaredIndependentAgent: true, sideEffect: 'none', budget: budget(6_000), retry: safeRetry, failureStrategy: 'continue_unrelated' }
      ]
    })
  }
] as const;

export function getApplicationAgentWorkflow(id: string): ApplicationAgentWorkflowTemplate | undefined {
  return APPLICATION_AGENT_WORKFLOWS.find((workflow) => workflow.id === id);
}
