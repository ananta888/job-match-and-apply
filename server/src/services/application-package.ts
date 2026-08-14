import { createHash } from 'node:crypto';
import type { ApplicationCase, ApplicationPackageManifest } from '../domain/models.js';

export function createApplicationPackage(
  application: ApplicationCase,
  files: Array<{ name: string; content: string }>,
  warnings: string[],
  now: string
): ApplicationPackageManifest {
  if (application.identityMode !== 'real') throw Object.assign(new Error('Ein Bewerbungspaket benötigt eine reale Identität.'), { statusCode: 409 });
  if (application.state !== 'approved' && application.state !== 'exported') {
    throw Object.assign(new Error('Der Bewerbungsfall muss vor der Paketerstellung freigegeben sein.'), { statusCode: 409 });
  }
  if (files.length === 0) throw Object.assign(new Error('Mindestens ein freigegebenes Dokument ist erforderlich.'), { statusCode: 409 });
  for (const file of files) {
    if (/<!--\s*evidence:/i.test(file.content)) throw Object.assign(new Error(`Datei ${file.name} enthält interne Evidence-Annotationen.`), { statusCode: 409 });
  }
  return {
    applicationCaseId: application.id, jobId: application.job.id, identityId: application.identityId,
    approvedRevision: application.revision, createdAt: now,
    files: files.map((file) => ({ name: file.name, sha256: createHash('sha256').update(file.content).digest('hex'), bytes: Buffer.byteLength(file.content) })),
    warnings: [...warnings], approved: warnings.length === 0
  };
}

export function createSubmissionDryRun(application: ApplicationCase, manifest: ApplicationPackageManifest) {
  if (!manifest.approved || application.state !== 'exported' || manifest.approvedRevision > application.revision) {
    throw Object.assign(new Error('Dry Run benötigt ein gültiges freigegebenes und exportiertes Paket.'), { statusCode: 409 });
  }
  const idempotencyKey = createHash('sha256').update(`${application.id}:${manifest.files.map((file) => file.sha256).join(':')}`).digest('hex');
  return {
    mode: 'dry_run' as const, externalSideEffects: false, applicationCaseId: application.id,
    portalId: application.job.sourceId, targetUrl: application.job.url,
    files: manifest.files.map((file) => file.name), idempotencyKey,
    requiredUserActions: ['Empfänger und Dateien prüfen', 'Portalbedingungen bestätigen', 'Unmittelbar vor einer späteren echten Übergabe erneut freigeben']
  };
}
