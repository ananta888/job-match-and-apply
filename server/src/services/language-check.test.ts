import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalLanguageChecker } from './language-check.js';

describe('LocalLanguageChecker', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('checks German spelling with the bundled offline dictionary by default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'job-match-language-'));
    temporaryDirectories.push(directory);
    const documentPath = join(directory, 'anschreiben.txt');
    await writeFile(documentPath, 'Ich bewerbe mich auf diese Stelle. Das ist ein Tppfehler. https://example.invalid/Falsch', 'utf8');

    const result = await new LocalLanguageChecker('unused', {}).check(documentPath, 'de-DE');

    expect(result.available).toBe(true);
    expect(result.backend).toBe('nspell');
    expect(result.disclosure).toContain('nicht verlassen');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'spelling', word: 'Tppfehler' })
    ]));
    expect(result.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ word: 'Falsch' })
    ]));
  });

  it('fails closed when no bundled dictionary exists for a language', async () => {
    const result = await new LocalLanguageChecker('unused', {}).check('unused.md', 'fr-FR');
    expect(result.available).toBe(false);
    expect(result.backend).toBe('nspell');
    expect(result.disclosure).toContain('kein lokales W\u00f6rterbuch');
  });
});
