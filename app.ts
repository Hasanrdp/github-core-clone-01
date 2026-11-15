// app.ts — the HTTP server: routing, auth, request parsing, responses.
//
// The hot paths are the bench workloads, so the request path is built for
// them: the URL is split by hand (one pass, no `new URL()` per request), a
// missing query string reuses one shared empty Map, a single-chunk body is
// returned directly without array allocation or Buffer.concat, and the
// Bearer token is computed once at startup. JSON replies that the store
// cached as Buffers are sent with content-length taken from the buffer
// itself, so nothing is re-encoded on the way out.
//
// Auth: every API route (/api/v3, /api/graphql, /mcp and *.git) requires
// `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing or wrong token is
// 401. /healthz and the HTML pages are unauthenticated.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestResp } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleGit, type GitResp } from './githttp.ts';
import { handleMcp, type McpRequest } from './mcp.ts';
import { homeView, repoView } from './views.ts';

/** The Bearer header the entry accepts, computed once at startup. */
export const AUTH_HEADER: string | null =
  process.env.MAKEFUN_SHOP_TOKEN !== undefined && process.env.MAKEFUN_SHOP_TOKEN !== ''
    ? `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}`
    : null;

/** One shared empty query map for requests without a query string. */
const EMPTY_QUERY = new Map<string, string>();

/** A per-request id counter (deterministic, unique, never the clock). */
let requestCounter = 0;

