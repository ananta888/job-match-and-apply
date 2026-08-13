import type { AppConfig } from '../domain/models.js';

export const defaultConfig: AppConfig = {
  searchProfile: {
    name: 'Mein Suchprofil',
    query: 'Software Engineer',
    regions: ['Berlin', 'Remote'],
    radiusKm: 50,
    workModels: ['remote', 'hybrid'],
    employmentTypes: ['full_time'],
    mustHave: ['TypeScript'],
    niceToHave: ['Angular', 'Python', 'Automatisierung'],
    exclude: ['Arbeitnehmerüberlassung', 'unbezahlt'],
    minSalary: 60000,
    sourceIds: ['stepstone', 'arbeitnow', 'remotive', 'linkedin-profile']
  },
  identities: [
    {
      id: 'incognito-default',
      label: 'Inkognito-Profil',
      mode: 'incognito',
      fullName: 'Alex Beispiel',
      email: 'alex.beispiel@example.invalid',
      phone: '+49 000 0000000',
      location: 'Berlin',
      linkedin: 'https://linkedin.com/in/profil-platzhalter',
      placeholders: {
        '{{VOLLSTAENDIGER_NAME}}': 'Alex Beispiel',
        '{{VORNAME}}': 'Alex',
        '{{NACHNAME}}': 'Beispiel',
        '{{E_MAIL}}': 'alex.beispiel@example.invalid',
        '{{TELEFON}}': '+49 000 0000000',
        '{{ORT}}': 'Berlin'
      }
    }
  ],
  activeIdentityId: 'incognito-default',
  mcp: {
    mode: 'demo',
    command: 'integrations/job-search-mcp/.venv/Scripts/job-search-mcp.exe',
    args: [],
    env: {
      ALLOW_EXTERNAL_PORTALS: '0',
      JOB_MCP_STATE_DIR: '.local-data/mcp-state'
    }
  },
  assistant: {
    skillPath: 'integrations/bewerbungs-schreib-assistent',
    candidateProfilePath: '.local-data/profiles/candidate-profile.yaml',
    styleProfilePath: '.local-data/profiles/style-profile.yaml'
  }
};
