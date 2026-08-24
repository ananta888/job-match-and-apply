import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_FILES = 256;
const MAX_FILE_BYTES = 768 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.text === 'string' && value.text.trim()) return value.text;
  if (typeof value.content === 'string' && value.content.trim()) return value.content;
  if (Array.isArray(value.parts)) {
    const joined = value.parts
      .map((part) => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('');
    return joined.trim() ? joined : undefined;
  }
  if (Array.isArray(value.content)) {
    const joined = value.content
      .map((part) => (typeof part === 'string' ? part : isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('');
    return joined.trim() ? joined : undefined;
  }
  return undefined;
}

function isAssistant(value: Record<string, unknown>): boolean {
  const info = isRecord(value.info) ? value.info : value;
  const role = typeof info.role === 'string' ? info.role : typeof value.role === 'string' ? value.role : '';
  return role === 'assistant' || role === 'model';
}

async function walkJsonFiles(root: string, found: string[]): Promise<void> {
  if (found.length >= MAX_FILES) return;
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (found.length >= MAX_FILES) return;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walkJsonFiles(path, found);
    else if (entry.isFile() && entry.name.endsWith('.json')) found.push(path);
  }
}

/**
 * OpenCode 1.14.41 can finish a `--format json` turn inside bubblewrap without
 * emitting the `text` event, while still writing the assistant message to its
 * local store. Recover only assistant text; never user/prompt content.
 */
export async function recoverOpencodeAssistantText(root: string): Promise<string | undefined> {
  const files: string[] = [];
  await walkJsonFiles(root, files);
  let best: { text: string; stamp: number } | undefined;
  for (const file of files) {
    let raw: string;
    try { raw = await readFile(file, 'utf8'); }
    catch { continue; }
    if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { continue; }
    if (!isRecord(parsed) || !isAssistant(parsed)) continue;
    const text = textFromUnknown(parsed);
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) continue;
    const info = isRecord(parsed.info) ? parsed.info : undefined;
    const time = info && isRecord(info.time) ? info.time : isRecord(parsed.time) ? parsed.time : undefined;
    const stamp = typeof parsed.time === 'number' ? parsed.time
      : typeof parsed.timestamp === 'number' ? parsed.timestamp
        : time && typeof time.created === 'number' ? time.created
          : 0;
    if (!best || stamp >= best.stamp) best = { text, stamp };
  }
  return best?.text;
}
