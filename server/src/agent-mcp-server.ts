#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  AGENT_MCP_TOOL_CATALOG,
  type McpToolCall,
  type McpToolDescriptor,
  type McpToolResult,
} from './agents/security-mcp-facade.js';

const SERVER_NAME = 'job-match-and-apply-agent-mcp';
const SERVER_VERSION = '1.0.0';
const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const HEALTH_TOOL = 'agent.health';
const CATALOG_TOOL = 'agent.tool_catalog';
const SECRET_KEY = /(?:authorization|cookie|credential|password|secret|session|token)/i;

export interface AgentMcpToolExecutor {
  /**
   * The executor is expected to be a closure around RestrictedAgentMcpFacade,
   * its server-owned run scope and its approval verifier. Client arguments are
   * never promoted to approvalValidated by this transport boundary.
   */
  execute(call: Readonly<Pick<McpToolCall, 'name' | 'arguments'>>): Promise<McpToolResult>;
}

export interface AgentMcpServerOptions {
  executor?: AgentMcpToolExecutor;
  /** Server-owned run scope; never populated from MCP client arguments. */
  toolNames?: readonly string[];
  now?: () => Date;
}

export interface AgentMcpServer {
  server: Server;
  connectStdio(): Promise<void>;
  close(): Promise<void>;
}

function jsonObjectSchema(properties: Record<string, object>, required: string[] = []): Tool['inputSchema'] {
  return { type: 'object', properties, required, additionalProperties: false };
}

const systemTools: Tool[] = [
  {
    name: HEALTH_TOOL,
    title: 'Agent-MCP Status',
    description: 'Liefert ausschliesslich lokalen Protokollstatus und die Anzahl fest freigegebener Werkzeuge.',
    inputSchema: jsonObjectSchema({}),
    outputSchema: jsonObjectSchema({
      status: { type: 'string', enum: ['ok'] },
      server: { type: 'string' },
      version: { type: 'string' },
      transport: { type: 'string', enum: ['stdio'] },
      networkListener: { type: 'boolean', const: false },
      facadeToolCount: { type: 'integer', minimum: 0 },
      timestamp: { type: 'string', format: 'date-time' },
    }, ['status', 'server', 'version', 'transport', 'networkListener', 'facadeToolCount', 'timestamp']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: CATALOG_TOOL,
    title: 'Sicherer Toolkatalog',
    description: 'Listet die feste Allowlist mit Risiko- und Freigabemetadaten; keine Konfiguration oder Secrets.',
    inputSchema: jsonObjectSchema({}),
    outputSchema: jsonObjectSchema({
      tools: { type: 'array', items: { type: 'object' } },
      forbiddenCapabilities: { type: 'array', items: { type: 'string' } },
    }, ['tools', 'forbiddenCapabilities']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function propertySchema(name: string, direction: 'input' | 'output'): object {
  if (['page', 'pageSize', 'expectedRevision'].includes(name)) return { type: 'integer', minimum: name === 'pageSize' ? 1 : 0 };
  if (name === 'revision') return { type: 'integer', minimum: 0 };
  if (name === 'hasMore' || name === 'duplicate') return { type: 'boolean' };
  if (name === 'items') return { type: 'array', items: { type: 'object', additionalProperties: true } };
  if (name === 'sourceReferences') return { type: 'array', items: { type: 'string' } };
  if (direction === 'output' && ['payload', 'dryRun', 'result'].includes(name)) return {};
  if (name === 'documentType') return { type: 'string', enum: ['cv', 'cover_letter', 'email'] };
  return { type: 'string', minLength: 1 };
}

function normalizedSchema(schema: Readonly<Record<string, unknown>>, direction: 'input' | 'output'): Tool['inputSchema'] {
  const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
  const declared = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, object>
    : {};
  const properties = Object.fromEntries(required.map((name) => [name, declared[name] ?? propertySchema(name, direction)]));
  return { type: 'object', properties, required, additionalProperties: direction === 'output' };
}

function descriptorTool(descriptor: McpToolDescriptor): Tool {
  return {
    name: descriptor.name,
    title: descriptor.title,
    description: descriptor.description,
    inputSchema: normalizedSchema(descriptor.inputSchema, 'input'),
    outputSchema: normalizedSchema(descriptor.outputSchema, 'output'),
    annotations: {
      readOnlyHint: descriptor.externalSideEffect === false && ['read', 'propose'].includes(descriptor.category),
      destructiveHint: false,
      idempotentHint: descriptor.category === 'read',
      openWorldHint: false,
    },
    _meta: {
      version: descriptor.version,
      category: descriptor.category,
      risk: descriptor.risk,
      requiresApproval: descriptor.requiresApproval,
      requiresApplicationCaseScope: descriptor.requiresApplicationCaseScope,
      externalSideEffect: false,
    },
  };
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, seen));
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) output[key] = SECRET_KEY.test(key) ? '[redacted]' : sanitize(entry, seen);
  return output;
}

function serialized(value: unknown, maximum: number): string {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text, 'utf8') > maximum) throw new Error('mcp_payload_too_large');
  return text;
}

