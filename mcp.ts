// MCP over streamable HTTP: a plain JSON-RPC endpoint (no SSE), the six
// tools the suite lists and calls, and the discover/initialize handshake.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN } from './store.ts';
import type { Forge } from './store.ts';
import { issueJson, pullJson, repoJson } from './views.ts';

export interface McpContext {
  forge: Forge;
  token: string;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  requestId: () => string;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository for the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
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
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

type Json = Record<string, unknown>;

function toolResult(value: unknown, isError = false): Json {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function missingArg(tool: string, arg: string): Json {
  return toolResult(`missing required argument ${arg} for ${tool}`, true);
}

function callTool(ctx: McpContext, name: string, args: Json): Json {
  const forge = ctx.forge;
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name.trim() : '';
      if (repoName === '') return missingArg(name, 'name');
      const repo = forge.createRepo(
        VIEWER_LOGIN,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      if (repo === null) return toolResult('name already exists on this account', true);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      if (owner === '') return missingArg(name, 'owner');
      if (repoName === '') return missingArg(name, 'repo');
      const repo = owner === VIEWER_LOGIN ? forge.getRepo(owner, repoName) ?? null : null;
      if (repo === null) return toolResult('Not Found', true);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      const title = typeof args.title === 'string' ? args.title : '';
      if (owner === '') return missingArg(name, 'owner');
      if (repoName === '') return missingArg(name, 'repo');
      if (title === '') return missingArg(name, 'title');
      const repo = owner === VIEWER_LOGIN ? forge.getRepo(owner, repoName) ?? null : null;
      if (repo === null) return toolResult('Not Found', true);
      const issue = forge.createIssue(repo, title, typeof args.body === 'string' ? args.body : '');
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      if (owner === '') return missingArg(name, 'owner');
      if (repoName === '') return missingArg(name, 'repo');
      const repo = owner === VIEWER_LOGIN ? forge.getRepo(owner, repoName) ?? null : null;
      if (repo === null) return toolResult('Not Found', true);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => issueJson(repo, issue));
      return toolResult(issues);
    }
    case 'create_pull_request': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (owner === '') return missingArg(name, 'owner');
      if (repoName === '') return missingArg(name, 'repo');
      if (title === '') return missingArg(name, 'title');
      if (head === '') return missingArg(name, 'head');
      if (base === '') return missingArg(name, 'base');
      const repo = owner === VIEWER_LOGIN ? forge.getRepo(owner, repoName) ?? null : null;
      if (repo === null) return toolResult('Not Found', true);
      const pr = forge.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      if (pr === null) return toolResult('A pull request already exists for this head branch', true);
      return toolResult(pullJson(repo, pr));
    }
    case 'merge_pull_request': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : -1;
      if (owner === '') return missingArg(name, 'owner');
      if (repoName === '') return missingArg(name, 'repo');
      if (pullNumber < 0) return missingArg(name, 'pull_number');
      const repo = owner === VIEWER_LOGIN ? forge.getRepo(owner, repoName) ?? null : null;
      if (repo === null) return toolResult('Not Found', true);
      const pr = repo.prs.get(pullNumber);
      if (pr === undefined) return toolResult('Not Found', true);
      const sha = forge.mergePull(repo, pr);
      if (sha === null) return toolResult('Merge conflict', true);
      return toolResult({ merged: true, sha, message: `Merge pull request #${pr.number} from ${pr.headRef}` });
    }
    default:
      return toolResult(`unknown tool ${name}`, true);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: McpContext): Promise<boolean> {
  if (req.method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': ctx.requestId() });
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    ctx.sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (ctx.token !== '' && req.headers.authorization !== `Bearer ${ctx.token}`) {
    ctx.sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    ctx.sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    ctx.sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    ctx.sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const request = payload as Json;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Json;

  // Notifications carry no id and get a bare 202.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': ctx.requestId() });
    res.end();
    return true;
  }

  const reply = (result: unknown): void => {
    ctx.sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const replyError = (code: number, message: string): void => {
    ctx.sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  if (method === 'server/discover') {
    reply({
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
    return true;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    reply({
      protocolVersion: SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
    return true;
  }
  if (method === 'ping') {
    reply({});
    return true;
  }
  if (method === 'tools/list') {
    reply({ tools: TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Json;
    if (!TOOLS.some((tool) => tool.name === toolName)) {
      replyError(-32602, `unknown tool ${toolName}`);
      return true;
    }
    reply(callTool(ctx, toolName, toolArgs));
    return true;
  }
  replyError(-32601, `Method not found: ${method}`);
  return true;
}
