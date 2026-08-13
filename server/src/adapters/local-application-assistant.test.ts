import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IdentityProfile, JobPosting } from '../domain/models.js';
import { LocalApplicationAssistantAdapter } from './local-application-assistant.js';

let temporaryDirectory = '';
afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = '';
});

const job: JobPosting = {
  id: 'test-job', sourceId: 'test', title: 'Senior Software Engineer', company: 'Example GmbH',
  location: 'Berlin', workModel: 'hybrid', employmentType: 'full_time', description: 'RabbitMQ', skills: ['RabbitMQ']
};
const identity: IdentityProfile = {
  id: 'real', label: 'Erika', mode: 'real', fullName: 'Erika Beispiel', email: 'erika@example.test',
  phone: '', location: 'Berlin', linkedin: '', placeholders: {}
};
const manifest = `schema_version: 1
mode: standard
execution: independent_agents
cycle: 1
passes:
  - {id: pass-author-1, role: author, independent_context: true, input_revision: source, output_revision: revision-1, findings: []}
  - {id: pass-evidence-ats-1, role: evidence_ats_reviewer, independent_context: true, input_revision: revision-1, output_revision: revision-2, findings: []}
  - {id: pass-recruiter-style-1, role: recruiter_style_reviewer, independent_context: true, input_revision: revision-2, output_revision: revision-3, findings: []}
  - {id: pass-finalizer-1, role: finalizer, independent_context: true, input_revision: revision-3, output_revision: final, findings: []}
`;

describe('LocalApplicationAssistantAdapter', () => {
  it('runs the deterministic skill gates and strips evidence only after success', async () => {
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'application-pipeline-'));
    const repositoryRoot = resolve(process.cwd(), '..');
    const adapter = new LocalApplicationAssistantAdapter({
      skillPath: resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent'),
      candidateProfilePath: resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent', 'tests', 'fixtures', 'valid-candidate.yaml'),
      styleProfilePath: resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent', 'tests', 'fixtures', 'valid-style.yaml')
    }, temporaryDirectory);
    const result = await adapter.finalize({
      job,
      identity,
      documentType: 'cover_letter',
      annotatedContent: 'Guten Tag, <!-- evidence: editorial -->\n\nAls Senior Software Engineer arbeitete ich bei Example GmbH. <!-- evidence: claim-role -->\n',
      iterationManifest: manifest
    });
    expect(result.lifecycle).toBe('final');
    expect(result.content).not.toContain('<!-- evidence:');
    expect(await readFile(resolve(temporaryDirectory, 'test-job', 'annotated.md'), 'utf8')).toContain('claim-role');
  });
});
