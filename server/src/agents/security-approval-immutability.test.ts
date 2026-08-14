import { describe, expect, it } from 'vitest';
import { ApprovalQueue } from './security-approval.js';

describe('ApprovalQueue append-only audit view', () => {
  it('does not expose mutable audit storage to callers', () => {
    const queue = new ApprovalQueue(Buffer.alloc(32, 7), () => new Date('2026-08-14T12:00:00.000Z'));
    const request = queue.request({
      runId: 'run-immutable', toolName: 'applications.update', target: 'case-1',
      parameters: { status: 'submitted' }, parameterPreview: { status: 'submitted' }, risk: 'external_write',
    });
    queue.deny(request.id, 'local-user');

    const exposed = queue.audit as unknown as Array<{ action: string; actor: string }>;
    exposed.push({ action: 'approved', actor: 'attacker' });
    expect(() => { exposed[0]!.action = 'approved'; }).toThrow();

    expect(queue.audit.map((entry) => entry.action)).toEqual(['requested', 'denied']);
    expect(queue.audit).not.toBe(exposed);
  });
});
