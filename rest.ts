// rest.ts — the GitHub REST v3 surface under /api/v3.
//
// Every reply is JSON with an X-GitHub-Request-Id; errors carry a string
// `message`. A repository belongs to the token owner, so the same name under
// another owner is a 404, never a 403, and a missing token is a 401 (the
// auth itself is checked in app.ts before this dispatcher runs).
//
// The read workload (2,000 sequential GETs of one issue) is the hot path:
// GET /issues/{n} answers a Buffer cached on the issue record, so a
// repeated read skips the object build, JSON.stringify and UTF-8 encode
// entirely. The cache is cleared by any mutation of that issue.

import {
  FIXED_TIME,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  globalId,
  isOid,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

/** What app.ts hands a handler: decoded segments, query, parsed body, host. */
export interface RestCtx {
  method: string;
  /** Path segments, percent-decoded, without empty pieces. */
  segments: string[];
  /** Query parameters (first value wins). */
  query: Map<string, string>;
  /** The parsed JSON body, or null when there is none. */
  body: unknown;
  /** The request's Host header, for absolute pagination URLs. */
  host: string;
}

export interface RestResp {
  status: number;
  /** A Buffer is sent as-is; an object is JSON-encoded; null sends nothing. */
  body: Buffer | Record<string, unknown> | unknown[] | null;
  headers?: Record<string, string>;
}

const json = (status: number, body: Record<string, unknown> | unknown[], headers?: Record<string, string>): RestResp => ({ status, body, headers });
const buf = (status: number, body: Buffer, headers?: Record<string, string>): RestResp => ({ status, body, headers });
const err = (status: number, message: string): RestResp => json(status, { message });
const notFound = (what = 'Not Found'): RestResp => err(404, what);

/** The API root's own URL, for the `url` fields of every resource. */
const apiRoot = (ctx: RestCtx): string => `http://${ctx.host}/api/v3`;

// ---------------------------------------------------------------------------
// JSON shapes (GitHub-compatible; the suite checks listed fields, extras ok)
// ---------------------------------------------------------------------------

function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: globalId('User', id),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `https://api.github.com/users/${login}`,
    html_url: `https://github.com/${login}`,
    followers_url: `https://api.github.com/users/${login}/followers`,
    following_url: `https://api.github.com/users/${login}/following{/other_user}`,
    type: 'User',
    site_admin: false,
  };
}

/** Join cached per-item JSON buffers into one JSON array buffer. */
function arrayOfBuffers(bufs: readonly Buffer[]): Buffer {
  if (bufs.length === 0) return Buffer.from('[]', 'utf8');
  const parts: Buffer[] = [Buffer.from('[', 'utf8')];
  for (let i = 0; i < bufs.length; i += 1) {
    if (i > 0) parts.push(Buffer.from(',', 'utf8'));
    parts.push(bufs[i] as Buffer);
  }
  parts.push(Buffer.from(']', 'utf8'));
  return Buffer.concat(parts);
}

/** The REST JSON object for one repository (also used by the MCP tools). */
export function repoJsonObject(root: string, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER_ID),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${root}/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    pushed_at: FIXED_TIME,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: 0,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

/** The cached REST JSON for one repository, built once until mutated. */
function repoJson(ctx: RestCtx, repo: Repo): Buffer {
  if (repo.json !== null) return repo.json;
  repo.json = Buffer.from(JSON.stringify(repoJsonObject(apiRoot(ctx), repo)), 'utf8');
  return repo.json;
}

