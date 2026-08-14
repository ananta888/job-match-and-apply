import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import germanDictionary from 'dictionary-de';
import englishDictionary from 'dictionary-en';
import nspell from 'nspell';
import { buildMinimalLocalChildEnvironment } from './process-environment.js';

const execute = promisify(execFile);
const MAX_LOCAL_ISSUES = 200;
const TOKEN = /[\p{L}][\p{L}\p{M}'’\-]*/gu;
const EXCLUDED_SPAN = /https?:\/\/\S+|\b\S+@\S+\.\S+\b|`[^`]*`/giu;

export interface LocalSpellingIssue {
  kind: 'spelling';
  ruleId: 'local-dictionary';
  word: string;
  offset: number;
  length: number;
  suggestions: string[];
}

export interface LanguageCheckResult {
  available: boolean;
  backend?: string;
  issues: unknown[];
  disclosure?: string;
}

function overlapsExcludedSpan(start: number, end: number, spans: Array<[number, number]>): boolean {
  return spans.some(([spanStart, spanEnd]) => start < spanEnd && end > spanStart);
}

function dictionaryFor(language: string) {
  const normalized = language.trim().toLowerCase();
  if (normalized === 'de' || normalized.startsWith('de-')) return germanDictionary;
  if (normalized === 'en' || normalized.startsWith('en-')) return englishDictionary;
  return undefined;
}

async function checkWithBundledDictionary(documentPath: string, language: string): Promise<LanguageCheckResult> {
  const dictionary = dictionaryFor(language);
  if (!dictionary) {
    return {
      available: false,
      backend: 'nspell',
      issues: [],
      disclosure: `F\u00fcr ${language} ist kein lokales W\u00f6rterbuch installiert.`
    };
  }

  try {
    const text = await readFile(documentPath, 'utf8');
    const checker = nspell({ aff: Buffer.from(dictionary.aff), dic: Buffer.from(dictionary.dic) });
    const excluded = Array.from(text.matchAll(EXCLUDED_SPAN), (match): [number, number] => [
      match.index,
      match.index + match[0].length
    ]);
    const issues: LocalSpellingIssue[] = [];

    for (const match of text.matchAll(TOKEN)) {
      const word = match[0];
      const offset = match.index;
      if (
        issues.length >= MAX_LOCAL_ISSUES ||
        word.length < 2 ||
        /^\p{Lu}{2,}$/u.test(word) ||
        overlapsExcludedSpan(offset, offset + word.length, excluded) ||
        checker.correct(word)
      ) {
        continue;
      }
      issues.push({
        kind: 'spelling',
        ruleId: 'local-dictionary',
        word,
        offset,
        length: word.length,
        suggestions: checker.suggest(word).slice(0, 5)
      });
    }

    return {
      available: true,
      backend: 'nspell',
      issues,
      disclosure: 'Lokale W\u00f6rterbuchpr\u00fcfung; der Dokumenttext hat den Rechner nicht verlassen.'
    };
  } catch {
    return {
      available: false,
      backend: 'nspell',
      issues: [],
      disclosure: 'Das Dokument konnte f\u00fcr die lokale Sprachpr\u00fcfung nicht gelesen werden.'
    };
  }
}

export class LocalLanguageChecker {
  constructor(private readonly skillRoot: string, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async check(documentPath: string, language = 'de-DE'): Promise<LanguageCheckResult> {
    const backend = this.environment.LANGUAGE_CHECK_BACKEND || 'nspell';
    if (backend === 'nspell') return checkWithBundledDictionary(documentPath, language);
    if (backend !== 'languagetool' && backend !== 'hunspell') {
      return {
        available: false,
        issues: [],
        disclosure: 'Unbekanntes lokales Sprachpr\u00fcfungs-Backend. Erlaubt sind nspell, languagetool oder hunspell.'
      };
    }
    const args = [resolve(this.skillRoot, 'scripts', 'language_check.py'), '--backend', backend, '--document', documentPath, '--language', language, '--format', 'json'];
    if (backend === 'languagetool') args.push('--server', this.environment.LANGUAGETOOL_URL || 'http://localhost:8010/v2/check');
    try {
      const { stdout } = await execute(this.environment.PYTHON_EXECUTABLE || 'python', args, {
        cwd: this.skillRoot,
        windowsHide: true,
        env: buildMinimalLocalChildEnvironment(this.environment)
      });
      const result = JSON.parse(stdout) as { issues?: unknown[] };
      return { available: true, backend, issues: result.issues ?? [] };
    } catch (error) {
      const stdout = typeof error === 'object' && error && 'stdout' in error ? String(error.stdout) : '';
      try {
        const result = JSON.parse(stdout) as { issues?: unknown[] };
        return { available: true, backend, issues: result.issues ?? [] };
      } catch {
        return {
          available: false,
          backend,
          issues: [],
          disclosure: 'Das konfigurierte lokale Sprachpr\u00fcfungs-Backend ist nicht erreichbar.'
        };
      }
    }
  }
}
