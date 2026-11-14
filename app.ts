// The one-process forge: one http server, four protocol surfaces over one
// in-memory store. /healthz is open; the git smart-HTTP routes carry no
// bearer token (the git client does not send one); REST, GraphQL and MCP
// require the trial token.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleGit } from './githttp.ts';
import type { GitContext } from './githttp.ts';
import { handleRest } from './rest.ts';
import type { RestContext } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import type { GraphqlContext } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import type { McpContext } from './mcp.ts';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(payload);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': requestId() });
  res.end();
}

export function createForgeServer(): ReturnType<typeof createServer> {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const gitCtx: GitContext = { forge, sendJson, requestId };
  const restCtx: RestContext = { forge, token, sendJson, sendEmpty, requestId };
  const graphqlCtx: GraphqlContext = { forge, token, sendJson, requestId };
  const mcpCtx: McpContext = { forge, token, sendJson, requestId };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;

        if (path === '/healthz' && req.method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/api/graphql') {
          await handleGraphql(req, res, graphqlCtx);
          return;
        }
        if (path === '/mcp') {
          await handleMcp(req, res, mcpCtx);
          return;
        }
        if (path.startsWith('/api/v3')) {
          await handleRest(req, res, restCtx);
          return;
        }
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          const handled = await handleGit(req, res, gitCtx, gitMatch[1] as string, gitMatch[2] as string, gitMatch[3] ?? '', url.searchParams);
          if (handled) return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
