import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig, ApplicationDraft, IdentityProfile, JobPosting } from '../domain/models.js';
import type { ApplicationAssistantPort, FinalizeApplicationCommand } from '../ports/application-assistant.js';

const execute = promisify(execFile);

function policyError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 409 });
}

export class LocalApplicationAssistantAdapter implements ApplicationAssistantPort {
  constructor(
    private readonly settings: AppConfig['assistant'],
    private readonly workRoot = resolve(process.cwd(), '..', '.application-work')
  ) {}

  async status(): Promise<{ available: boolean; note: string }> {
    try {
      const root = this.projectPath(this.settings.skillPath);
      await Promise.all([
        access(resolve(root, 'SKILL.md')),
        access(resolve(root, 'scripts', 'validate_profiles.py')),
        access(this.projectPath(this.settings.candidateProfilePath)),
        access(this.projectPath(this.settings.styleProfilePath))
      ]);
      return { available: true, note: 'Bewerbungs-Skill und private Profile sind für die Prüf-Pipeline bereit.' };
    } catch {
      return { available: false, note: 'Skill oder private Profile fehlen. npm run setup:integrations ausführen und Profile pflegen.' };
    }
  }

  async preview(job: JobPosting, identity: IdentityProfile, documentType: 'cover_letter' | 'email'): Promise<ApplicationDraft> {
    const relevance = `Die Position ${job.title} bei ${job.company} entspricht meinem Suchinteresse.`;
    const content = documentType === 'email'
      ? `Guten Tag,\n\n${relevance}\n\nIm Anhang finden Sie meine Unterlagen. Über ein Gespräch freue ich mich.\n\nFreundliche Grüße\n${identity.fullName}`
      : `Guten Tag,\n\n${relevance}\n\nDies ist nur eine Vorschau. Berufserfahrung, Fähigkeiten und Ergebnisse werden erst durch die evidenzbasierte Bewerbungspipeline aus verifizierten Claims ergänzt.\n\nFreundliche Grüße\n${identity.fullName}`;
    return {
      jobId: job.id,
      identityId: identity.id,
      documentType,
      content,
      strongestMatches: [],
      gaps: [],
      warnings: [
        identity.mode === 'incognito' ? 'Inkognito-Vorschau: Finalisierung und Versand sind gesperrt.' : '',
        'Suchpräferenzen sind keine Kandidatennachweise. Für ein finales Dokument ist die Evidence-Pipeline erforderlich.'
      ].filter(Boolean),
      lifecycle: 'preview'
    };
  }

  async finalize(command: FinalizeApplicationCommand): Promise<ApplicationDraft> {
    if (command.identity.mode === 'incognito') {
      throw policyError('Inkognito-Identitäten dürfen nur Vorschauen erzeugen. Für die Finalisierung ist eine reale Identität erforderlich.');
    }
    const skillRoot = this.projectPath(this.settings.skillPath);
    const candidate = this.projectPath(this.settings.candidateProfilePath);
    const style = this.projectPath(this.settings.styleProfilePath);
    const safeJobId = command.job.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'job';
    const runDirectory = resolve(this.workRoot, safeJobId);
    await mkdir(runDirectory, { recursive: true });
    const annotated = resolve(runDirectory, 'annotated.md');
    const manifest = resolve(runDirectory, 'iteration.yaml');
    const finalDocument = resolve(runDirectory, 'final.md');
    await writeFile(annotated, command.annotatedContent, { encoding: 'utf8', mode: 0o600 });
    await writeFile(manifest, command.iterationManifest, { encoding: 'utf8', mode: 0o600 });

    const python = process.env.PYTHON_EXECUTABLE || 'python';
    const run = async (script: string, args: string[]): Promise<void> => {
      try {
        await execute(python, [resolve(skillRoot, 'scripts', script), ...args], { cwd: skillRoot, windowsHide: true });
      } catch (error) {
        const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr).trim() : '';
        throw policyError(stderr || `Prüfung ${script} ist fehlgeschlagen.`);
      }
    };

    await run('validate_profiles.py', ['--candidate', candidate, '--style', style]);
    await run('validate_iteration.py', ['--manifest', manifest]);
    await run('audit_claims.py', ['--candidate', candidate, '--document', annotated, '--output-type', command.documentType, '--strict']);
    await run('check_style.py', ['--style', style, '--document', annotated, '--document-type', command.documentType]);
    await run('audit_claims.py', ['--candidate', candidate, '--document', annotated, '--output-type', command.documentType, '--strict', '--strip-to', finalDocument]);

    return {
      jobId: command.job.id,
      identityId: command.identity.id,
      documentType: command.documentType,
      content: await readFile(finalDocument, 'utf8'),
      strongestMatches: [],
      gaps: [],
      warnings: [
        'Profile, Claims, Stil und Review-Manifest wurden deterministisch geprüft.',
        'Eine klassische Sprachprüfung benötigt ein separat konfiguriertes lokales LanguageTool- oder Hunspell-Backend und muss vor externer Nutzung ausgeführt werden.'
      ],
      lifecycle: 'final'
    };
  }

  private projectPath(relativeOrAbsolute: string): string {
    return resolve(process.cwd(), '..', relativeOrAbsolute);
  }
}
