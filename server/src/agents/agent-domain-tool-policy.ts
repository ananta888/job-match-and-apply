import type { AgentRunRequest } from '../ports/agent-runner.js';

export const ROOT_DOMAIN_TOOL_NAMES = [
  'jobs.search',
  'job_search.capabilities',
  'job_search.search',
  'applications.get',
  'companies.get',
  'application.tracking.list',
  'messages.list',
  'application.analyze',
  'application.pipeline.audit',
  'mail.correlation.propose',
  'application.status.propose',
  'reminder.propose',
  'document.revision.propose',
  'domain.command.confirm',
  'domain.command.execute_local',
] as const;

const workflowTools: Readonly<Record<string, readonly string[]>> = {
  // CV source text is untrusted document data. Structuring runs may only
  // produce a schema-bound proposal and must never inherit the default
  // no-case job-search tool set (including the trusted-host Job MCP).
  'cv-ai-structuring': [],
  'guided-job-analysis': ['jobs.search', 'job_search.capabilities', 'job_search.search'],
  'evidence-application-package': [
    'applications.get', 'companies.get', 'application.tracking.list', 'application.analyze', 'application.pipeline.audit',
    'document.revision.propose',
  ],
  'employer-response-triage': [
    'applications.get', 'companies.get', 'application.tracking.list', 'messages.list', 'mail.correlation.propose',
    'application.status.propose', 'reminder.propose', 'domain.command.confirm', 'domain.command.execute_local',
  ],
  'application-next-actions': [
    'applications.get', 'companies.get', 'application.tracking.list', 'messages.list', 'application.status.propose', 'reminder.propose',
    'domain.command.confirm', 'domain.command.execute_local',
  ],
};

export function allowedRootDomainTools(input: Pick<AgentRunRequest, 'applicationCaseId' | 'metadata'>): string[] {
  const workflowId = typeof input.metadata?.workflowId === 'string' ? input.metadata.workflowId : undefined;
  const declared = workflowId ? workflowTools[workflowId] : undefined;
  if (declared) return [...declared];
  return input.applicationCaseId
    ? [
        'applications.get', 'companies.get', 'application.tracking.list', 'application.analyze',
        'application.pipeline.audit', 'document.revision.propose', 'application.status.propose',
      ]
    : ['jobs.search', 'job_search.capabilities', 'job_search.search'];
}

export function providerSupportsRootDomainTools(provider: string, runtimeTarget: string): boolean {
  // OpenCode and Claude use exact-version, prompt-context-only contracts. The
  // Codex App Server dynamic-tool bridge is currently verified only natively.
  return provider === 'codex-exec' && runtimeTarget !== 'wsl';
}
