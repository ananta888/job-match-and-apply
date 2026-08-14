import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MCP_TOOL_CATALOG, type McpToolResult } from './agents/security-mcp-facade.js';
import { createAgentMcpServer, type AgentMcpServer } from './agent-mcp-server.js';

const open: Array<{ server: AgentMcpServer; client: Client }> = [];

async function connect(server: AgentMcpServer): Promise<Client> {
  const client = new Client({ name: 'offline-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
  open.push({ server, client });
  return client;
}

function structured(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  expect('structuredContent' in result).toBe(true);
  return result.structuredContent as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(open.splice(0).flatMap(({ server, client }) => [client.close(), server.close()]));
});

describe('local agent stdio MCP server', () => {
  it('publishes only health, catalog and the security-facade allowlist', async () => {
    const client = await connect(createAgentMcpServer());
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['agent.health', 'agent.tool_catalog', ...AGENT_MCP_TOOL_CATALOG.map((tool) => tool.name)].sort());
    expect(names).not.toEqual(expect.arrayContaining(['shell.execute', 'mail.send', 'application.submit', 'portal.login']));
    expect(listed.tools.every((tool) => tool.annotations?.openWorldHint === false)).toBe(true);
    expect(listed.tools.find((tool) => tool.name === 'domain.command.execute_local')?.annotations?.readOnlyHint).toBe(false);
  });

  it('returns minimal deterministic health without host, path or environment data', async () => {
    const server = createAgentMcpServer({ now: () => new Date('2026-08-13T20:00:00.000Z') });
    const client = await connect(server);
    const result = structured(await client.callTool({ name: 'agent.health', arguments: {} }));
    expect(result).toEqual({
      status: 'ok', server: 'job-match-and-apply-agent-mcp', version: '1.0.0', transport: 'stdio',
      networkListener: false, facadeToolCount: AGENT_MCP_TOOL_CATALOG.length, timestamp: '2026-08-13T20:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain(process.cwd());
  });

  it('routes allowlisted calls through the injected narrow executor without accepting approval flags', async () => {
    const execute = vi.fn(async (call: { name: string; arguments: unknown }): Promise<McpToolResult> => ({
      tool: call.name,
      category: 'read',
      data: { items: [], page: 0, hasMore: false },
      sourceReferences: [],
    }));
    const client = await connect(createAgentMcpServer({ executor: { execute } }));
    const result = await client.callTool({
      name: 'jobs.search',
      arguments: { profileId: 'profile-1', page: 0, pageSize: 10 },
    });
    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith({
      name: 'jobs.search', arguments: { profileId: 'profile-1', page: 0, pageSize: 10 },
    });
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('approvalValidated');
  });

  it('fails closed without a domain handler and never returns exception or secret details', async () => {
    const client = await connect(createAgentMcpServer());
    const unavailable = await client.callTool({
      name: 'jobs.search', arguments: { profileId: 'profile-1', page: 0, pageSize: 10 },
    });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.content).toEqual([{ type: 'text', text: '{"error":"mcp_tool_handler_unavailable"}' }]);

    const throwing = await connect(createAgentMcpServer({ executor: { async execute() { throw new Error('password=hunter2'); } } }));
    const failed = await throwing.callTool({
      name: 'jobs.search', arguments: { profileId: 'profile-1', page: 0, pageSize: 10 },
    });
    expect(JSON.stringify(failed)).toContain('mcp_tool_failed');
    expect(JSON.stringify(failed)).not.toContain('hunter2');
  });

  it('redacts secret-shaped result fields at the transport boundary', async () => {
    const client = await connect(createAgentMcpServer({ executor: { async execute(call) {
      return {
        tool: call.name, category: 'read', sourceReferences: [],
        data: { items: [], page: 0, hasMore: false, accessToken: 'never-return-this', nested: { password: 'also-secret' } },
      };
    } } }));
    const result = structured(await client.callTool({
      name: 'jobs.search', arguments: { profileId: 'profile-1', page: 0, pageSize: 10 },
    }));
    expect(result['accessToken']).toBe('[redacted]');
    expect(result['nested']).toEqual({ password: '[redacted]' });
    expect(JSON.stringify(result)).not.toContain('never-return-this');
  });
});
