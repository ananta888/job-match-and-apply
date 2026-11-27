import express from 'express';
import cors from 'cors';
import type { ConfigStore } from './services/config-store.js';
import { JsonConfigStore, MemoryConfigStore } from './services/config-store.js';
import type { AuditLogger } from './services/audit-logger.js';
import type { WorkspaceStore } from './services/workspace-store.js';
import { EncryptedMailVault } from './services/mail-vault.js';
import {
  createDefaultAgentApiDependencies, type AgentApiDependencies, type ApplicationPipelineApiDependencies,
} from './http/app-support.js';
import { loopbackRequestGuard } from './services/loopback-request-guard.js';
import { createAppContext } from './http/app-context.js';
import { registerErrorHandler, registerRequestLogging } from './http/middleware.js';
import { registerAgentSetupRoutes } from './http/routes/agent-setup.js';
import { registerAgentOrchestrationRoutes } from './http/routes/agent-orchestrations.js';
import { registerAgentRunRoutes } from './http/routes/agent-runs.js';
import { registerAgentRunDetailRoutes } from './http/routes/agent-run-detail.js';
import { registerSearchRoutes } from './http/routes/search.js';
import { registerApplicationRoutes } from './http/routes/applications.js';
import { registerProfileCvRoutes } from './http/routes/profile-cv.js';

export { createDefaultAgentApiDependencies, adoptApprovedAgentArtifact, restorePrivateAgentRunClassifications } from './http/app-support.js';
export type { AgentApiDependencies, ApplicationPipelineApiDependencies } from './http/app-support.js';

export function createApp(
  store: ConfigStore = new JsonConfigStore(),
  audit?: AuditLogger,
  workspace?: WorkspaceStore,
  mailVault: EncryptedMailVault = new EncryptedMailVault(),
  agentApi: AgentApiDependencies = createDefaultAgentApiDependencies(store instanceof MemoryConfigStore),
  applicationPipeline?: ApplicationPipelineApiDependencies
) {
  const ctx = createAppContext(store, audit, workspace, mailVault, agentApi, applicationPipeline);
  const app = express();
  // Reject DNS-rebinding requests (foreign Host/Origin) before CORS, parsing or routing.
  app.use(loopbackRequestGuard());
  app.use(cors({ origin: [
    'http://localhost:4201', 'http://127.0.0.1:4201',
  ] }));
  const ordinaryJson = express.json({ limit: '512kb' });
  app.use((request, response, next) => request.path === '/api/cv-imports' ? next() : ordinaryJson(request, response, next));

  registerRequestLogging(app, ctx);

  app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));

  // Registration order is route-matching order; keep it.
  registerAgentSetupRoutes(app, ctx);
  registerAgentOrchestrationRoutes(app, ctx);
  registerAgentRunRoutes(app, ctx);
  registerAgentRunDetailRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerApplicationRoutes(app, ctx);
  registerProfileCvRoutes(app, ctx);

  registerErrorHandler(app, ctx);

  return app;
}
