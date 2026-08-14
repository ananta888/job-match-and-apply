import { describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentEvent } from '../ports/agent-runner.js';
import {
  normalizeUserInputRequest,
  pendingUserInputRequest,
  SensitiveUserInputRedactor,
  validateUserInputAnswer,
} from './user-input.js';

const now = new Date('2026-08-14T10:00:00.000Z');

function event(data: Record<string, unknown>, sequence = 7): AgentEvent {
  return {
    schemaVersion: AGENT_CONTRACT_VERSION,
    runId: 'run-input-test',
    provider: 'fake',
    sequence,
    timestamp: now.toISOString(),
    correlationId: 'correlation-input-test',
    kind: 'user_input_requested',
    data,
  };
}

describe('standardized user input requests', () => {
  it('normalizes text, selection, file and confirmation without accepting provider authority fields', () => {
    for (const kind of ['text', 'file', 'confirmation'] as const) {
      expect(normalizeUserInputRequest({ id: `request-${kind}`, kind, title: kind, prompt: `Enter ${kind}` }, now)).toMatchObject({
        id: `request-${kind}`, kind, sensitive: true, requestedAt: now.toISOString(), maxAttempts: 3,
      });
    }
    expect(normalizeUserInputRequest({
      id: 'request-selection', kind: 'selection', title: 'Selection', prompt: 'Choose one', options: ['one', 'two'], sensitive: false,
    }, now)).toMatchObject({ kind: 'selection', options: ['one', 'two'], sensitive: false });
    expect(() => normalizeUserInputRequest({
      id: 'forged', kind: 'confirmation', title: 'Approval', prompt: 'Approve?', approvalId: 'approval-1',
    }, now)).toThrow('user_input_request_cannot_grant_approval');
    expect(() => normalizeUserInputRequest({
      id: 'forged-camel', kind: 'confirmation', title: 'Approval', prompt: 'Approve?', authorizationToken: 'forged',
    }, now)).toThrow('user_input_request_cannot_grant_approval');
    expect(normalizeUserInputRequest({
      id: 'server-time', kind: 'text', title: 'Time', prompt: 'Enter text', requestedAt: '2099-01-01T00:00:00.000Z',
    }, now).requestedAt).toBe(now.toISOString());
    expect(() => normalizeUserInputRequest({
      id: 'unbounded', kind: 'text', title: 'Expiry', prompt: 'Enter text', expiresAt: '2099-01-01T00:00:00.000Z',
    }, now)).toThrow('user_input_request_expiry_invalid');
  });

  it('binds answers to the latest request sequence and fails closed after expiry', () => {
    const request = pendingUserInputRequest([event({
      id: 'selection', kind: 'selection', title: 'Selection', prompt: 'Choose', options: ['one', 'two'],
      requestedAt: now.toISOString(), expiresAt: '2026-08-14T10:01:00.000Z', maxAttempts: 2,
    })], new Date('2026-08-14T10:00:30.000Z'));
    expect(request).toMatchObject({ id: 'selection', requestedSequence: 7 });
    expect(() => validateUserInputAnswer(request, 'three', 1024)).toThrow('user_input_selection_invalid');
    // A validation failure does not consume the question; a corrected retry is valid.
    expect(() => validateUserInputAnswer(request, 'two', 1024)).not.toThrow();
    expect(() => pendingUserInputRequest([event(request)], new Date('2026-08-14T10:01:00.000Z'))).toThrow('user_input_request_expired');
  });

  it('keeps domain confirmation values distinct from approval decisions and supports explicit cancellation', () => {
    const request = { ...normalizeUserInputRequest({
      id: 'confirmation', kind: 'confirmation', title: 'Continue questionnaire', prompt: 'Continue?',
    }, now), requestedSequence: 1 };
    expect(() => validateUserInputAnswer(request, 'approve', 128)).toThrow('user_input_confirmation_invalid');
    expect(() => validateUserInputAnswer(request, 'confirm', 128)).not.toThrow();
    expect(() => validateUserInputAnswer(request, 'cancel', 128)).not.toThrow();
  });

  it('redacts exact, URL-encoded, base64 and short sensitive values recursively', () => {
    const secret = 'A+/ private';
    const redactor = new SensitiveUserInputRedactor();
    redactor.add(secret);
    redactor.add('42');
    const result = redactor.redact({
      raw: secret,
      url: encodeURIComponent(secret),
      base64: Buffer.from(secret).toString('base64'),
      nested: ['PIN=42'],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(encodeURIComponent(secret));
    expect(serialized).not.toContain(Buffer.from(secret).toString('base64'));
    expect(serialized).not.toContain('42');
    expect(serialized).toContain('[REDACTED:USER_INPUT]');
  });
});