/** Percent-decode one path segment; the fast path skips decoding entirely. */
export function decodeSegment(segment: string): string {
  if (segment.indexOf('%') < 0) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a path into decoded segments in one pass (no split/filter/map). */
export function splitPath(path: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (let i = 0; i <= path.length; i += 1) {
    if (i === path.length || path[i] === '/') {
      if (i > start) segments.push(decodeSegment(path.slice(start, i)));
      start = i + 1;
    }
  }
  return segments;
}

/** Parse a query string into a Map; the empty string reuses EMPTY_QUERY. */
function parseQuery(queryString: string): Map<string, string> {
  if (queryString === '') return EMPTY_QUERY;
  const query = new Map<string, string>();
  let start = 0;
  for (let i = 0; i <= queryString.length; i += 1) {
    if (i === queryString.length || queryString[i] === '&') {
      if (i > start) {
        const pair = queryString.slice(start, i);
        const eq = pair.indexOf('=');
        const key = eq < 0 ? pair : pair.slice(0, eq);
        const value = eq < 0 ? '' : pair.slice(eq + 1);
        if (!query.has(key)) query.set(decodeSegment(key.replace(/\+/g, ' ')), decodeSegment(value.replace(/\+/g, ' ')));
      }
      start = i + 1;
    }
  }
  return query;
}

/**
 * Read the request body. A single-chunk body is returned directly — no array
 * allocation, no Buffer.concat — which is the common case for the bench.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let first: Buffer | null = null;
    let rest: Buffer[] | null = null;
    req.on('data', (chunk: Buffer) => {
      if (first === null) first = chunk;
      else {
        if (rest === null) rest = [first];
        rest.push(chunk);
      }
    });
    req.on('end', () => {
      if (first === null) resolve(Buffer.alloc(0));
      else if (rest === null) resolve(first);
      else resolve(Buffer.concat(rest));
    });
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, requestId: string, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': requestId,
    ...(extraHeaders ?? {}),
  };
  // A handler-supplied content-length or request id never overrides the real ones.
  headers['content-length'] = String(body.length);
  headers['x-github-request-id'] = requestId;
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, requestId: string, extraHeaders?: Record<string, string>): void {
  sendBuffer(res, status, Buffer.from(JSON.stringify(value), 'utf8'), 'application/json; charset=utf-8', requestId, extraHeaders);
}

function sendRest(res: ServerResponse, resp: RestResp, requestId: string): void {
  if (resp.body === null) {
    res.writeHead(resp.status, { 'x-github-request-id': requestId, ...(resp.headers ?? {}) });
    res.end();
    return;
  }
  if (Buffer.isBuffer(resp.body)) {
    sendBuffer(res, resp.status, resp.body, resp.headers?.['content-type'] ?? 'application/json; charset=utf-8', requestId, resp.headers);
    return;
  }
  sendJson(res, resp.status, resp.body, requestId, resp.headers);
}

function sendGit(res: ServerResponse, resp: GitResp, requestId: string): void {
  if (resp.body === null) {
    res.writeHead(resp.status, { 'x-github-request-id': requestId, ...(resp.headers ?? {}) });
    res.end();
    return;
  }
  if (Buffer.isBuffer(resp.body)) {
    sendBuffer(res, resp.status, resp.body, resp.headers?.['content-type'] ?? 'application/octet-stream', requestId, resp.headers);
    return;
  }
  sendJson(res, resp.status, resp.body, requestId, resp.headers);
}

/** The entry's request handler: one store, one process, no dependencies. */
export function createHandler(store: Store): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    requestCounter += 1;
    const requestId = `req-${requestCounter}`;
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const qm = url.indexOf('?');
    const path = qm < 0 ? url : url.slice(0, qm);
    const query = qm < 0 ? EMPTY_QUERY : parseQuery(url.slice(qm + 1));
    void (async () => {
      try {
        // /healthz — unauthenticated, the harness's liveness probe.
        if (path === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }
        // The HTML pages — unauthenticated, for a person in a browser.
        if (method === 'GET' && (path === '/' || path === '')) {
          sendBuffer(res, 200, Buffer.from(homeView(store.viewerRepos()), 'utf8'), 'text/html; charset=utf-8', requestId);
          return;
        }
        // Auth: every API and git route needs the shop token.
        if (AUTH_HEADER !== null && req.headers.authorization !== AUTH_HEADER) {
          sendJson(res, 401, { message: 'Bad credentials' }, requestId);
          return;
        }
        const segments = splitPath(path);
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);
          let parsed: unknown = null;
          if (body !== null && body.length > 0) {
            try {
              parsed = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
              return;
            }
          }
          const host = req.headers.host ?? 'localhost';
          // handleRest indexes the full segments (s[2] is 'user'/'repos').
          sendRest(res, handleRest(store, { method, segments, query, body: parsed, host }), requestId);
          return;
        }
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
            return;
          }
          sendJson(res, 200, handleGraphQL({ store, body: parsed }), requestId);
          return;
        }
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (method === 'DELETE') {
            // A legacy session close: no session is ever handed out, so
            // there is nothing to delete; acknowledge it.
            res.writeHead(204, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            // The suite's parse-error check: HTTP 400, JSON-RPC -32700.
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, requestId);
            return;
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, requestId);
            return;
          }
          const outcome = handleMcp(store, parsed as McpRequest);
          if (outcome.body === null) {
            res.writeHead(outcome.status, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.body, requestId);
          return;
        }
        // Git smart HTTP: /{owner}/{repo}.git/info/refs and the two RPCs.
        if (segments.length >= 2 && segments[1] !== undefined && segments[1].endsWith('.git')) {
          const owner = segments[0] as string;
          const repo = (segments[1] as string).slice(0, -4);
          const tail = segments.slice(2).join('/');
          if (tail === 'info/refs' && method === 'GET') {
            const service = query.get('service') ?? '';
            sendGit(res, handleGit(store, { method, owner, repo, service, body: null }), requestId);
            return;
          }
          if ((tail === 'git-upload-pack' || tail === 'git-receive-pack') && method === 'POST') {
            const body = await readBody(req);
            sendGit(res, handleGit(store, { method, owner, repo, service: tail, body }), requestId);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }
        // HTML: one repository page.
        if (method === 'GET' && segments.length === 2) {
          const repo = store.getRepo(segments[0] as string, segments[1] as string);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          const files: { name: string; type: string }[] = [];
          if (tip !== undefined) {
            const root = store.dirAt(repo, tip, '');
            if (root !== null) {
              for (const [name, entry] of root) files.push({ name, type: entry.type });
            }
          }
          sendBuffer(res, 200, Buffer.from(repoView(repo, files), 'utf8'), 'text/html; charset=utf-8', requestId);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        // A handler must never take the process down: answer 500 and keep
        // serving (the suite's error-survival checks depend on it).
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, requestId);
        } catch {
          try {
            res.end();
          } catch {
            // The socket is gone; nothing left to do.
          }
        }
      }
    })();
  };
}
