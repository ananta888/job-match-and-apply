import { describe, expect, it } from 'vitest';
import { LocalLanguageChecker } from './language-check.js';

describe('LocalLanguageChecker', () => {
  it('discloses unavailable local checking without sending text remotely', async () => {
    const result = await new LocalLanguageChecker('unused', {}).check('unused.md');
    expect(result.available).toBe(false);
    expect(result.disclosure).toContain('lokale Sprachprüfung');
  });
});
