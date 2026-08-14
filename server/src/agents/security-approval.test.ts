import { describe, expect, it } from 'vitest';
import { ApprovalQueue, canonicalJson, parameterHash, RunCapabilityAuthority } from './security-approval.js';

const key = Buffer.alloc(32, 7);
const input = {
  runId: 'run-1', toolName: 'document.save', target: 'case-1', parameters: { b: 2, a: 'one' },
  parameterPreview: { title: 'Save proposal' }, risk: 'local_write' as const,
};
const tamperLast = (token: string): string => `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

describe('approval parameter canonicalization', () => {
  it('is key-order stable and rejects non-JSON or cyclic parameters', () => {
    expect(parameterHash({ a: 1, b: [2] })).toBe(parameterHash({ b: [2], a: 1 }));
    expect(canonicalJson({ negativeZero: -0 })).toBe('{"negativeZero":0}');
    expect(() => canonicalJson({ nan: Number.NaN })).toThrow('finite_json');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow('must_not_be_cyclic');
  });
});

describe('ApprovalQueue', () => {
  it('issues a run/tool/target/parameter-bound, one-use HMAC token', () => {
    const queue = new ApprovalQueue(key, () => new Date('2029-01-01T00:00:00.000Z'));
    const request = queue.request(input);
    const token = queue.approve(request.id, 'local-user');
    const consumed = queue.consume(token, { runId: 'run-1', toolName: 'document.save', target: 'case-1', parameters: { a: 'one', b: 2 } });
    expect(consumed.requestId).toBe(request.id);
    expect(queue.get(request.id)?.status).toBe('consumed');
    expect(() => queue.consume(token, { runId: 'run-1', toolName: 'document.save', target: 'case-1', parameters: input.parameters }))
      .toThrow('already_used');
  });

  it.each([
    [{ runId: 'run-2', toolName: 'document.save', target: 'case-1', parameters: input.parameters }, 'run_mismatch'],
    [{ runId: 'run-1', toolName: 'mail.send', target: 'case-1', parameters: input.parameters }, 'tool_mismatch'],
    [{ runId: 'run-1', toolName: 'document.save', target: 'case-2', parameters: input.parameters }, 'target_mismatch'],
    [{ runId: 'run-1', toolName: 'document.save', target: 'case-1', parameters: { a: 'changed', b: 2 } }, 'parameters_mismatch'],
  ])('rejects context reuse %#', (expected, reason) => {
    const queue = new ApprovalQueue(key, () => new Date('2029-01-01T00:00:00.000Z'));
    const token = queue.approve(queue.request(input).id, 'local-user');
    expect(() => queue.consume(token, expected)).toThrow(reason as string);
  });

  it('rejects tampering, expired and revoked tokens', () => {
    let now = new Date('2029-01-01T00:00:00.000Z');
    const queue = new ApprovalQueue(key, () => now);
    const request = queue.request({ ...input, expiresInMs: 1_000 });
    const token = queue.approve(request.id, 'local-user');
    expect(() => queue.consume(tamperLast(token), { runId: 'run-1', toolName: 'document.save', target: 'case-1', parameters: input.parameters }))
      .toThrow('signature_invalid');
    now = new Date('2029-01-01T00:00:02.000Z');
    expect(() => queue.consume(token, { runId: 'run-1', toolName: 'document.save', target: 'case-1', parameters: input.parameters }))
      .toThrow('token_expired');

    now = new Date('2029-01-01T00:00:00.000Z');
    const second = queue.request(input);
    const secondToken = queue.approve(second.id, 'local-user');
    queue.revoke(second.id, 'local-user');
    expect(() => queue.consume(secondToken, { runId: 'run-1', toolName: 'document.save', target: 'case-1', parameters: input.parameters }))
      .toThrow('token_revoked');
  });

  it('creates a new request/token when parameters are edited', () => {
    const queue = new ApprovalQueue(key, () => new Date('2029-01-01T00:00:00.000Z'));
    const original = queue.request(input);
    const edited = queue.editAndApprove(original.id, 'local-user', { a: 'edited' }, { title: 'Edited' }, '- old\n+ new');
    expect(queue.get(original.id)).toMatchObject({ status: 'superseded', supersededBy: edited.request.id });
    expect(() => queue.consume(edited.token, { runId: 'run-1', toolName: 'document.save', target: 'case-1', parameters: input.parameters }))
      .toThrow('parameters_mismatch');
    expect(queue.consume(edited.token, { runId: 'run-1', toolName: 'document.save', target: 'case-1', parameters: { a: 'edited' } }).requestId)
      .toBe(edited.request.id);
  });

  it('does not accept normal denial as an approval', () => {
    const queue = new ApprovalQueue(key, () => new Date('2029-01-01T00:00:00.000Z'));
    const request = queue.request(input);
    queue.deny(request.id, 'local-user', 'No');
    expect(() => queue.approve(request.id, 'local-user')).toThrow('not_pending:denied');
    expect(queue.audit.map((entry) => entry.action)).toEqual(['requested', 'denied']);
  });

  it('revokes every open approval during an emergency stop without changing terminal decisions', () => {
    const queue = new ApprovalQueue(key, () => new Date('2029-01-01T00:00:00.000Z'));
    const pending = queue.request(input);
    const approved = queue.request({ ...input, runId: 'run-2' });
    const token = queue.approve(approved.id, 'local-user');
    const denied = queue.request({ ...input, runId: 'run-3' });
    queue.deny(denied.id, 'local-user');
    expect(queue.revokeAll('emergency-stop').map((request) => request.id).sort()).toEqual([approved.id, pending.id].sort());
    expect(queue.get(denied.id)?.status).toBe('denied');
    expect(() => queue.consume(token, { runId: 'run-2', toolName: 'document.save', target: 'case-1', parameters: input.parameters }))
      .toThrow('token_revoked');
  });
});

describe('RunCapabilityAuthority', () => {
  it('binds MCP access to one run, provider, tool set and case set', () => {
    const authority = new RunCapabilityAuthority(key, () => new Date('2029-01-01T00:00:00.000Z'));
    const token = authority.issue({
      runId: 'run-1', providerId: 'codex', allowedTools: ['jobs.search', 'applications.get'], allowedApplicationCaseIds: ['case-1'],
    });
    expect(authority.verify(token, { runId: 'run-1', providerId: 'codex', toolName: 'applications.get', applicationCaseId: 'case-1' }))
      .toMatchObject({ runId: 'run-1', providerId: 'codex', allowedApplicationCaseIds: ['case-1'] });
    expect(() => authority.verify(token, { runId: 'run-2', providerId: 'codex' })).toThrow('run_scope_mismatch');
    expect(() => authority.verify(token, { runId: 'run-1', providerId: 'codex', toolName: 'mail.send' })).toThrow('tool_not_allowed');
    expect(() => authority.verify(token, { runId: 'run-1', providerId: 'codex', applicationCaseId: 'case-guessed' })).toThrow('application_case_not_allowed');
  });

  it('rejects tampering, expiration and revocation', () => {
    let now = new Date('2029-01-01T00:00:00.000Z');
    const authority = new RunCapabilityAuthority(key, () => now);
    const token = authority.issue({ runId: 'run-1', providerId: 'fake', allowedTools: ['jobs.search'], allowedApplicationCaseIds: [], expiresInMs: 1_000 });
    expect(() => authority.verify(tamperLast(token), { runId: 'run-1', providerId: 'fake' })).toThrow('signature_invalid');
    authority.revoke(token);
    expect(() => authority.verify(token, { runId: 'run-1', providerId: 'fake' })).toThrow('token_revoked');
    const expiring = authority.issue({ runId: 'run-2', providerId: 'fake', allowedTools: ['jobs.search'], allowedApplicationCaseIds: [], expiresInMs: 1_000 });
    now = new Date('2029-01-01T00:00:02.000Z');
    expect(() => authority.verify(expiring, { runId: 'run-2', providerId: 'fake' })).toThrow('token_expired');
  });
});
