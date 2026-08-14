import { describe, expect, it } from 'vitest';
import { buildMinimalLocalChildEnvironment } from './process-environment.js';

describe('minimal local child environment', () => {
  it('keeps only operating-system basics and drops secrets and portal settings', () => {
    const result = buildMinimalLocalChildEnvironment({
      PATH: '/synthetic/bin', TEMP: '/synthetic/tmp', LANG: 'de_DE.UTF-8',
      OPENAI_API_KEY: 'sk-test-never-inherit', MAIL_PASSWORD: 'secret-value',
      ALLOW_EXTERNAL_PORTALS: '1', JOB_MCP_STATE_DIR: '/private/state'
    });
    expect(result).toEqual({ PATH: '/synthetic/bin', TEMP: '/synthetic/tmp', LANG: 'de_DE.UTF-8' });
  });
});
