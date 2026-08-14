import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ApplicationArtifactRevision, ApplicationCase } from '../domain/models.js';
import type { WorkspaceStore } from './workspace-store.js';
import { companyKey } from './mail-correlation.js';

export async function createArtifactRevision(
  workspace: WorkspaceStore, application: ApplicationCase,
  input: { type: ApplicationArtifactRevision['type']; content: string; pipelineContractVersion: string },
  workRoot = resolve(process.cwd(), '..', '.application-work')
): Promise<ApplicationArtifactRevision> {
  const id = randomUUID(); const data = Buffer.from(input.content, 'utf8'); const directory = resolve(workRoot, application.id, 'revisions');
  await mkdir(directory, { recursive: true }); const extension = input.type === 'application_email' ? 'txt' : 'md'; const artifactPath = resolve(directory, `${id}.${extension}`);
  await writeFile(artifactPath, data, { mode: 0o600 });
  const revision: ApplicationArtifactRevision = {
    id, applicationCaseId: application.id, companyKey: companyKey(application.job.company), jobId: application.job.id,
    type: input.type, lifecycle: 'proposed', sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length,
    artifactPath: artifactPath.slice(workRoot.length + 1).replaceAll('\\', '/'), pipelineContractVersion: input.pipelineContractVersion,
    createdAt: new Date().toISOString()
  };
  await workspace.saveArtifactRevision(revision); return revision;
}

export async function markArtifactUsed(workspace: WorkspaceStore, application: ApplicationCase, revisionId: string): Promise<ApplicationArtifactRevision> {
  const revision = (await workspace.listArtifactRevisions(application.id)).find((item) => item.id === revisionId);
  if (!revision) throw Object.assign(new Error('Dokumentrevision nicht gefunden.'), { statusCode: 404 });
  if (application.identityMode !== 'real') throw Object.assign(new Error('Inkognito-Dokumente dürfen nicht als verwendet markiert werden.'), { statusCode: 409 });
  const used = { ...revision, lifecycle: 'used' as const, usedAt: new Date().toISOString(), usedForApplicationCaseId: application.id };
  await workspace.saveArtifactRevision(used); return used;
}
