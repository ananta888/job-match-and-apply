import { randomUUID } from 'node:crypto';
import type { IdentityProfile } from '../domain/models.js';

const FIRST_NAMES = ['Alex', 'Robin', 'Sascha', 'Kim', 'Mika', 'Jona'];
const LAST_NAMES = ['Beispiel', 'Muster', 'Platzhalter', 'Demo'];

export function createIncognitoIdentity(location = 'Deutschland'): IdentityProfile {
  const firstName = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)] ?? 'Alex';
  const lastName = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)] ?? 'Beispiel';
  const fullName = `${firstName} ${lastName}`;
  const slug = `${firstName}.${lastName}`.toLocaleLowerCase('de-DE');
  return {
    id: randomUUID(),
    label: `Inkognito · ${fullName}`,
    mode: 'incognito',
    fullName,
    email: `${slug}@example.invalid`,
    phone: '+49 000 0000000',
    location,
    linkedin: `https://linkedin.com/in/${slug}-platzhalter`,
    placeholders: {
      '{{VOLLSTAENDIGER_NAME}}': fullName,
      '{{VORNAME}}': firstName,
      '{{NACHNAME}}': lastName,
      '{{E_MAIL}}': `${slug}@example.invalid`,
      '{{TELEFON}}': '+49 000 0000000',
      '{{ORT}}': location
    }
  };
}
