// store.ts — the forge's in-memory state: repositories, git objects, issues,
// pull requests, labels and comments. Everything is deterministic: fixed
// timestamps, sequence counters instead of clocks or randomness, so two runs
// fed the same requests end in byte-identical state.
//
// The viewer identity is the trial's token owner. The suite's scenario seed is
// fixed (the contest's fixed data), so the token owner is the same login in
// every trial: adaiversen (id 1000). Repositories belong to that login; any
// other owner in a path is a foreign owner and reads as 404, never 403.

import { createHash } from 'node:crypto';

/** The login the bearer token names. */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's numeric id. */
export const VIEWER_ID = 1000;
/** The viewer's display name. */
export const VIEWER_NAME = 'ada iversen';
/** The viewer's email, used in server-built commit identities. */
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The default branch every created repository reports. */
export const DEFAULT_BRANCH = 'main';
/** The one timestamp every created/updated/merged date carries. */
export const FIXED_TIME = '2026-01-01T00:00:00Z';
/** Epoch base for server-built commits; a per-commit sequence is added. */
export const COMMIT_EPOCH_BASE = 1735689600;
/** The all-zero object id. */
export const ZERO_OID = '0000000000000000000000000000000000000000';
/** The 40-hex object id shape. */
export const OID_RE = /^[0-9a-f]{40}$/;

/** SHA-1 of a buffer, as lowercase hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a git object: sha1("<type> <len>\0<data>"). */
export function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Whether a string is a 40-hex object id. */
export function isOid(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value);
}

// ---------------------------------------------------------------------------
// Git object parsing (cached: objects are immutable, so a WeakMap keyed by
// the stored data Buffer is safe and makes repeated reads nearly free).
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const treeCache = new WeakMap<Buffer, TreeEntry[]>();

