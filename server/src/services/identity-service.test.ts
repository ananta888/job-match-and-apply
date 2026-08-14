import { describe, expect, it } from 'vitest';
import type { IdentityProfile } from '../domain/models.js';
import { createIncognitoIdentity, findIdentityLeaks } from './identity-service.js';

describe('incognito identities', () => {
  it('uses configurable but non-deliverable placeholders', () => {
    const identity = createIncognitoIdentity('Berlin', { firstName: 'Pat', lastName: 'Platzhalter', label: 'Demo' });
    expect(identity.fullName).toBe('Pat Platzhalter');
    expect(identity.email).toBe('pat.platzhalter@example.invalid');
    expect(identity.linkedin).toContain('example.invalid');
    expect(identity.placeholders['{{PROFIL_URL}}']).toBe(identity.linkedin);
  });

  it('detects real identity values in incognito output', () => {
    const real: IdentityProfile = {
      id: 'real', label: 'Real', mode: 'real', fullName: 'Erika Echt', email: 'erika@example.de',
      phone: '+49 123 456789', location: 'Berlin', linkedin: 'https://example.de/erika', placeholders: {}
    };
    expect(findIdentityLeaks('Kontakt: erika@example.de', [real])).toEqual(['erika@example.de']);
  });
});