function success(data: unknown, sourceReferences?: readonly string[]): CallToolResult {
  const safe = sanitize(data) as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: serialized(safe, MAX_RESULT_BYTES) }], structuredContent: safe,
    ...(sourceReferences ? { _meta: { sourceReferences: [...sourceReferences] } } : {}),
  };
}

function failure(code: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: code }) }], isError: true };
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'mcp_tool_failed';
  if (/^mcp_[a-z0-9_:,-]+$/.test(error.message)) return error.message.slice(0, 180);
  return 'mcp_tool_failed';
}

function publicDescriptor(descriptor: McpToolDescriptor): Record<string, unknown> {
  return {
    name: descriptor.name,
    version: descriptor.version,
    title: descriptor.title,
    category: descriptor.category,
    risk: descriptor.risk,
    description: descriptor.description,
    externalSideEffect: false,
    requiresApproval: descriptor.requiresApproval,
    requiresApplicationCaseScope: descriptor.requiresApplicationCaseScope,
    inputSchema: normalizedSchema(descriptor.inputSchema, 'input'),
    outputSchema: normalizedSchema(descriptor.outputSchema, 'output'),
  };
}

export function createAgentMcpServer(options: AgentMcpServerOptions = {}): AgentMcpServer {
  const now = options.now ?? (() => new Date());
  const requestedTools = options.toolNames ? new Set(options.toolNames) : undefined;
  if (requestedTools && [...requestedTools].some((name) => !AGENT_MCP_TOOL_CATALOG.some((tool) => tool.name === name))) {
    throw new Error('mcp_server_tool_scope_invalid');
  }
  const scopedCatalog = requestedTools ? AGENT_MCP_TOOL_CATALOG.filter((tool) => requestedTools.has(tool.name)) : AGENT_MCP_TOOL_CATALOG;
  const descriptors = new Map(scopedCatalog.map((descriptor) => [descriptor.name, descriptor]));
  const tools = [...systemTools, ...scopedCatalog.map(descriptorTool)];
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: 'Lokaler fail-closed MCP-Zugang. Keine Shell-, Versand-, Login-, Credential- oder beliebigen Netzwerkwerkzeuge; die optionale Jobsuche ist ausschliesslich ein Root-seitig begrenzter Trusted-Host-Leseproxy.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(tools) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    try {
      serialized(args, MAX_ARGUMENT_BYTES);
      if (name === HEALTH_TOOL) {
        if (Object.keys(args).length) return failure('mcp_tool_arguments_invalid');
        return success({
          status: 'ok', server: SERVER_NAME, version: SERVER_VERSION, transport: 'stdio',
          networkListener: false, facadeToolCount: scopedCatalog.length, timestamp: now().toISOString(),
        });
      }
      if (name === CATALOG_TOOL) {
        if (Object.keys(args).length) return failure('mcp_tool_arguments_invalid');
        return success({
          tools: scopedCatalog.map(publicDescriptor),
          forbiddenCapabilities: ['arbitrary_shell', 'mail_send', 'application_submit', 'portal_login', 'arbitrary_network'],
        });
      }
      if (!descriptors.has(name)) return failure('mcp_tool_unknown');
      if (!options.executor) return failure('mcp_tool_handler_unavailable');
      const result = await options.executor.execute({ name, arguments: structuredClone(args) });
      if (result.tool !== name) return failure('mcp_tool_result_mismatch');
      return success(result.data, result.sourceReferences);
    } catch (error) {
      return failure(safeErrorCode(error));
    }
  });

  return {
    server,
    async connectStdio() { await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_ARGUMENT_BYTES })); },
    async close() { await server.close(); },
  };
}

export async function startAgentMcpStdio(): Promise<void> {
  const instance = createAgentMcpServer();
  await instance.connectStdio();
}

const directInvocation = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (directInvocation) {
  startAgentMcpStdio().catch(() => {
    // stdout is reserved for MCP framing; do not print environment details or stack traces.
    process.stderr.write(`${SERVER_NAME}: startup failed\n`);
    process.exitCode = 1;
  });
}