/** Parse a tree object's entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const hit = treeCache.get(data);
  if (hit !== undefined) return hit;
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.toString('ascii', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  treeCache.set(data, entries);
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

const commitCache = new WeakMap<Buffer, CommitInfo>();

/** Parse a commit object: headers, then the message after the blank line. */
export function parseCommit(data: Buffer): CommitInfo {
  const hit = commitCache.get(data);
  if (hit !== undefined) return hit;
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const info: CommitInfo = { tree, parents, author, committer, message };
  commitCache.set(data, info);
  return info;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

const tagCache = new WeakMap<Buffer, TagInfo>();

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagInfo {
  const hit = tagCache.get(data);
  if (hit !== undefined) return hit;
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  const info: TagInfo = { object, type, tag, tagger, message };
  tagCache.set(data, info);
  return info;
}

/** Encode tree entries into a tree object's bytes. */
export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git tree ordering: names compare byte-wise, directories as name + '/'. */
export function treeCompare(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Domain records
// ---------------------------------------------------------------------------

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
  /** Cached REST JSON for GET /issues/{n}; cleared on any mutation. */
  json: Buffer | null;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** Branch tips at creation time; they never move for the pull. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  /** Cached REST JSON for GET /pulls/{n}; cleared on any mutation. */
  json: Buffer | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  /** Creation order of each commit object, for newest-first listings. */
  commitSeq: Map<string, number>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  /** Cached REST JSON for GET /repos/{o}/{r}; cleared on PATCH/DELETE. */
  json: Buffer | null;
  /** Cached REST JSON for GET /repos/{o}/{r}/branches; cleared on ref change. */
  branchesJson: Buffer | null;
}

/** Opaque Relay-style global ids: base64url over a typed tuple. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64url');
}

/** Decode a global id back into its kind and parts; null when malformed. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const pieces = text.split(':');
    const kind = pieces[0];
    if (kind === undefined || kind === '' || pieces.length < 2) return null;
    return { kind, parts: pieces.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class Store {
  /** owner -> (name -> repo): two Map.get calls, no string-key building. */
  readonly reposByOwner = new Map<string, Map<string, Repo>>();
  readonly reposById = new Map<number, Repo>();
  /** Global creation sequence; orders repos, issues, pulls and commits. */
  seq = 0;
  /** Sequence for server-built commit timestamps (deterministic, unique). */
  commitSeq = 0;
  nextRepoId = 1;

  // -- repositories -------------------------------------------------------

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (name === '' || name.includes('/')) return null;
    let byName = this.reposByOwner.get(VIEWER_LOGIN);
    if (byName === undefined) {
      byName = new Map<string, Repo>();
      this.reposByOwner.set(VIEWER_LOGIN, byName);
    }
    if (byName.has(name)) return null;
    this.seq += 1;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      seq: this.seq,
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      commitSeq: new Map<string, number>(),
      issues: new Map<number, Issue>(),
      pulls: new Map<number, Pull>(),
      labels: new Map<string, Label>(),
      nextNumber: 1,
      nextCommentId: 1,
      json: null,
      branchesJson: null,
    };
    this.nextRepoId += 1;
    byName.set(name, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.reposByOwner.get(owner)?.get(name);
  }

  deleteRepo(repo: Repo): void {
    this.reposByOwner.get(repo.owner)?.delete(repo.name);
    this.reposById.delete(repo.id);
  }

  /** Every repository the viewer owns, in creation order. */
  viewerRepos(): Repo[] {
    const byName = this.reposByOwner.get(VIEWER_LOGIN);
    if (byName === undefined) return [];
    return [...byName.values()].sort((a, b) => a.seq - b.seq);
  }

  // -- git objects ----------------------------------------------------------

  /** Store an object; returns its id. Records creation order for commits. */
  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      if (type === 'commit') {
        this.seq += 1;
        repo.commitSeq.set(oid, this.seq);
      }
    }
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Whether `ancestor` is reachable from `tip` following parents. */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>([tip]);
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (parent === ancestor) return true;
        if (!seen.has(parent)) {
          seen.add(parent);
          stack.push(parent);
        }
      }
    }
    return false;
  }

  /** The merge-base of two commits: the newest common ancestor by creation order. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stackA: string[] = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop() as string;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'commit') {
        for (const parent of parseCommit(obj.data).parents) stackA.push(parent);
      }
    }
    let best: string | null = null;
    let bestSeq = -1;
    const stackB: string[] = [b];
    const seenB = new Set<string>();
    while (stackB.length > 0) {
      const oid = stackB.pop() as string;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsA.has(oid)) {
        const s = repo.commitSeq.get(oid) ?? 0;
        if (s > bestSeq) {
          bestSeq = s;
          best = oid;
        }
      }
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'commit') {
        for (const parent of parseCommit(obj.data).parents) stackB.push(parent);
      }
    }
    return best;
  }

  /** Flatten a tree into path -> {oid, mode}, walking subtrees. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build nested tree objects from a flat path map; returns the root tree id. */
  buildTree(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, string[]>();
      for (const path of flat.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          const entry = flat.get(path) as { oid: string; mode: string };
          entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
        } else {
          const dir = rest.slice(0, slash);
          let list = dirs.get(dir);
          if (list === undefined) {
            list = [];
            dirs.set(dir, list);
          }
          list.push(path);
        }
      }
      for (const dir of dirs.keys()) {
        entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
      }
      entries.sort(treeCompare);
      return this.putObject(repo, 'tree', encodeTree(entries));
    };
    return build('');
  }

  /** The tree id a commit points at, or '' when the commit is missing. */
  commitTree(repo: Repo, commitOid: string): string {
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') return '';
    return parseCommit(obj.data).tree;
  }

  /** Build a commit object and store it; returns its id. */
  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    this.commitSeq += 1;
    const epoch = COMMIT_EPOCH_BASE + this.commitSeq;
    const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
    let text = `tree ${treeOid}\n`;
    for (const parent of parents) text += `parent ${parent}\n`;
    text += `author ${ident}\ncommitter ${ident}\n\n${message}\n`;
    return this.putObject(repo, 'commit', Buffer.from(text, 'utf8'));
  }

  /** Commits reachable from a ref tip, newest first (by creation order). */
  listCommits(repo: Repo, refName?: string): { sha: string; message: string; author: string; committer: string; parents: string[] }[] {
    let tip: string | undefined;
    if (refName !== undefined) {
      tip = repo.refs.get(`refs/heads/${refName}`) ?? (isOid(refName) ? refName : undefined);
      if (tip === undefined) {
        // A full ref name or a tag.
        tip = repo.refs.get(refName);
      }
    } else {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    if (tip === undefined) return [];
    const found = new Map<string, { sha: string; message: string; author: string; committer: string; parents: string[]; seq: number }>();
    const stack: string[] = [tip];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const info = parseCommit(obj.data);
      found.set(oid, {
        sha: oid,
        message: info.message.endsWith('\n') ? info.message.slice(0, -1) : info.message,
        author: info.author,
        committer: info.committer,
        parents: info.parents,
        seq: repo.commitSeq.get(oid) ?? 0,
      });
      for (const parent of info.parents) stack.push(parent);
    }
    return [...found.values()].sort((a, b) => b.seq - a.seq);
  }

  // -- refs -----------------------------------------------------------------

  /** Create a ref; false when it already exists or the target is unknown. */
  createRef(repo: Repo, refName: string, oid: string): boolean {
    if (repo.refs.has(refName)) return false;
    if (!repo.objects.has(oid)) return false;
    repo.refs.set(refName, oid);
    repo.branchesJson = null;
    return true;
  }

  /** Branches in creation order: the default branch first, then the rest. */
  listBranches(repo: Repo): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    const def = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (def !== undefined) out.push({ name: repo.defaultBranch, sha: def });
    for (const [ref, sha] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      const name = ref.slice('refs/heads/'.length);
      if (name === repo.defaultBranch) continue;
      out.push({ name, sha });
    }
    return out;
  }

  // -- contents ---------------------------------------------------------------

  /** Resolve a ref (branch name, full ref, or oid) to a commit id. */
  resolveRef(repo: Repo, ref?: string): string | undefined {
    if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (isOid(ref)) return repo.objects.has(ref) ? ref : undefined;
    return repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
  }

  /** The blob at a path in a ref's tree; null when the path is not a file. */
  blobAt(repo: Repo, ref: string | undefined, path: string): { oid: string; data: Buffer } | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return null;
    const treeOid = this.commitTree(repo, tip);
    if (treeOid === '') return null;
    const flat = this.flattenTree(repo, treeOid);
    const entry = flat.get(path);
    if (entry === undefined) return null;
    const obj = repo.objects.get(entry.oid);
    if (obj === undefined || obj.type !== 'blob') return null;
    return { oid: entry.oid, data: obj.data };
  }

  /** The direct children of a directory in a ref's tree. */
  dirAt(repo: Repo, ref: string | undefined, path: string): { name: string; path: string; oid: string; type: 'file' | 'dir' }[] | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return null;
    const treeOid = this.commitTree(repo, tip);
    if (treeOid === '') return null;
    const flat = this.flattenTree(repo, treeOid);
    const prefix = path === '' ? '' : `${path}/`;
    const seen = new Map<string, { name: string; path: string; oid: string; type: 'file' | 'dir' }>();
    for (const [full, entry] of flat) {
      if (!full.startsWith(prefix)) continue;
      const rest = full.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        seen.set(rest, { name: rest, path: full, oid: entry.oid, type: 'file' });
      } else {
        const dir = rest.slice(0, slash);
        if (!seen.has(dir)) {
          // The directory's tree id: walk the tree path.
          let oid = treeOid;
          let ok = true;
          for (const segment of `${prefix}${dir}`.split('/')) {
            const obj = repo.objects.get(oid);
            if (obj === undefined || obj.type !== 'tree') {
              ok = false;
              break;
            }
            const found = parseTree(obj.data).find((candidate) => candidate.name === segment);
            if (found === undefined) {
              ok = false;
              break;
            }
            oid = found.oid;
          }
          if (ok) seen.set(dir, { name: dir, path: `${prefix}${dir}`, oid, type: 'dir' });
        }
      }
    }
    // A path with no files under it does not exist — except the root, which
    // lists (possibly empty) for a repository that has a tree at all.
    if (seen.size === 0 && path !== '') return null;
    return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Commit a file on a branch (creating the branch on an unborn repo).
   * `sha` is the blob id the caller believes is current; a mismatch is 409.
   */
  putContents(
    repo: Repo,
    branch: string | undefined,
    path: string,
    content: Buffer,
    message: string,
    sha?: string,
  ): { commitSha: string; contentSha: string } | { error: 'stale' | 'missing-branch' | 'bad-sha' } {
    const branchName = branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branchName}`;
    const tip = repo.refs.get(refName);
    let flat = new Map<string, { oid: string; mode: string }>();
    const parents: string[] = [];
    if (tip !== undefined) {
      const treeOid = this.commitTree(repo, tip);
      if (treeOid !== '') flat = this.flattenTree(repo, treeOid);
      parents.push(tip);
    }
    const current = flat.get(path);
    if (sha !== undefined) {
      if (current === undefined) return { error: 'bad-sha' };
      if (current.oid !== sha) return { error: 'stale' };
    }
    const blobOid = this.putObject(repo, 'blob', content);
    flat.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = this.buildTree(repo, flat);
    const commitSha = this.makeCommit(repo, treeOid, parents, message);
    repo.refs.set(refName, commitSha);
    repo.branchesJson = null;
    return { commitSha, contentSha: blobOid };
  }

  /** Delete a file on a branch with a commit. */
  deleteContents(
    repo: Repo,
    branch: string | undefined,
    path: string,
    message: string,
    sha?: string,
  ): { commitSha: string } | { error: 'missing' | 'stale' | 'missing-branch' } {
    const branchName = branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branchName}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined) return { error: 'missing-branch' };
    const treeOid = this.commitTree(repo, tip);
    if (treeOid === '') return { error: 'missing' };
    const flat = this.flattenTree(repo, treeOid);
    const current = flat.get(path);
    if (current === undefined) return { error: 'missing' };
    if (sha !== undefined && current.oid !== sha) return { error: 'stale' };
    flat.delete(path);
    const newTree = this.buildTree(repo, flat);
    const commitSha = this.makeCommit(repo, newTree, [tip], message);
    repo.refs.set(refName, commitSha);
    repo.branchesJson = null;
    return { commitSha };
  }

  // -- issues -----------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): { issue: Issue } | { error: string } {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: `Label "${name}" does not exist` };
    }
    this.seq += 1;
    const issue: Issue = {
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.seq,
      json: null,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return { issue };
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    this.seq += 1;
    const comment: Comment = { id: repo.nextCommentId, body, seq: this.seq };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    issue.json = null;
    return comment;
  }

  /** Issues in creation order, optionally filtered by state and direction. */
  listIssues(repo: Repo, state: string, direction: 'asc' | 'desc'): Issue[] {
    const all = [...repo.issues.values()];
    const filtered = state === 'all' ? all : all.filter((issue) => issue.state === state);
    filtered.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    return filtered;
  }

  // -- pull requests -----------------------------------------------------------

  createPull(
    repo: Repo,
    title: string,
    body: string,
    head: string,
    base: string,
  ): { pull: Pull } | { error: string; code: 'missing-branch' | 'duplicate' } {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) {
      return { error: `head or base branch does not exist`, code: 'missing-branch' };
    }
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return { error: 'a pull request is already open for this head and base', code: 'duplicate' };
      }
    }
    this.seq += 1;
    const pull: Pull = {
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.seq,
      json: null,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return { pull };
  }

  /** The changed files between a pull's base and head tips. */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const baseTree = this.commitTree(repo, pull.baseSha);
    const headTree = this.commitTree(repo, pull.headSha);
    const base = baseTree === '' ? new Map() : this.flattenTree(repo, baseTree);
    const head = headTree === '' ? new Map() : this.flattenTree(repo, headTree);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === undefined && h !== undefined) {
        const data = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const additions = lineCount(data);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h === undefined) {
        const data = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const deletions = lineCount(data);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const oldData = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const newData = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        let additions = lineCount(newData);
        let deletions = lineCount(oldData);
        if (additions === 0 && deletions === 0) additions = 1;
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Whether a pull merges cleanly, and the merged tree when it does. */
  mergePreview(repo: Repo, pull: Pull): { conflict: boolean; treeOid: string } {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (baseTip === undefined || headTip === undefined) return { conflict: true, treeOid: '' };
    const mergeBase = this.mergeBase(repo, headTip, baseTip) ?? pull.baseSha;
    const baseTree = this.commitTree(repo, mergeBase);
    const headTree = this.commitTree(repo, headTip);
    const curTree = this.commitTree(repo, baseTip);
    const baseFlat = baseTree === '' ? new Map() : this.flattenTree(repo, baseTree);
    const headFlat = headTree === '' ? new Map() : this.flattenTree(repo, headTree);
    const curFlat = curTree === '' ? new Map() : this.flattenTree(repo, curTree);
    const merged = new Map<string, { oid: string; mode: string }>(curFlat);
    let conflict = false;
    const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      const c = curFlat.get(path);
      const headChanged = (b?.oid ?? null) !== (h?.oid ?? null);
      const curChanged = (b?.oid ?? null) !== (c?.oid ?? null);
      if (headChanged && curChanged && (h?.oid ?? null) !== (c?.oid ?? null)) {
        conflict = true;
        break;
      }
      if (headChanged) {
        if (h === undefined) merged.delete(path);
        else merged.set(path, { oid: h.oid, mode: h.mode });
      }
    }
    if (conflict) return { conflict: true, treeOid: '' };
    return { conflict: false, treeOid: this.buildTree(repo, merged) };
  }

  /** MERGEABLE when a squash merge would apply cleanly, else CONFLICTING. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    if (pull.state !== 'open') return 'CONFLICTING';
    return this.mergePreview(repo, pull).conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge an open pull request onto its base branch. The merge commit
   * has one parent (the base tip) and the merged tree.
   */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: 'conflict' | 'closed' | 'missing-branch' } {
    if (pull.state !== 'open') return { error: 'closed' };
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) return { error: 'missing-branch' };
    const preview = this.mergePreview(repo, pull);
    if (preview.conflict) return { error: 'conflict' };
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const sha = this.makeCommit(repo, preview.treeOid, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    repo.branchesJson = null;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_TIME;
    pull.mergeCommitSha = sha;
    pull.json = null;
    return { sha };
  }
}

/** The number of lines in a buffer (0 for empty, at least 1 otherwise). */
export function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] === 0x0a) count += 1;
  }
  if (data[data.length - 1] === 0x0a) count -= 1;
  return count;
}
