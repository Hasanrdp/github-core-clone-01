// mcp.ts — Model Context Protocol endpoint at POST /mcp (Streamable HTTP).
//
// Two protocol eras, one endpoint (the kit's mcp-client.ts speaks both):
//   modern  2026-07-28: no handshake; every request carries _meta with the
//           revision, and `server/discover` returns identity, capabilities
//           and supportedVersions in one answer.
//   legacy  2025-11-25 and earlier: `initialize` (echoing the revision the
//           client offered) + `notifications/initialized`, no discover.
// The server answers modern first: server/discover always succeeds, so the
// suite negotiates 2026-07-28 and never needs the handshake.
//
// Tools (all six the suite requires, by exact canonical name): create_repo,
// get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request. Every tool result carries the same JSON twice — once
// as a text block and once as structuredContent — because the suite reads
// whichever of the two a given check looks at. Unknown tools and calls with
// missing required arguments answer JSON-RPC -32602, never HTTP 500.

import { VIEWER_LOGIN, type Store } from './store.ts';
import { issueJsonObject, pullJsonObject, repoJsonObject } from './rest.ts';

export const MCP_SERVER_NAME = 'git-forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const API_ROOT = 'http://localhost/api/v3';

/** One JSON-RPC request (the body app.ts parsed for /mcp). */
export interface McpRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** The answer app.ts serializes for a /mcp request; null = no body (202). */
export interface McpResponse {
  status: number;
  /** The JSON-RPC response object, or null for a notification answer. */
  body: Record<string, unknown> | null;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/**
 * The tools list, built once as a literal: the suite's tools-list-idempotent
 * check requires two tools/list answers to hold the same array byte for
 * byte, so the same object is serialized every time.
 */
export const MCP_TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head ref into a base ref.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch or ref.' },
        base: { type: 'string', description: 'The base branch or ref.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function result(id: unknown, value: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result: value } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

/** A tool result: the same JSON as a text block and as structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
  };
}

/** A tool failure: isError true with the reason in a text block. */
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

const SERVER_INFO = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };

function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'server/discover',
    supportedVersions: [...MCP_SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    instructions: 'A GitHub core clone: repositories, issues, pull requests and git over MCP tools.',
    serverInfo: { ...SERVER_INFO },
    _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
  };
}

function initializeResult(params: Record<string, unknown>): Record<string, unknown> {
  const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
  return {
    protocolVersion: negotiated,
    capabilities: { tools: {} },
    serverInfo: { ...SERVER_INFO },
  };
}

/** Run one tool by name; returns the tool result object or a JSON-RPC error. */
function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): { value: Record<string, unknown> } | { error: string } {
  const tool = MCP_TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return { error: `unknown tool ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { error: `missing required argument ${required}` };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        return { value: toolError(`repository ${VIEWER_LOGIN}/${repoName} already exists`) };
      }
      const repo = store.createRepo(repoName, args.private === true, str(args.description));
      if (repo === null) return { value: toolError(`cannot create repository ${repoName}`) };
      return { value: toolResult(repoJsonObject(API_ROOT, repo)) };
    }
    case 'get_repo': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return { value: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
      return { value: toolResult(repoJsonObject(API_ROOT, repo)) };
    }
    case 'create_issue': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return { value: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
      const created = store.createIssue(repo, str(args.title), str(args.body), []);
      if ('error' in created) return { value: toolError(created.error) };
      return { value: toolResult(issueJsonObject(API_ROOT, repo, created.issue)) };
    }
    case 'list_issues': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return { value: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
      const state = str(args.state) === '' ? 'open' : str(args.state);
      const issues = store.listIssues(repo, state, 'desc');
      return { value: toolResult(issues.map((issue) => issueJsonObject(API_ROOT, repo, issue))) };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return { value: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
      const created = store.createPull(repo, str(args.title), str(args.body), str(args.head), str(args.base));
      if ('error' in created) {
        return { value: toolError(`cannot open a pull request from ${String(args.head)} into ${String(args.base)}: ${created.error}`) };
      }
      return { value: toolResult(pullJsonObject(API_ROOT, repo, created.pull)) };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return { value: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { value: toolError(`pull request #${String(number)} not found`) };
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) {
        return { value: toolError(`pull request #${String(number)} cannot be merged: ${merged.error}`) };
      }
      return { value: toolResult(pullJsonObject(API_ROOT, repo, pull)) };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

/**
 * Handle one JSON-RPC request on /mcp. Notifications (no id) answer null,
 * which app.ts turns into an empty 202.
 */
export function handleMcp(store: Store, request: McpRequest): McpResponse {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};
  if (method === '') return rpcError(id, -32600, 'invalid request: no method');
  if (method === 'server/discover') return result(id, discoverResult());
  if (method === 'initialize') return result(id, initializeResult(params));
  if (method === 'notifications/initialized') return { status: 202, body: null };
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') return result(id, { tools: MCP_TOOLS });
  if (method === 'tools/call') {
    const name = str(params.name);
    const args = isRecord(params.arguments) ? params.arguments : {};
    const outcome = callTool(store, name, args);
    if ('error' in outcome) return rpcError(id, -32602, outcome.error);
    return result(id, outcome.value);
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}
