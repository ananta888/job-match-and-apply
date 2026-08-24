import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverOpencodeAssistantText } from './opencode-session-recover.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('recoverOpencodeAssistantText', () => {
  it('returns only the latest assistant text and ignores the user prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-sess-'));
    roots.push(root);
    const dir = join(root, 'storage', 'message', 'ses_synthetic');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'msg_user.json'), JSON.stringify({
      info: { role: 'user', time: { created: 2 } },
      parts: [{ type: 'text', text: 'UNTRUSTED_CV_LINE_MANIFEST must not leak' }],
    }));
    await writeFile(join(dir, 'msg_old.json'), JSON.stringify({
      info: { role: 'assistant', time: { created: 1 } },
      parts: [{ type: 'text', text: '{"stale":true}' }],
    }));
    await writeFile(join(dir, 'msg_new.json'), JSON.stringify({
      info: { role: 'assistant', time: { created: 3 } },
      parts: [{ type: 'text', text: '{"contract":"ai-cv-structure-proposal"}' }],
    }));
    await expect(recoverOpencodeAssistantText(root)).resolves.toBe('{"contract":"ai-cv-structure-proposal"}');
  });

  it('returns nothing when the store is missing or has no assistant text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-sess-empty-'));
    roots.push(root);
    await expect(recoverOpencodeAssistantText(root)).resolves.toBeUndefined();
    await expect(recoverOpencodeAssistantText(join(root, 'missing'))).resolves.toBeUndefined();
  });
});
