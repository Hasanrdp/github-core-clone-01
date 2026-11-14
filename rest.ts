// The GitHub REST v3 surface: repositories, branches, commits, contents,
// labels, issues, comments and pull requests, over the forge's one store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_ISO,
  VIEWER_LOGIN,
  displayMessage,
  headTreeOf,
  isOid,
  lineCount,
  listTreeDir,
  parseCommit,
  parseTree,
  setPathInTree,
} from './store.ts';
import type { Forge, Repo } from './store.ts';
import { commentJson, issueJson, labelJson, pullJson, repoJson, userJson } from './views.ts';

export interface RestContext {
  forge: Forge;
  token: string;
  sendJson: (res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>) => void;
  sendEmpty: (res: ServerResponse, status: number) => void;
  requestId: () => string;
}

type Json = Record<string, unknown>;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseQuery(url: string): { path: string; query: URLSearchParams } {
  const parsed = new URL(url, 'http://entry');
  return { path: parsed.pathname, query: parsed.searchParams };
}

function pageOf(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Number.parseInt(query.get('per_page') ?? '', 10);
  const page = Number.parseInt(query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPage) && perPage > 0 ? Math.min(perPage, 100) : 30,
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; hasNext: boolean; pageNo: number; perPage: number } {
  const { page, perPage } = pageOf(query);
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length, pageNo: page, perPage };
}

function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, pageNo: number, perPage: number): Record<string, string> {
  const host = req.headers.host ?? 'entry';
  const next = new URLSearchParams(query);
  next.set('per_page', String(perPage));
  next.set('page', String(pageNo + 1));
  return { link: `<http://${host}${path}?${next.toString()}>; rel="next"` };
}

async function jsonBody(req: IncomingMessage): Promise<{ ok: true; body: Json } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, body: {} };
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return { ok: true, body: parsed as Json };
    return { ok: true, body: {} };
  } catch {
    return { ok: false };
  }
}

function authed(req: IncomingMessage, token: string): boolean {
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

/** The repo a route names, or null (a foreign owner is a 404, never a 403). */
function lookupRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.forge.getRepo(owner, name) ?? null;
}

