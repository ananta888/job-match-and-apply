import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppConfig, ApplicationDraft, IdentityProfile, JobMatch } from '../domain/models.js';
import type { ApplicationAssistantPort } from '../ports/application-assistant.js';

export class LocalApplicationAssistantAdapter implements ApplicationAssistantPort {
  constructor(private readonly settings: AppConfig['assistant']) {}

  async status(): Promise<{ available: boolean; note: string }> {
    try {
      await access(resolve(process.cwd(), '..', this.settings.skillPath, 'SKILL.md'));
      return { available: true, note: 'Bewerbungs-Skill gefunden; faktenbasierte Vorlagen und Prüfskripte sind verfügbar.' };
    } catch {
      return { available: false, note: 'Bewerbungs-Skill noch nicht installiert. npm run setup:integrations ausführen.' };
    }
  }

  async draft(match: JobMatch, identity: IdentityProfile, documentType: 'cover_letter' | 'email'): Promise<ApplicationDraft> {
    const salutation = 'Guten Tag,';
    const matchTerms = [...match.matchedMustHave, ...match.matchedNiceToHave].slice(0, 4);
    const relevance = matchTerms.length > 0
      ? `Die ausgeschriebene Position verbindet ${matchTerms.join(', ')} – Themen, die zu meinem hinterlegten Profil passen.`
      : 'Die Aufgaben der ausgeschriebenen Position passen zu meinem beruflichen Suchprofil.';
    const gapText = match.missingMustHave.length > 0
      ? `Offen ansprechen möchte ich: ${match.missingMustHave.join(', ')} ist in meinem Profil derzeit nicht belegt.`
      : 'Die definierten Muss-Kriterien sind im Profil abgedeckt.';
    const body = documentType === 'email'
      ? `${salutation}\n\n${relevance}\n\nIm Anhang finden Sie meine Unterlagen. Über ein Gespräch freue ich mich.\n\nFreundliche Grüße\n${identity.fullName}`
      : `${salutation}\n\n${relevance}\n\n${gapText} Konkrete Projektergebnisse und Stationen werden erst ergänzt, wenn sie im Kandidatenprofil als verifiziert hinterlegt sind.\n\nGern erläutere ich meine Motivation und die belegten Erfahrungen in einem persönlichen Gespräch.\n\nFreundliche Grüße\n${identity.fullName}`;
    return {
      jobId: match.job.id,
      identityId: identity.id,
      documentType,
      content: body,
      strongestMatches: matchTerms,
      gaps: match.missingMustHave,
      warnings: [
        identity.mode === 'incognito' ? 'Enthält eine Scheinidentität mit .invalid-E-Mail; vor echter Bewerbung ersetzen.' : '',
        'Der Entwurf erfindet keine Berufserfahrung. Verifizierte Claims müssen über das Kandidatenprofil ergänzt werden.'
      ].filter(Boolean)
    };
  }
}
