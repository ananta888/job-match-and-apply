import { describe, expect, it } from 'vitest';
import { IncrementalJsonlParser } from './jsonl-parser.js';

describe('IncrementalJsonlParser', () => {
  it('buffers partial lines and continues after malformed events', () => {
    const parser = new IncrementalJsonlParser();
    expect(parser.feed('{"type":"one"').values).toEqual([]);
    const batch = parser.feed('}\nnot-json\n{"type":"two"}\n');
    expect(batch.values).toEqual([{ type: 'one' }, { type: 'two' }]);
    expect(batch.diagnostics).toEqual([expect.objectContaining({ code: 'invalid_json', line: 2 })]);
  });

  it('limits individual lines and labels an invalid final fragment as truncated', () => {
    const parser = new IncrementalJsonlParser(128);
    expect(parser.feed(`${JSON.stringify({ text: 'x'.repeat(200) })}\n`).diagnostics[0]?.code).toBe('line_too_large');
    parser.feed('{"partial":');
    expect(parser.end().diagnostics[0]?.code).toBe('truncated_tail');
  });
});
