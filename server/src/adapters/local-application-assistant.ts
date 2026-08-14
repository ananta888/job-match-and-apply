import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig, ApplicationDraft, ApplicationPipelineCapabilities, CandidateMatchAnalysis, IdentityProfile, JobPosting } from '../domain/models.js';
import type { ApplicationAssistantPort, FinalizeApplicationCommand } from '../ports/application-assistant.js';
import YAML from 'yaml';
import { buildMinimalLocalChildEnvironment } from '../services/process-environment.js';
import { LocalLanguageChecker } from '../services/language-check.js';

const execute = promisify(execFile);

function policyError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 409 });
}

export class LocalApplicationAssistantAdapter implements ApplicationAssistantPort {
  constructor(
    private readonly settings: AppConfig['assistant'],
    private readonly workRoot = resolve(process.cwd(), '..', '.application-work'),
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  async capabilities(): Promise<ApplicationPipelineCapabilities> {
    const skillRoot = this.projectPath(this.settings.skillPath);
    const python = process.env.PYTHON_EXECUTABLE || 'python';
    try {
      const { stdout } = await execute(python, [resolve(skillRoot, 'scripts', 'pipeline_contract.py'), 'capabilities'], {
        cwd: skillRoot, windowsHide: true, env: buildMinimalLocalChildEnvironment()
      });
      const result = JSON.parse(stdout) as Record<string, unknown>;
      const contractVersion = String(result.contract_version ?? '0');
      return {
        contract: 'bewerbungs-pipeline', contractVersion,
        compatible: result.contract === 'bewerbungs-pipeline' && Number.parseInt(contractVersion.split('.')[0] ?? '', 10) === 1,
        stages: Array.isArray(result.stages) ? result.stages.map(String) : [],
        documentTypes: Array.isArray(result.document_types) ? result.document_types.map(String) : [],
        blockingSeverities: Array.isArray(result.blocking_severities) ? result.blocking_severities.map(String) : [],
        publishableClaimStatuses: Array.isArray(result.publishable_claim_statuses) ? result.publishable_claim_statuses.map(String) : [],
        networkRequired: Boolean(result.network_required)
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`Bewerbungs-Pipeline-Vertrag ist nicht verfügbar: ${detail}`), { statusCode: 503 });
    }
  }

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

