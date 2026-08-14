import { randomUUID } from 'node:crypto';
import type { IdentityProfile } from '../domain/models.js';

const FIRST_NAMES = ['Alex', 'Robin', 'Sascha', 'Kim', 'Mika', 'Jona'];
const LAST_NAMES = ['Beispiel', 'Muster', 'Platzhalter', 'Demo'];

export interface IncognitoTemplate { firstName?: string; lastName?: string; location?: string; label?: string; }

export function createIncognitoIdentity(location = 'Deutschland', template: IncognitoTemplate = {}): IdentityProfile {
  const firstName = template.firstName?.trim() || FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)] || 'Alex';
  const lastName = template.lastName?.trim() || LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)] || 'Beispiel';
  location = template.location?.trim() || location;
  const fullName = `${firstName} ${lastName}`;
  const slug = `${firstName}.${lastName}`.toLocaleLowerCase('de-DE');
  return {
    id: randomUUID(),
    label: template.label?.trim() || `Inkognito · ${fullName}`,
    mode: 'incognito',
    fullName,
    email: `${slug}@example.invalid`,
    phone: '+49 000 0000000',
    location,
    linkedin: `https://profile.example.invalid/${slug}`,
    placeholders: {
      '{{VOLLSTAENDIGER_NAME}}': fullName,
      '{{VORNAME}}': firstName,
      '{{NACHNAME}}': lastName,
      '{{E_MAIL}}': `${slug}@example.invalid`,
      '{{TELEFON}}': '+49 000 0000000',
      '{{ORT}}': location,
      '{{PROFIL_URL}}': `https://profile.example.invalid/${slug}`
    }
  };
}

export function findIdentityLeaks(content: string, realIdentities: IdentityProfile[]): string[] {
  const normalized = content.toLocaleLowerCase('de-DE');
  const leaked = new Set<string>();
  for (const identity of realIdentities.filter((candidate) => candidate.mode === 'real')) {
    for (const value of [identity.fullName, identity.email, identity.phone, identity.linkedin]) {
      const candidate = value.trim();
      if (candidate.length >= 5 && normalized.includes(candidate.toLocaleLowerCase('de-DE'))) leaked.add(candidate);
    }
  }
  return [...leaked];
}