/** The REST JSON object for one issue (also used by the MCP tools). */
export function issueJsonObject(root: string, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = `${root}/repos/${repo.owner}/${repo.name}`;
  return {
    id: issue.seq,
    node_id: globalId('Issue', repo.id, issue.number),
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    labels_url: `${base}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/issues/${issue.number}/comments`,
    events_url: `${base}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) as Label)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: issue.state === 'closed' ? FIXED_TIME : null,
    author_association: 'OWNER',
  };
}

/** The cached REST JSON for one issue, built once and reused until mutated. */
export function issueJson(ctx: RestCtx, repo: Repo, issue: Issue): Buffer {
  if (issue.json !== null) return issue.json;
  issue.json = Buffer.from(JSON.stringify(issueJsonObject(apiRoot(ctx), repo, issue)), 'utf8');
  return issue.json;
}

function commentJson(ctx: RestCtx, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  const root = apiRoot(ctx);
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
    url: `${root}/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    author_association: 'OWNER',
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: 0,
    node_id: globalId('Label', label.name),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

/** The REST JSON object for one pull request (also used by the MCP tools). */
export function pullJsonObject(root: string, repo: Repo, pull: Pull): Record<string, unknown> {
  const base = `${root}/repos/${repo.owner}/${repo.name}`;
  const headRepo = { id: repo.id, node_id: globalId('Repository', repo.id), name: repo.name, full_name: `${repo.owner}/${repo.name}` };
  return {
    id: pull.seq,
    node_id: globalId('PullRequest', repo.id, pull.number),
    url: `${base}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `${base}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: pull.state === 'closed' ? FIXED_TIME : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.state === 'open',
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    merged_by: null,
    commits_url: `${base}/pulls/${pull.number}/commits`,
    review_comments_url: `${base}/pulls/${pull.number}/comments`,
    review_comment_url: `${base}/pulls/comments{/number}`,
    comments_url: `${base}/issues/${pull.number}/comments`,
    statuses_url: `${base}/commits/${pull.headSha}/statuses`,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(VIEWER_LOGIN, VIEWER_ID),
      repo: headRepo,
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(VIEWER_LOGIN, VIEWER_ID),
      repo: headRepo,
    },
    author_association: 'OWNER',
    auto_merge: null,
  };
}

/** The cached REST JSON for one pull request, built once until mutated. */
export function pullJson(ctx: RestCtx, repo: Repo, pull: Pull): Buffer {
  if (pull.json !== null) return pull.json;
  pull.json = Buffer.from(JSON.stringify(pullJsonObject(apiRoot(ctx), repo, pull)), 'utf8');
  return pull.json;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyRecord(ctx: RestCtx): Record<string, unknown> {
  return isRecord(ctx.body) ? ctx.body : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function intQuery(ctx: RestCtx, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Slice a list into a page and build the Link header for the next pages. */
function pageOf<T>(ctx: RestCtx, items: readonly T[], path: string): { page: T[]; link: string | null } {
  const perPage = Math.min(intQuery(ctx, 'per_page', 30), 100);
  const page = intQuery(ctx, 'page', 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page >= totalPages) return { page: slice, link: null };
  const base = `http://${ctx.host}${path}`;
  const link =
    `<${base}?per_page=${perPage}&page=${page + 1}>; rel="next", ` +
    `<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`;
  return { page: slice, link };
}

/** Look a repository up by owner/name segments; null when absent. */
function lookupRepo(store: Store, owner: string, name: string): Repo | null {
  return store.getRepo(owner, name) ?? null;
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

export function handleRest(store: Store, ctx: RestCtx): RestResp {
  const s = ctx.segments;
  // GET /api/v3/ — the API root.
  if (s.length === 2 && ctx.method === 'GET') {
    return json(200, {
      current_user_url: `${apiRoot(ctx)}/user`,
      repository_url: `${apiRoot(ctx)}/repos/{owner}/{repo}`,
      user_url: `${apiRoot(ctx)}/users/{username}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (s.length === 3 && s[2] === 'meta' && ctx.method === 'GET') {
    return json(200, { installed_version: '1.0.0', git_sha: 'git-forge' });
  }
  if (s.length === 3 && s[2] === 'user' && ctx.method === 'GET') {
    return json(200, userJson(VIEWER_LOGIN, VIEWER_ID));
  }
  // /api/v3/user/repos
  if (s.length === 4 && s[2] === 'user' && s[3] === 'repos') {
    if (ctx.method === 'GET') {
      const repos = store.viewerRepos();
      const { page, link } = pageOf(ctx, repos, '/api/v3/user/repos');
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return buf(200, arrayOfBuffers(page.map((repo) => repoJson(ctx, repo))), headers);
    }
    if (ctx.method === 'POST') {
      const input = bodyRecord(ctx);
      const name = str(input.name);
      if (name === '') return err(422, 'name is required');
      const created = store.createRepo(name, input.private !== false, str(input.description));
      if (created === null) return err(422, `Repository "${name}" already exists`);
      return buf(201, repoJson(ctx, created));
    }
    return err(405, 'Method Not Allowed');
  }
  // /api/v3/repos/{owner}/{repo}[/...]
  if (s.length >= 4 && s[2] === 'repos') {
    const repo = lookupRepo(store, s[3] as string, s[4] as string);
    if (repo === null) return notFound('Not Found');
    const rest = s.slice(5);
    if (rest.length === 0) return handleRepo(store, ctx, repo);
    const head = rest[0] as string;
    if (head === 'branches' && rest.length === 1) return handleBranches(store, ctx, repo);
    if (head === 'commits' && rest.length === 1) return handleCommits(store, ctx, repo);
    if (head === 'git' && rest.length >= 2 && rest[1] === 'refs') return handleGitRefs(store, ctx, repo, rest.slice(2));
    if (head === 'contents') return handleContents(store, ctx, repo, rest.slice(1));
    if (head === 'labels' && rest.length === 1) return handleLabels(store, ctx, repo);
    if (head === 'issues') return handleIssues(store, ctx, repo, rest.slice(1));
    if (head === 'pulls') return handlePulls(store, ctx, repo, rest.slice(1));
    return notFound();
  }
  return notFound();
}

function handleRepo(store: Store, ctx: RestCtx, repo: Repo): RestResp {
  if (ctx.method === 'GET') return buf(200, repoJson(ctx, repo));
  if (ctx.method === 'PATCH') {
    const input = bodyRecord(ctx);
    const description = input.description;
    if (typeof description === 'string') repo.description = description;
    if (typeof input.private === 'boolean') repo.isPrivate = input.private;
    repo.json = null;
    return buf(200, repoJson(ctx, repo));
  }
  if (ctx.method === 'DELETE') {
    store.deleteRepo(repo);
    return { status: 204, body: null };
  }
  return err(405, 'Method Not Allowed');
}

function handleBranches(store: Store, ctx: RestCtx, repo: Repo): RestResp {
  if (ctx.method !== 'GET') return err(405, 'Method Not Allowed');
  if (repo.branchesJson === null) {
    const root = apiRoot(ctx);
    const list = store.listBranches(repo).map((branch) => ({
      name: branch.name,
      commit: { sha: branch.sha, url: `${root}/repos/${repo.owner}/${repo.name}/commits/${branch.sha}` },
      protected: false,
    }));
    repo.branchesJson = Buffer.from(JSON.stringify(list), 'utf8');
  }
  return buf(200, repo.branchesJson);
}

function handleCommits(store: Store, ctx: RestCtx, repo: Repo): RestResp {
  if (ctx.method !== 'GET') return err(405, 'Method Not Allowed');
  const ref = ctx.query.get('sha');
  const commits = store.listCommits(repo, ref);
  const root = apiRoot(ctx);
  const list = commits.map((commit) => ({
    sha: commit.sha,
    node_id: globalId('Commit', commit.sha),
    commit: {
      message: commit.message,
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME },
      tree: { sha: '' },
    },
    author: userJson(VIEWER_LOGIN, VIEWER_ID),
    committer: userJson(VIEWER_LOGIN, VIEWER_ID),
    parents: commit.parents.map((sha) => ({ sha, url: `${root}/repos/${repo.owner}/${repo.name}/commits/${sha}` })),
    url: `${root}/repos/${repo.owner}/${repo.name}/commits/${commit.sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${commit.sha}`,
  }));
  return json(200, list);
}

function handleGitRefs(store: Store, ctx: RestCtx, repo: Repo, rest: string[]): RestResp {
  const root = apiRoot(ctx);
  const refJson = (ref: string, sha: string): Record<string, unknown> => ({
    ref,
    node_id: globalId('Ref', repo.id, ref),
    url: `${root}/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: { sha, type: 'commit', url: `${root}/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
  });
  if (ctx.method === 'POST' && rest.length === 0) {
    const input = bodyRecord(ctx);
    const ref = str(input.ref);
    const sha = str(input.sha);
    if (!ref.startsWith('refs/') || !isOid(sha)) return err(422, 'ref and sha are required');
    if (!store.createRef(repo, ref, sha)) return err(422, `Reference ${ref} already exists`);
    return json(201, refJson(ref, sha));
  }
  if (ctx.method === 'GET' && rest.length >= 2 && rest[0] === 'heads') {
    const branch = rest.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return notFound();
    return json(200, refJson(`refs/heads/${branch}`, sha));
  }
  return err(405, 'Method Not Allowed');
}

function handleContents(store: Store, ctx: RestCtx, repo: Repo, pathSegments: string[]): RestResp {
  const root = apiRoot(ctx);
  const path = pathSegments.join('/');
  const ref = ctx.query.get('ref');
  if (ctx.method === 'GET') {
    const blob = path === '' ? null : store.blobAt(repo, ref, path);
    if (blob !== null) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name,
        path,
        content: blob.data.toString('base64'),
        sha: blob.oid,
        url: `${root}/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
        git_url: `${root}/repos/${repo.owner}/${repo.name}/git/blobs/${blob.oid}`,
        download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
      });
    }
    const dir = store.dirAt(repo, ref, path);
    if (dir === null) return notFound();
    return json(200, dir.map((entry) => ({
      type: entry.type,
      name: entry.name,
      path: entry.path,
      sha: entry.oid,
      size: entry.type === 'file' ? (store.getObject(repo, entry.oid)?.data.length ?? 0) : 0,
      url: `${root}/repos/${repo.owner}/${repo.name}/contents/${entry.path}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${entry.path}`,
      git_url: `${root}/repos/${repo.owner}/${repo.name}/git/${entry.type === 'dir' ? 'trees' : 'blobs'}/${entry.oid}`,
      download_url: entry.type === 'file' ? `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${entry.path}` : null,
    })));
  }
  if (ctx.method === 'PUT') {
    const input = bodyRecord(ctx);
    const message = str(input.message) || `Update ${path}`;
    const contentB64 = str(input.content);
    if (contentB64 === '') return err(422, 'content is required');
    const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const branch = typeof input.branch === 'string' ? input.branch : undefined;
    if (branch !== undefined && repo.refs.get(`refs/heads/${branch}`) === undefined && repo.refs.size > 0) {
      return notFound('Branch not found');
    }
    const existed = store.blobAt(repo, branch, path) !== null;
    const sha = typeof input.sha === 'string' ? input.sha : undefined;
    const result = store.putContents(repo, branch, path, content, message, sha);
    if ('error' in result) {
      if (result.error === 'stale') return err(409, 'sha does not match the current blob');
      return err(422, 'could not commit the file');
    }
    const name = path.slice(path.lastIndexOf('/') + 1);
    return json(existed ? 200 : 201, {
      content: {
        name,
        path,
        sha: result.contentSha,
        size: content.length,
        url: `${root}/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
        git_url: `${root}/repos/${repo.owner}/${repo.name}/git/blobs/${result.contentSha}`,
        download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
        type: 'file',
        encoding: 'base64',
      },
      commit: {
        sha: result.commitSha,
        message,
        author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME },
        committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME },
      },
    });
  }
  if (ctx.method === 'DELETE') {
    const input = bodyRecord(ctx);
    const message = str(input.message) || `Delete ${path}`;
    const sha = typeof input.sha === 'string' ? input.sha : undefined;
    const branch = typeof input.branch === 'string' ? input.branch : undefined;
    const result = store.deleteContents(repo, branch, path, message, sha);
    if ('error' in result) {
      if (result.error === 'missing') return notFound();
      if (result.error === 'stale') return err(409, 'sha does not match the current blob');
      return notFound();
    }
    return json(200, {
      commit: {
        sha: result.commitSha,
        message,
        author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME },
        committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME },
      },
      content: null,
    });
  }
  return err(405, 'Method Not Allowed');
}

function handleLabels(store: Store, ctx: RestCtx, repo: Repo): RestResp {
  if (ctx.method !== 'POST') return err(405, 'Method Not Allowed');
  const input = bodyRecord(ctx);
  const name = str(input.name);
  if (name === '') return err(422, 'name is required');
  if (repo.labels.has(name)) return err(422, `Label "${name}" already exists`);
  const label: Label = {
    name,
    color: typeof input.color === 'string' && input.color !== '' ? input.color : 'ededed',
    description: str(input.description),
  };
  repo.labels.set(name, label);
  return json(201, labelJson(label));
}

function handleIssues(store: Store, ctx: RestCtx, repo: Repo, rest: string[]): RestResp {
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') === 'asc' ? 'asc' : 'desc';
      const issues = store.listIssues(repo, state, direction);
      const { page, link } = pageOf(ctx, issues, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return buf(200, arrayOfBuffers(page.map((issue) => issueJson(ctx, repo, issue))), headers);
    }
    if (ctx.method === 'POST') {
      const input = bodyRecord(ctx);
      const title = str(input.title);
      if (title === '') return err(422, 'title is required');
      const labels = Array.isArray(input.labels) ? input.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      const created = store.createIssue(repo, title, str(input.body), labels);
      if ('error' in created) return err(422, created.error);
      return buf(201, issueJson(ctx, repo, created.issue));
    }
    return err(405, 'Method Not Allowed');
  }
  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  if (rest.length === 1) {
    if (ctx.method === 'GET') return buf(200, issueJson(ctx, repo, issue));
    if (ctx.method === 'PATCH') {
      const input = bodyRecord(ctx);
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
      issue.json = null;
      return buf(200, issueJson(ctx, repo, issue));
    }
    return err(405, 'Method Not Allowed');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (ctx.method === 'GET') {
      return json(200, issue.comments.map((comment) => commentJson(ctx, repo, issue, comment)));
    }
    if (ctx.method === 'POST') {
      const input = bodyRecord(ctx);
      const body = str(input.body);
      if (body === '') return err(422, 'body is required');
      const comment = store.addComment(repo, issue, body);
      return json(201, commentJson(ctx, repo, issue, comment));
    }
    return err(405, 'Method Not Allowed');
  }
  return notFound();
}

function handlePulls(store: Store, ctx: RestCtx, repo: Repo, rest: string[]): RestResp {
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const all = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
      const filtered = state === 'all' ? all : all.filter((pull) => pull.state === state);
      const { page, link } = pageOf(ctx, filtered, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return buf(200, arrayOfBuffers(page.map((pull) => pullJson(ctx, repo, pull))), headers);
    }
    if (ctx.method === 'POST') {
      const input = bodyRecord(ctx);
      const title = str(input.title);
      const head = str(input.head);
      const base = str(input.base);
      if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
      const created = store.createPull(repo, title, str(input.body), head, base);
      if ('error' in created) return err(422, created.error);
      return buf(201, pullJson(ctx, repo, created.pull));
    }
    return err(405, 'Method Not Allowed');
  }
  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();
  if (rest.length === 1) {
    if (ctx.method === 'GET') return buf(200, pullJson(ctx, repo, pull));
    return err(405, 'Method Not Allowed');
  }
  if (rest.length === 2 && rest[1] === 'files') {
    if (ctx.method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, store.pullFiles(repo, pull));
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (ctx.method !== 'PUT') return err(405, 'Method Not Allowed');
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) {
      if (merged.error === 'conflict') return err(405, 'Merge conflict');
      return err(405, 'Pull request is already merged or closed');
    }
    return json(200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
  }
  return notFound();
}
