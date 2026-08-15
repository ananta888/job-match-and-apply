import {
  createApp, createDefaultAgentApiDependencies, restorePrivateAgentRunClassifications,
} from './app.js';
import { attachAgentRealtimeGateway } from './agents/agent-realtime-gateway.js';

const port = Number(process.env.PORT ?? 3000);
const agentApi = createDefaultAgentApiDependencies();
const recovery = await agentApi.center.recover();
await restorePrivateAgentRunClassifications(agentApi);
if (recovery.errors.length > 0) console.error(`Agent-Run-Recovery meldet ${recovery.errors.length} Fehler.`);
const server = createApp(undefined, undefined, undefined, undefined, agentApi).listen(port, '127.0.0.1', () => {
  console.log(`Job Match & Apply API: http://127.0.0.1:${port}`);
});
const realtimeGateway = agentApi.realtimeTickets
  ? attachAgentRealtimeGateway(server, agentApi.center, agentApi.realtimeTickets)
  : undefined;

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  const realtimeClosed = realtimeGateway ? realtimeGateway.close() : Promise.resolve();
  void realtimeClosed.finally(() => {
    server.close(() => { void agentApi.center.dispose().finally(() => process.exit(0)); });
  });
  setTimeout(() => { void agentApi.center.dispose().finally(() => process.exit(1)); }, 10_000).unref();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