function badRequest(ctx: RestContext, res: ServerResponse, message: string): void {
  ctx.sendJson(res, 400, { message });
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<boolean> {
  const { path, query } = parseQuery(req.url ?? '/');
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';

  if (!authed(req, ctx.token)) {
    ctx.sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }

  const segments = path.split('/').filter((part) => part !== '').slice(2).map(decodeSegment);
  const sub = (index: number): string | undefined => segments[index];

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') {
      ctx.sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    ctx.sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (segments.length === 1 && sub(0) === 'meta' && method === 'GET') {
    ctx.sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // GET /api/v3/user
  if (segments.length === 1 && sub(0) === 'user' && method === 'GET') {
    ctx.sendJson(res, 200, userJson());
    return true;
  }

  // /api/v3/user/repos
  if (segments.length === 2 && sub(0) === 'user' && sub(1) === 'repos') {
    if (method === 'GET') {
      const repos = ctx.forge.listRepos(VIEWER_LOGIN);
      const { page, hasNext, pageNo, perPage } = paginate(repos, query);
      const extra = hasNext ? linkHeader(req, path, query, pageNo, perPage) : {};
      ctx.sendJson(res, 200, page.map(repoJson), extra);
      return true;
    }
    if (method === 'POST') {
      const parsed = await jsonBody(req);
      if (!parsed.ok) {
        badRequest(ctx, res, 'Problems parsing JSON');
        return true;
      }
      const name = typeof parsed.body.name === 'string' ? parsed.body.name.trim() : '';
      if (name === '') {
        ctx.sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      const repo = ctx.forge.createRepo(
        VIEWER_LOGIN,
        name,
        typeof parsed.body.description === 'string' ? parsed.body.description : '',
        parsed.body.private === true,
      );
      if (repo === null) {
        ctx.sendJson(res, 422, { message: 'name already exists on this account' });
        return true;
      }
      ctx.sendJson(res, 201, repoJson(repo));
      return true;
    }
    ctx.sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // /api/v3/repos/{owner}/{name}/...
  if (segments.length >= 3 && sub(0) === 'repos') {
    const owner = sub(1) as string;
    const name = sub(2) as string;
    const repo = lookupRepo(ctx, owner, name);
    const tail = segments.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') {
        if (repo === null) {
          ctx.sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        ctx.sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (repo === null) {
          ctx.sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        const parsed = await jsonBody(req);
        if (!parsed.ok) {
          badRequest(ctx, res, 'Problems parsing JSON');
          return true;
        }
        if (typeof parsed.body.description === 'string') repo.description = parsed.body.description;
        if (typeof parsed.body.private === 'boolean') repo.private = parsed.body.private;
        ctx.sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        if (repo === null) {
          ctx.sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        ctx.forge.deleteRepo(owner, name);
        ctx.sendEmpty(res, 204);
        return true;
      }
      ctx.sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    if (repo === null) {
      ctx.sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    return handleRepoSub(req, res, ctx, repo, tail, query);
  }

  ctx.sendJson(res, 404, { message: 'Not Found' });
  return true;
}

async function handleRepoSub(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const first = tail[0] as string;

  // Branches.
  if (first === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) as string }, protected: false }));
      ctx.sendJson(res, 200, list);
      return true;
    }
    if (tail.length === 2 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${tail[1]}`);
      if (sha === undefined) {
        ctx.sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      ctx.sendJson(res, 200, { name: tail[1], commit: { sha }, protected: false });
      return true;
    }
    ctx.sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Commits.
  if (first === 'commits' && tail.length === 1 && method === 'GET') {
    const ref = query.get('sha');
    const tip = ref === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null : ctx.forge.resolveRef(repo, ref);
    const commits = ctx.forge.listCommits(repo, tip);
    ctx.sendJson(
      res,
      200,
      commits.map((sha) => {
        const object = repo.objects.get(sha);
        const commit = object === undefined ? null : parseCommit(object.data);
        return {
          sha,
          commit: {
            message: commit === null ? '' : displayMessage(commit.message),
            author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_ISO },
            committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_ISO },
            tree: { sha: commit?.tree ?? '' },
          },
          author: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
          committer: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
        };
      }),
    );
    return true;
  }

  // Git data: refs.
  if (first === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      const parsed = await jsonBody(req);
      if (!parsed.ok) {
        badRequest(ctx, res, 'Problems parsing JSON');
        return true;
      }
      const ref = typeof parsed.body.ref === 'string' ? parsed.body.ref : '';
      const sha = typeof parsed.body.sha === 'string' ? parsed.body.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
        ctx.sendJson(res, 422, { message: 'Invalid request' });
        return true;
      }
      if (repo.refs.has(ref)) {
        ctx.sendJson(res, 422, { message: 'Reference already exists' });
        return true;
      }
      repo.refs.set(ref, sha);
      ctx.sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return true;
    }
    if (tail.length === 4 && tail[2] === 'heads' && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${tail[3]}`);
      if (sha === undefined) {
        ctx.sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      ctx.sendJson(res, 200, { ref: `refs/heads/${tail[3]}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return true;
    }
    ctx.sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Contents.
  if (first === 'contents') {
    const contentPath = tail.slice(1).join('/');
    return handleContents(req, res, ctx, repo, contentPath, query);
  }

  // Labels.
  if (first === 'labels') {
    if (tail.length === 1 && method === 'GET') {
      ctx.sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label.name, label.color)));
      return true;
    }
    if (tail.length === 1 && method === 'POST') {
      const parsed = await jsonBody(req);
      if (!parsed.ok) {
        badRequest(ctx, res, 'Problems parsing JSON');
        return true;
      }
      const name = typeof parsed.body.name === 'string' ? parsed.body.name.trim() : '';
      if (name === '') {
        ctx.sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      if (repo.labels.has(name)) {
        ctx.sendJson(res, 422, { message: 'already_exists' });
        return true;
      }
      const color = typeof parsed.body.color === 'string' ? parsed.body.color : 'ededed';
      repo.labels.set(name, { name, color });
      ctx.sendJson(res, 201, labelJson(name, color));
      return true;
    }
    ctx.sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Issues.
  if (first === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const parsed = await jsonBody(req);
        if (!parsed.ok) {
          badRequest(ctx, res, 'Problems parsing JSON');
          return true;
        }
        const title = typeof parsed.body.title === 'string' ? parsed.body.title : '';
        const body = typeof parsed.body.body === 'string' ? parsed.body.body : '';
        const labels = Array.isArray(parsed.body.labels) ? parsed.body.labels.filter((item): item is string => typeof item === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            ctx.sendJson(res, 422, { message: `Label does not exist: ${label}` });
            return true;
          }
        }
        const issue = ctx.forge.createIssue(repo, title, body, labels);
        ctx.sendJson(res, 201, issueJson(repo, issue));
        return true;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const { page, hasNext, pageNo, perPage } = paginate(issues, query);
        const extra = hasNext ? linkHeader(req, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query, pageNo, perPage) : {};
        ctx.sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), extra);
        return true;
      }
      ctx.sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const number = Number.parseInt(tail[1] ?? '', 10);
    const issue = repo.issues.get(number);
    if (tail.length === 2) {
      if (issue === undefined) {
        ctx.sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (method === 'GET') {
        ctx.sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        const parsed = await jsonBody(req);
        if (!parsed.ok) {
          badRequest(ctx, res, 'Problems parsing JSON');
          return true;
        }
        if (parsed.body.state === 'open' || parsed.body.state === 'closed') issue.state = parsed.body.state;
        if (typeof parsed.body.title === 'string') issue.title = parsed.body.title;
        if (typeof parsed.body.body === 'string') issue.body = parsed.body.body;
        ctx.sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      ctx.sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (issue === undefined) {
        ctx.sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (method === 'GET') {
        ctx.sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
        return true;
      }
      if (method === 'POST') {
        const parsed = await jsonBody(req);
        if (!parsed.ok) {
          badRequest(ctx, res, 'Problems parsing JSON');
          return true;
        }
        const body = typeof parsed.body.body === 'string' ? parsed.body.body : '';
        const comment = ctx.forge.addComment(repo, issue, body);
        ctx.sendJson(res, 201, commentJson(repo, issue, comment));
        return true;
      }
      ctx.sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    ctx.sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Pull requests.
  if (first === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const parsed = await jsonBody(req);
        if (!parsed.ok) {
          badRequest(ctx, res, 'Problems parsing JSON');
          return true;
        }
        const head = typeof parsed.body.head === 'string' ? parsed.body.head : '';
        const base = typeof parsed.body.base === 'string' ? parsed.body.base : '';
        const title = typeof parsed.body.title === 'string' ? parsed.body.title : '';
        const body = typeof parsed.body.body === 'string' ? parsed.body.body : '';
        if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
          ctx.sendJson(res, 422, { message: 'Invalid head or base branch' });
          return true;
        }
        const pr = ctx.forge.createPull(repo, title, body, head, base);
        if (pr === null) {
          ctx.sendJson(res, 422, { message: 'A pull request already exists for this head branch' });
          return true;
        }
        ctx.sendJson(res, 201, pullJson(repo, pr));
        return true;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let prs = [...repo.prs.values()];
        if (state === 'open') prs = prs.filter((pr) => pr.state === 'open');
        else if (state === 'closed') prs = prs.filter((pr) => pr.state === 'closed');
        prs.sort((a, b) => a.seq - b.seq);
        const { page, hasNext, pageNo, perPage } = paginate(prs, query);
        const extra = hasNext ? linkHeader(req, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, query, pageNo, perPage) : {};
        ctx.sendJson(res, 200, page.map((pr) => pullJson(repo, pr)), extra);
        return true;
      }
      ctx.sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const number = Number.parseInt(tail[1] ?? '', 10);
    const pr = repo.prs.get(number);
    if (tail.length === 2) {
      if (pr === undefined) {
        ctx.sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (method === 'GET') {
        ctx.sendJson(res, 200, pullJson(repo, pr));
        return true;
      }
      ctx.sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (pr === undefined) {
        ctx.sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const changes = ctx.forge.pullFiles(repo, pr);
      ctx.sendJson(
        res,
        200,
        changes.map((change) => {
          const status = change.oldOid === null ? 'added' : change.newOid === null ? 'removed' : 'modified';
          let additions = 0;
          let deletions = 0;
          if (change.newOid !== null) {
            const object = repo.objects.get(change.newOid);
            if (object !== undefined) additions = lineCount(object.data);
          }
          if (change.oldOid !== null) {
            const object = repo.objects.get(change.oldOid);
            if (object !== undefined) deletions = lineCount(object.data);
          }
          return { filename: change.path, status, additions, deletions, changes: additions + deletions };
        }),
      );
      return true;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      if (pr === undefined) {
        ctx.sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (pr.merged) {
        ctx.sendJson(res, 405, { message: 'Pull request already merged' });
        return true;
      }
      if (ctx.forge.pullConflict(repo, pr)) {
        ctx.sendJson(res, 405, { message: 'Merge conflict' });
        return true;
      }
      const mergeSha = ctx.forge.mergePull(repo, pr);
      if (mergeSha === null) {
        ctx.sendJson(res, 405, { message: 'Merge conflict' });
        return true;
      }
      ctx.sendJson(res, 200, { merged: true, sha: mergeSha, message: `Merge pull request #${pr.number} from ${pr.headRef}` });
      return true;
    }
    ctx.sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  ctx.sendJson(res, 404, { message: 'Not Found' });
  return true;
}

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  repo: Repo,
  contentPath: string,
  query: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const segments = contentPath === '' ? [] : contentPath.split('/');

  const resolveBranch = (): string | null => {
    const ref = query.get('ref');
    if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    return ctx.forge.resolveRef(repo, ref);
  };

  if (method === 'GET') {
    const tip = resolveBranch();
    if (tip === null) {
      ctx.sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const tree = headTreeOf(repo, tip);
    if (tree === null) {
      ctx.sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (segments.length === 0) {
      const entries = listTreeDir(repo.objects, tree, []);
      if (entries === null) {
        ctx.sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      ctx.sendJson(res, 200, dirEntries(repo, tree, '', entries));
      return true;
    }
    const found = lookupContent(repo, tree, segments);
    if (found === null) {
      ctx.sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (found.kind === 'file') {
      const object = repo.objects.get(found.oid);
      const data = object === undefined ? Buffer.alloc(0) : object.data;
      ctx.sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: segments[segments.length - 1],
        path: contentPath,
        content: data.toString('base64'),
        sha: found.oid,
      });
      return true;
    }
    ctx.sendJson(res, 200, dirEntries(repo, tree, contentPath, found.entries));
    return true;
  }

  if (method === 'PUT') {
    const parsed = await jsonBody(req);
    if (!parsed.ok) {
      badRequest(ctx, res, 'Problems parsing JSON');
      return true;
    }
    const message = typeof parsed.body.message === 'string' ? parsed.body.message : '';
    const contentB64 = typeof parsed.body.content === 'string' ? parsed.body.content : '';
    const branch = typeof parsed.body.branch === 'string' ? parsed.body.branch : repo.defaultBranch;
    const sha = typeof parsed.body.sha === 'string' ? parsed.body.sha : undefined;
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      ctx.sendJson(res, 400, { message: 'content is not valid base64' });
      return true;
    }
    const tip = repo.refs.get(`refs/heads/${branch}`);
    let isUpdate = false;
    if (tip !== undefined) {
      const tree = headTreeOf(repo, tip);
      if (tree !== null) {
        const existing = lookupContent(repo, tree, segments);
        if (existing !== null && existing.kind === 'file') {
          isUpdate = true;
          if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
            ctx.sendJson(res, 409, { message: 'sha does not match the current blob' });
            return true;
          }
        }
      }
    }
    const result = ctx.forge.commitFile(repo, branch, contentPath, content, message);
    ctx.sendJson(res, isUpdate ? 200 : 201, {
      content: { name: segments[segments.length - 1], path: contentPath, sha: result.contentSha, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: result.commitSha, message },
    });
    return true;
  }

  if (method === 'DELETE') {
    const parsed = await jsonBody(req);
    if (!parsed.ok) {
      badRequest(ctx, res, 'Problems parsing JSON');
      return true;
    }
    const message = typeof parsed.body.message === 'string' ? parsed.body.message : '';
    const branch = typeof parsed.body.branch === 'string' ? parsed.body.branch : repo.defaultBranch;
    const commitSha = ctx.forge.deleteFile(repo, branch, contentPath, message);
    if (commitSha === null) {
      ctx.sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    ctx.sendJson(res, 200, { commit: { sha: commitSha, message } });
    return true;
  }

  ctx.sendJson(res, 404, { message: 'Not Found' });
  return true;
}

function lookupContent(
  repo: Repo,
  tree: string,
  segments: string[],
): { kind: 'file'; oid: string } | { kind: 'dir'; entries: Array<{ mode: string; name: string; oid: string }> } | null {
  let current: string | null = tree;
  for (let depth = 0; depth < segments.length; depth += 1) {
    if (current === null) return null;
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[depth]);
    if (entry === undefined) return null;
    if (depth === segments.length - 1) {
      if (entry.mode === '40000') {
        const child = repo.objects.get(entry.oid);
        if (child === undefined || child.type !== 'tree') return null;
        return { kind: 'dir', entries: parseTree(child.data) };
      }
      return { kind: 'file', oid: entry.oid };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function dirEntries(
  repo: Repo,
  _tree: string,
  dirPath: string,
  entries: Array<{ mode: string; name: string; oid: string }>,
): Array<Record<string, unknown>> {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => {
      const isDir = entry.mode === '40000';
      const object = repo.objects.get(entry.oid);
      return {
        type: isDir ? 'dir' : 'file',
        size: isDir ? 0 : (object?.data.length ?? 0),
        name: entry.name,
        path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
        sha: entry.oid,
      };
    });
}
