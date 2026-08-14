import { describe, expect, it } from 'vitest';
import { exportDocument } from './document-export.js';
import { importProfileDocument } from './profile-import.js';

describe('profile import', () => {
  it('creates only unverified proposals with provenance from user text', async () => {
    const result = await importProfileDocument('profile.txt', 'text/plain', Buffer.from('Senior Engineer bei Example GmbH\nRabbitMQ in Integrationen eingesetzt'), 'user_upload');
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals.every((item) => item.status === 'unverified')).toBe(true);
    expect(result.proposals[0]?.source.sha256).toHaveLength(64);
    expect(result.persisted).toBe(false);
    expect(result.proposals[0]?.decision).toBe('pending');
  });
  it('shows exact duplicates and possible conflicts before import', async () => {
    const result = await importProfileDocument(
      'profile.txt', 'text/plain', Buffer.from('RabbitMQ in Integrationen eingesetzt'), 'user_upload',
      [{ id: 'claim-rabbit', statement: 'RabbitMQ in Integrationen eingesetzt' }]
    );
    expect(result.proposals[0]?.conflict).toMatchObject({ kind: 'duplicate', existingClaimId: 'claim-rabbit' });
  });
  it('extracts a locally generated DOCX without executing active content', async () => {
    const document = await exportDocument('Senior Engineer bei Example GmbH', 'docx');
    const result = await importProfileDocument('cv.docx', document.mimeType, document.data, 'cv');
    expect(result.proposals[0]?.statement).toContain('Senior Engineer');
  });
  it('extracts a locally generated PDF as unverified proposals', async () => {
    const document = await exportDocument('Senior Engineer mit RabbitMQ', 'pdf');
    const result = await importProfileDocument('cv.pdf', document.mimeType, document.data, 'cv');
    expect(result.proposals[0]?.statement).toContain('Senior Engineer');
    expect(result.proposals[0]?.status).toBe('unverified');
  });
  it('maps user-provided profile exports but does not confirm them', async () => {
    const data = Buffer.from(JSON.stringify({ positions: [{ title: 'Engineer', company: 'Example' }], skills: ['RabbitMQ'] }));
    const result = await importProfileDocument('linkedin.json', 'application/json', data, 'linkedin_export');
    expect(result.proposals.some((item) => item.statement.includes('RabbitMQ'))).toBe(true);
    expect(result.requiresUserConfirmation).toBe(true);
  });
});
