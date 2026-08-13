import type { JobPosting, SearchProfile, SourceStatus } from '../domain/models.js';
import type { JobSourcePort, LoginResult } from '../ports/job-source.js';

const DEMO_JOBS: JobPosting[] = [
  {
    id: 'stepstone-frontend-1', sourceId: 'stepstone', title: 'Senior Frontend Engineer Angular',
    company: 'Nordlicht Digital', location: 'Berlin · Hybrid', workModel: 'hybrid', employmentType: 'full_time',
    description: 'Entwicklung einer Angular-Plattform mit TypeScript, REST APIs und Design System. Keine Arbeitnehmerüberlassung.',
    skills: ['Angular', 'TypeScript', 'REST API', 'Design Systems'], salaryMin: 72000, salaryMax: 90000,
    url: 'https://www.stepstone.de/', publishedAt: '2026-08-12'
  },
  {
    id: 'arbeitnow-automation-1', sourceId: 'arbeitnow', title: 'Software Engineer Automation',
    company: 'Flowcraft GmbH', location: 'Remote Deutschland', workModel: 'remote', employmentType: 'full_time',
    description: 'TypeScript- und Python-Automatisierungen, API-Integrationen und moderne Weboberflächen.',
    skills: ['TypeScript', 'Python', 'Automatisierung', 'API'], salaryMin: 65000, salaryMax: 82000,
    url: 'https://www.arbeitnow.com/'
  },
  {
    id: 'remotive-fullstack-1', sourceId: 'remotive', title: 'Full Stack Developer',
    company: 'Orbit Labs', location: 'EU Remote', workModel: 'remote', employmentType: 'contract',
    description: 'Product engineering with TypeScript, Angular and Node.js. Contract role.',
    skills: ['TypeScript', 'Angular', 'Node.js'], salaryMin: 58000, salaryMax: 76000,
    url: 'https://remotive.com/'
  },
  {
    id: 'linkedin-profile-architect-1', sourceId: 'linkedin-profile', title: 'Solution Architect',
    company: 'Profile Import Demo', location: 'München · Onsite', workModel: 'onsite', employmentType: 'full_time',
    description: 'Kundenberatung, Java und Cloud. Arbeitnehmerüberlassung möglich.',
    skills: ['Java', 'Cloud'], salaryMin: 70000, salaryMax: 88000
  }
];

export class DemoJobSourceAdapter implements JobSourcePort {
  async statuses(): Promise<SourceStatus[]> {
    return [
      { id: 'stepstone', name: 'StepStone', kind: 'demo', enabled: true, connected: false, supportsLogin: true, note: 'Demo-Daten aktiv; für Login den stdio-MCP konfigurieren.' },
      { id: 'arbeitnow', name: 'Arbeitnow', kind: 'demo', enabled: true, connected: true, supportsLogin: false, note: 'Offizielle öffentliche Quelle im Upstream-MCP.' },
      { id: 'remotive', name: 'Remotive', kind: 'demo', enabled: true, connected: true, supportsLogin: false, note: 'Offizielle öffentliche Quelle im Upstream-MCP.' },
      { id: 'weworkremotely', name: 'We Work Remotely', kind: 'demo', enabled: true, connected: true, supportsLogin: false, note: 'Über einen weiteren Adapter erweiterbar.' },
      { id: 'linkedin-profile', name: 'LinkedIn Profil', kind: 'profile', enabled: true, connected: false, supportsLogin: false, note: 'Profil-/Export-Import vorgesehen; kein unerlaubtes Crawling.' }
    ];
  }

  async search(profile: SearchProfile): Promise<JobPosting[]> {
    const sources = new Set(profile.sourceIds);
    const queryTerms = profile.query.toLocaleLowerCase('de-DE').split(/\s+/).filter(Boolean);
    return DEMO_JOBS.filter((job) => {
      if (!sources.has(job.sourceId)) return false;
      if (queryTerms.length === 0) return true;
      const text = `${job.title} ${job.description} ${job.skills.join(' ')}`.toLocaleLowerCase('de-DE');
      return queryTerms.some((term) => text.includes(term));
    });
  }

  async login(portalId: string): Promise<LoginResult> {
    throw Object.assign(new Error(`Für ${portalId} ist nur der Demo-Adapter aktiv. MCP-Modus auf stdio umstellen.`), { statusCode: 409 });
  }
}