  async analyze(job: JobPosting, documentType: 'cv' | 'cover_letter' | 'email'): Promise<CandidateMatchAnalysis> {
    const skillRoot = this.projectPath(this.settings.skillPath);
    const candidate = this.projectPath(this.settings.candidateProfilePath);
    const runDirectory = resolve(this.workRoot, job.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'job');
    await mkdir(runDirectory, { recursive: true });
    const jobPath = resolve(runDirectory, 'job.json');
    const analysisPath = resolve(runDirectory, 'job-analysis.yaml');
    const matrixPath = resolve(runDirectory, 'match-matrix.yaml');
    let previousAnalysis: Record<string, unknown> | undefined;
    try { previousAnalysis = YAML.parse(await readFile(analysisPath, 'utf8')) as Record<string, unknown>; } catch { previousAnalysis = undefined; }
    await writeFile(jobPath, JSON.stringify(job), { encoding: 'utf8', mode: 0o600 });
    const python = process.env.PYTHON_EXECUTABLE || 'python';
    const script = resolve(skillRoot, 'scripts', 'match_contract.py');
    try {
      await execute(python, [script, 'analyze', '--job', jobPath, '--output', analysisPath], { cwd: skillRoot, windowsHide: true, env: buildMinimalLocalChildEnvironment() });
      await execute(python, [script, 'match', '--analysis', analysisPath, '--candidate', candidate, '--output-type', documentType, '--output', matrixPath], { cwd: skillRoot, windowsHide: true, env: buildMinimalLocalChildEnvironment() });
      const jobAnalysis = YAML.parse(await readFile(analysisPath, 'utf8')) as Record<string, unknown>;
      const requirementText = (value?: Record<string, unknown>) => new Set(
        Array.isArray(value?.requirements) ? (value.requirements as Record<string, unknown>[]).map((item) => String(item.original_text)) : []
      );
      const before = requirementText(previousAnalysis); const after = requirementText(jobAnalysis);
      jobAnalysis.delta = previousAnalysis ? {
        previousAnalysisVersion: previousAnalysis.analysis_version,
        addedRequirements: [...after].filter((item) => !before.has(item)),
        removedRequirements: [...before].filter((item) => !after.has(item))
      } : { previousAnalysisVersion: null, addedRequirements: [...after], removedRequirements: [] };
      return {
        jobAnalysis,
        matchMatrix: YAML.parse(await readFile(matrixPath, 'utf8')) as Record<string, unknown>
      };
    } catch (error) {
      const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr).trim() : '';
      throw policyError(stderr || 'Jobanalyse oder Evidence-Matching ist fehlgeschlagen.');
    }
  }

  async validateMatchMatrix(matrix: Record<string, unknown>, documentType: 'cv' | 'cover_letter' | 'email'): Promise<{ valid: boolean; errors: string[] }> {
    const skillRoot = this.projectPath(this.settings.skillPath);
    const candidate = this.projectPath(this.settings.candidateProfilePath);
    const runDirectory = resolve(this.workRoot, 'match-validation');
    await mkdir(runDirectory, { recursive: true });
    const matrixPath = resolve(runDirectory, 'reviewed-match-matrix.yaml');
    await writeFile(matrixPath, YAML.stringify(matrix), { encoding: 'utf8', mode: 0o600 });
    try {
      const { stdout } = await execute(process.env.PYTHON_EXECUTABLE || 'python', [
        resolve(skillRoot, 'scripts', 'match_contract.py'), 'validate-match', '--matrix', matrixPath,
        '--candidate', candidate, '--output-type', documentType
      ], { cwd: skillRoot, windowsHide: true, env: buildMinimalLocalChildEnvironment() });
      return JSON.parse(stdout) as { valid: boolean; errors: string[] };
    } catch (error) {
      const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr).trim() : '';
      throw policyError(stderr || 'Match-Matrix konnte nicht validiert werden.');
    }
  }

  async preview(job: JobPosting, identity: IdentityProfile, documentType: 'cv' | 'cover_letter' | 'email'): Promise<ApplicationDraft> {
    const relevance = `Die Position ${job.title} bei ${job.company} entspricht meinem Suchinteresse.`;
    const content = documentType === 'cv'
      ? `# ${identity.fullName}\n\n${identity.email} · ${identity.phone} · ${identity.location}\n\n## Zielprofil: ${job.title}\n\n[Hier ausschließlich freigegebene, für ${job.company} relevante Claims aus der Evidence-Matrix übernehmen.]\n\n## Berufserfahrung\n\n[Belegte Stationen und Ergebnisse, antichronologisch.]\n\n## Kompetenzen\n\n[Belegte Muss- und Wunschkompetenzen aus der Match-Matrix.]`
      : documentType === 'email'
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
    const preparation = await this.analyze(command.job, command.documentType);
    const matrixValidation = await this.validateMatchMatrix(preparation.matchMatrix, command.documentType);
    if (!matrixValidation.valid) throw policyError('Die Evidence-Match-Matrix ist nicht gueltig; Finalisierung bleibt gesperrt.');
    const draft = await this.finalizeWithoutEvidence(command);
    const skillRoot = this.projectPath(this.settings.skillPath);
    const candidate = this.projectPath(this.settings.candidateProfilePath);
    const style = this.projectPath(this.settings.styleProfilePath);
    const safeJobId = command.job.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'job';
    const runDirectory = resolve(this.workRoot, safeJobId);
    const annotated = resolve(runDirectory, 'annotated.md');
    const manifest = resolve(runDirectory, 'iteration.yaml');
    const analysisPath = resolve(runDirectory, 'job-analysis.yaml');
    const matrixPath = resolve(runDirectory, 'match-matrix.yaml');
    const [annotatedContent, iterationContent, candidateContent, styleContent, analysisContent, matrixContent, capabilities] = await Promise.all([
      readFile(annotated, 'utf8'),
      readFile(manifest, 'utf8'),
      readFile(candidate, 'utf8'),
      readFile(style, 'utf8'),
      readFile(analysisPath, 'utf8'),
      readFile(matrixPath, 'utf8'),
      this.capabilities()
    ]);
    if (!capabilities.compatible) throw policyError('Die Bewerbungs-Pipeline ist nicht vertragskompatibel.');
    const styleDocument = YAML.parse(styleContent) as {
      style_profile?: { locale?: unknown };
      language_quality?: { language?: unknown };
    } | undefined;
    const language = typeof styleDocument?.language_quality?.language === 'string'
      ? styleDocument.language_quality.language
      : typeof styleDocument?.style_profile?.locale === 'string'
        ? styleDocument.style_profile.locale
        : 'de-DE';
    const languageResult = await new LocalLanguageChecker(skillRoot, this.environment)
      .check(resolve(runDirectory, 'final.md'), language);
    if (!languageResult.available || !languageResult.backend) {
      throw policyError('Die lokale Sprachpr\u00fcfung ist nicht verf\u00fcgbar; Finalisierung bleibt gesperrt.');
    }
    const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
    const artifactSha256 = sha256(draft.content);
    return {
      ...draft,
      warnings: [
        ...draft.warnings.filter((warning) => !warning.includes('LanguageTool') && !warning.includes('Hunspell')),
        languageResult.issues.length === 0
          ? 'Die lokale Sprachpr\u00fcfung hat keine Hinweise gefunden.'
          : `Die lokale Sprachpr\u00fcfung hat ${languageResult.issues.length} Hinweis(e) gefunden; die Freigabe muss diese Anzahl best\u00e4tigen.`
      ],
      pipelineEvidence: {
        pipelineContractVersion: capabilities.contractVersion,
        completedStages: [
          'validate_profiles', 'analyze_job', 'build_match_matrix', 'questions_reviewed',
          'validate_iteration', 'audit_claims', 'check_style',
        ],
        annotatedSha256: sha256(annotatedContent),
        iterationManifestSha256: sha256(iterationContent),
        candidateProfileSha256: sha256(candidateContent),
        styleProfileSha256: sha256(styleContent),
        artifactSha256,
        preparation: {
          jobAnalysisSha256: sha256(analysisContent),
          matchMatrixSha256: sha256(matrixContent),
          unresolvedQuestionsSha256: sha256(JSON.stringify(
            Array.isArray(preparation.matchMatrix.unresolved_questions)
              ? preparation.matchMatrix.unresolved_questions : [],
          )),
          matchMatrixValid: true,
        },
        languageCheck: {
          available: true,
          backend: languageResult.backend,
          language,
          issueCount: languageResult.issues.length,
          issuesSha256: sha256(JSON.stringify(languageResult.issues)),
          checkedArtifactSha256: artifactSha256
        }
      }
    };
  }

  private async finalizeWithoutEvidence(command: FinalizeApplicationCommand): Promise<ApplicationDraft> {
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
    try {
      const { stdout } = await execute(python, [
        resolve(skillRoot, 'scripts', 'pipeline_contract.py'), 'finalize',
        '--candidate', candidate, '--style', style, '--document', annotated, '--manifest', manifest,
        '--output-type', command.documentType, '--final-document', finalDocument
      ], { cwd: skillRoot, windowsHide: true, env: buildMinimalLocalChildEnvironment() });
      const result = JSON.parse(stdout) as { status?: string; error?: { safe_detail?: string } };
      if (result.status !== 'final') throw policyError(result.error?.safe_detail || 'Die Pipeline hat die Finalisierung abgelehnt.');
    } catch (error) {
      if (typeof error === 'object' && error && 'statusCode' in error) throw error;
      const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr).trim() : '';
      throw policyError(stderr || 'Die versionierte Bewerbungs-Pipeline ist fehlgeschlagen.');
    }

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
