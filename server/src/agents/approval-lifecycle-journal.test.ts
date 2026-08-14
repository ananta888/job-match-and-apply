import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APPROVAL_LIFECYCLE_JOURNAL_VERSION,
  JsonlApprovalLifecycleJournal,
  MemoryApprovalLifecycleJournal,
  hashApprovalLifecycleValue,
  type ApprovalLifecycleJournal,
} from './approval-lifecycle-journal.js';
import { ApprovalQueue } from './security-approval.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function request(queue: ApprovalQueue, suffix = 'one') {
  return queue.request({
    runId: `run-${suffix}`,
    toolName: 'applications.update',
    target: `application-case:PRIVATE_TARGET_${suffix}`,
    parameters: { status: 'submitted', privateCanary: `PRIVATE_PARAMETER_${suffix}` },
    parameterPreview: { privateCanary: `PRIVATE_PREVIEW_${suffix}` },
    diff: `PRIVATE_DIFF_${suffix}`,
    risk: 'external_write',
  });
}

describe('durable approval lifecycle journal', () => {
  it('persists immutable request/resolution metadata without payloads, actors or bearer tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'approval-journal-'));
    roots.push(root);
    const path = join(root, 'approval-events.jsonl');
    const journal = new JsonlApprovalLifecycleJournal(path);
    const queue = new ApprovalQueue(
      Buffer.alloc(32, 5), () => new Date('2026-08-14T12:00:00.000Z'), 300_000, journal,
    );
    const approval = request(queue);
    const token = queue.approve(approval.id, 'PRIVATE_ACTOR@example.test');
    queue.consume(token, {
      runId: approval.runId, toolName: approval.toolName, target: approval.target,
      parameters: { status: 'submitted', privateCanary: 'PRIVATE_PARAMETER_one' },
    });

    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain('PRIVATE_TARGET');
    expect(persisted).not.toContain('PRIVATE_PARAMETER');
    expect(persisted).not.toContain('PRIVATE_PREVIEW');
    expect(persisted).not.toContain('PRIVATE_DIFF');
    expect(persisted).not.toContain('PRIVATE_ACTOR');
    expect(persisted).not.toContain(token);
    expect(persisted).not.toMatch(/"(?:token|payload|parameters|preview|target|actor)"/i);
    expect(journal.events().map((event) => event.kind)).toEqual([
      'approval_requested', 'approval_approved', 'approval_consumed',
    ]);
  });

  it('revokes pending and approved authority on restart without restoring a bearer token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'approval-restart-'));
    roots.push(root);
    const path = join(root, 'approval-events.jsonl');
    const key = Buffer.alloc(32, 8);
    const clock = () => new Date('2026-08-14T12:00:00.000Z');
    const first = new ApprovalQueue(key, clock, 300_000, new JsonlApprovalLifecycleJournal(path));
    const pending = request(first, 'pending');
    const approved = request(first, 'approved');
    const staleToken = first.approve(approved.id, 'local-user');

    const restarted = new ApprovalQueue(key, clock, 300_000, new JsonlApprovalLifecycleJournal(path));

    expect(restarted.durabilityRecovery?.revokedRequestIds.sort()).toEqual([approved.id, pending.id].sort());
    expect(restarted.durabilityRecovery?.states).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: pending.id, status: 'revoked' }),
      expect.objectContaining({ requestId: approved.id, status: 'revoked' }),
    ]));
    expect(() => restarted.consume(staleToken, {
      runId: approved.runId, toolName: approved.toolName, target: approved.target,
      parameters: { status: 'submitted', privateCanary: 'PRIVATE_PARAMETER_approved' },
    })).toThrow('approval_token_request_invalid');
  });

  it('repairs only an incomplete tail, then records restart revocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'approval-partial-'));
    roots.push(root);
    const path = join(root, 'approval-events.jsonl');
    const firstJournal = new JsonlApprovalLifecycleJournal(path);
    const first = new ApprovalQueue(Buffer.alloc(32, 4), () => new Date('2026-08-14T12:00:00.000Z'), 300_000, firstJournal);
    const pending = request(first, 'partial');
    await appendFile(path, '{"journalVersion":1,"eventId":"partial-tail"', 'utf8');

    expect(() => firstJournal.events()).toThrow('recovery_required');
    const restarted = new ApprovalQueue(
      Buffer.alloc(32, 4), () => new Date('2026-08-14T12:01:00.000Z'), 300_000,
      new JsonlApprovalLifecycleJournal(path),
    );

    expect(restarted.durabilityRecovery).toMatchObject({ truncatedTail: true, revokedRequestIds: [pending.id] });
    expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('accepts an exact event retry and rejects a conflicting reuse of its immutable id', () => {
    const journal = new MemoryApprovalLifecycleJournal();
    const event = journal.record({
      kind: 'approval_requested', requestId: 'approval-1', runId: 'run-1',
      occurredAt: '2026-08-14T12:00:00.000Z', expiresAt: '2026-08-14T12:05:00.000Z',
      bindingHash: hashApprovalLifecycleValue('binding'),
      parametersHash: hashApprovalLifecycleValue('parameters'), risk: 'external_write',
    });
    expect(journal.append(event)).toBe('duplicate');
    expect(() => journal.append({ ...event, bindingHash: hashApprovalLifecycleValue('changed') }))
      .toThrow('event_id_conflict');
    expect(journal.events()).toHaveLength(1);
  });

  it('blocks an unknown journal version without rewriting the log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'approval-future-'));
    roots.push(root);
    const path = join(root, 'approval-events.jsonl');
    const future = {
      journalVersion: APPROVAL_LIFECYCLE_JOURNAL_VERSION + 1,
      eventId: 'future-event', sequence: 1, requestId: 'approval-future', runId: 'run-future',
      occurredAt: '2026-08-14T12:00:00.000Z', bindingHash: hashApprovalLifecycleValue('future-binding'),
      kind: 'approval_requested', parametersHash: hashApprovalLifecycleValue('future-parameters'),
      risk: 'external_write', expiresAt: '2026-08-14T12:05:00.000Z',
    };
    await writeFile(path, `${JSON.stringify(future)}\n`, 'utf8');
    const journal = new JsonlApprovalLifecycleJournal(path);
    expect(() => journal.recover()).toThrow('version_unsupported');
    expect(JSON.parse((await readFile(path, 'utf8')).trim())).toEqual(future);
  });

  it('does not mutate queue state when durable recording fails', () => {
    const failing: ApprovalLifecycleJournal = {
      record() { throw new Error('synthetic_durable_write_failure'); },
      append() { throw new Error('unused'); },
      events() { return []; },
      recover() { return { truncatedTail: false, revokedRequestIds: [], states: [] }; },
    };
    const queue = new ApprovalQueue(Buffer.alloc(32, 9), () => new Date('2026-08-14T12:00:00.000Z'), 300_000, failing);
    expect(() => request(queue, 'failed-write')).toThrow('synthetic_durable_write_failure');
    expect(queue.list()).toEqual([]);
  });
});
