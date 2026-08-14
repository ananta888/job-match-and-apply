import type { ProviderDomainToolBridge, ProviderDomainToolDescriptor } from '../ports/agent-runner.js';
import type { RunBoundAgentMcpSession } from '../agent-mcp-run-factory.js';

export function createProviderDomainToolBridge(session: RunBoundAgentMcpSession): ProviderDomainToolBridge {
  const catalog = new Map(session.listTools().map((tool) => [tool.name, tool]));
  const descriptor = (name: string) => {
    const tool = catalog.get(name);
    if (!tool) throw new Error('mcp_tool_unknown');
    return tool;
  };
  return {
    namespace: 'job_match_apply',
    listTools(): ProviderDomainToolDescriptor[] {
      return [...catalog.values()].map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: structuredClone(tool.inputSchema),
        requiresApproval: tool.requiresApproval,
        risk: tool.risk,
      }));
    },
    async execute(name, args) {
      descriptor(name);
      const result = await session.execute({ name, arguments: structuredClone(args) });
      return { data: structuredClone(result.data), sourceReferences: [...result.sourceReferences] };
    },
    async requestApproval(name, args) {
      const tool = descriptor(name);
      const request = await session.requestApproval({ name, arguments: structuredClone(args) });
      return {
        id: request.id, title: tool.title,
        explanation: `${tool.title} benoetigt eine einmalige, parametergebundene Freigabe.`,
        risk: tool.risk, requestedAt: request.createdAt, expiresAt: request.expiresAt,
      };
    },
    resolveApproval(requestId, decision, actor) {
      return session.resolveApproval(requestId, decision, actor);
    },
    revoke() { return session.revokeCapability(); },
  };
}
