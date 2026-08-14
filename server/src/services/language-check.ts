import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildMinimalLocalChildEnvironment } from './process-environment.js';

const execute = promisify(execFile);

export interface LanguageCheckResult { available: boolean; backend?: string; issues: unknown[]; disclosure?: string; }

export class LocalLanguageChecker {
  constructor(private readonly skillRoot: string, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async check(documentPath: string, language = 'de-DE'): Promise<LanguageCheckResult> {
    const backend = this.environment.LANGUAGE_CHECK_BACKEND;
    if (backend !== 'languagetool' && backend !== 'hunspell') {
      return { available: false, issues: [], disclosure: 'Keine lokale Sprachprüfung konfiguriert. LANGUAGE_CHECK_BACKEND auf languagetool oder hunspell setzen.' };
    }
    const args = [resolve(this.skillRoot, 'scripts', 'language_check.py'), '--backend', backend, '--document', documentPath, '--language', language, '--format', 'json'];
    if (backend === 'languagetool') args.push('--server', this.environment.LANGUAGETOOL_URL || 'http://localhost:8010/v2/check');
    try {
      const { stdout } = await execute(this.environment.PYTHON_EXECUTABLE || 'python', args, {
        cwd: this.skillRoot, windowsHide: true, env: buildMinimalLocalChildEnvironment(this.environment)
      });
      const result = JSON.parse(stdout) as { issues?: unknown[] };
      return { available: true, backend, issues: result.issues ?? [] };
    } catch (error) {
      const stdout = typeof error === 'object' && error && 'stdout' in error ? String(error.stdout) : '';
      try {
        const result = JSON.parse(stdout) as { issues?: unknown[] };
        return { available: true, backend, issues: result.issues ?? [] };
      } catch {
        return { available: false, backend, issues: [], disclosure: 'Das konfigurierte lokale Sprachprüfungs-Backend ist nicht erreichbar.' };
      }
    }
  }
}
