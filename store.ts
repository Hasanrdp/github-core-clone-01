// The forge's in-memory state: repositories, git objects, refs, issues and
// pull requests, plus the git object model they are built from.
//
// Everything the forge stores is deterministic: entry-created commits carry
// one fixed timestamp, and issue/PR timestamps are one fixed ISO string, so
// the same requests always build the same state.

import { createHash } from 'node:crypto';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** The one timestamp every commit this forge creates carries (never a clock). */
export const FIXED_EPOCH = 1700000000;
/** The one timestamp every issue, comment and pull request carries. */
export const FIXED_ISO = '2025-01-01T00:00:00Z';
/** The identity on commits the forge itself writes. */
export const FORGE_IDENTITY = 'ada iversen <adaiversen@example.invalid>';
/** The viewer the trial token belongs to (the seeded scenario's viewer). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export const ZERO_OID = '0'.repeat(40);

const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** SHA-1 over `<type> <size>\0` + bytes, exactly as git computes an object id. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order, a directory compared as if its name ended in '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export interface CommitInput {
  tree: string;
  parents: string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}

export function buildCommit(input: CommitInput): Buffer {
  const stamp = input.timestamp ?? FIXED_EPOCH;
  const who = `${input.author ?? FORGE_IDENTITY} ${stamp} +0000`;
  const committer = `${input.committer ?? FORGE_IDENTITY} ${stamp} +0000`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

/** A commit's message as the REST surface shows it: one trailing newline off. */
export function displayMessage(message: string): string {
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

/** Peel a tag object to its target commit (following tag-to-tag chains). */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Every object reachable from `roots`: commit -> tree + parents, tag -> target,
 * tree -> entries (gitlinks skipped). A `stopAt` commit is included with its
 * tree and blobs, but its parents are not followed (a shallow boundary).
 */
export function collectReachable(
  objects: Map<string, GitObject>,
  roots: Iterable<string>,
  stopAt?: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (stopAt === undefined || !stopAt.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` through parent links. */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The nearest common ancestor of two commits, walking both histories. */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const seen = new Set<string>();
  const queueB = [b];
  while (queueB.length > 0) {
    const oid = queueB.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

/** Flatten a tree into path -> {oid, mode}, recursing into directories. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (treeOid !== null) walk(treeOid, '');
  return out;
}

export interface FileChange {
  path: string;
  oldOid: string | null;
  newOid: string | null;
  oldMode: string | null;
  newMode: string | null;
}

/** The file-level difference between two trees (null tree = empty). */
export function diffTrees(
  objects: Map<string, GitObject>,
  oldTree: string | null,
  newTree: string | null,
): FileChange[] {
  const oldFiles = flattenTree(objects, oldTree);
  const newFiles = flattenTree(objects, newTree);
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldFiles.get(path);
    const newEntry = newFiles.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    changes.push({
      path,
      oldOid: oldEntry?.oid ?? null,
      newOid: newEntry?.oid ?? null,
      oldMode: oldEntry?.mode ?? null,
      newMode: newEntry?.mode ?? null,
    });
  }
  return changes;
}

/**
 * Return a new tree oid with `path` set to `blobOid` (or removed when null),
 * building the intermediate directories. `treeOid` null means an empty tree.
 */
export function setPathInTree(
  objects: Map<string, GitObject>,
  treeOid: string | null,
  segments: string[],
  blobOid: string | null,
): string {
  if (segments.length === 0) throw new Error('a path needs at least one segment');
  const put = (oid: string | null, depth: number): string => {
    const entries = new Map<string, TreeEntry>();
    if (oid !== null) {
      const object = objects.get(oid);
      if (object !== undefined && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const name = segments[depth] as string;
    if (depth === segments.length - 1) {
      if (blobOid === null) entries.delete(name);
      else entries.set(name, { mode: '100644', name, oid: blobOid });
    } else {
      const child = entries.get(name);
      const childTree = child !== undefined && child.mode === '40000' ? child.oid : null;
      const rebuilt = put(childTree, depth + 1);
      const rebuiltObject = objects.get(rebuilt);
      const empty = rebuiltObject !== undefined && rebuiltObject.data.length === 0;
      if (empty) entries.delete(name);
      else entries.set(name, { mode: '40000', name, oid: rebuilt });
    }
    const data = buildTree([...entries.values()]);
    const newOid = hashObject('tree', data);
    if (!objects.has(newOid)) objects.set(newOid, { type: 'tree', data });
    return newOid;
  };
  return put(treeOid, 0);
}

/** Look a path up in a tree: its blob oid and mode, or null. */
export function getPathInTree(
  objects: Map<string, GitObject>,
  treeOid: string | null,
  segments: string[],
): { oid: string; mode: string } | null {
  let current = treeOid;
  for (let depth = 0; depth < segments.length; depth += 1) {
    if (current === null) return null;
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[depth]);
    if (entry === undefined) return null;
    if (depth === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The direct children of a directory inside a tree (null when the path is not a tree). */
export function listTreeDir(
  objects: Map<string, GitObject>,
  treeOid: string | null,
  segments: string[],
): TreeEntry[] | null {
  let current = treeOid;
  for (const segment of segments) {
    if (current === null) return null;
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  if (current === null) return [];
  const object = objects.get(current);
  if (object === undefined || object.type !== 'tree') return null;
  return parseTree(object.data);
}

// ---------------------------------------------------------------- the store

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: Comment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  issueSeq: number;
  labels: Map<string, { name: string; color: string }>;
  prs: Map<number, PullRequest>;
  prSeq: number;
  commentSeq: number;
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private repoIdSeq = 5000;
  private issueIdSeq = 100000;
  private prIdSeq = 300000;
  private commentIdSeq = 200000;
  private seq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo: Repo = {
      id: this.repoIdSeq,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      seq: this.seq,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      issueSeq: 0,
      labels: new Map(),
      prs: new Map(),
      prSeq: 0,
      commentSeq: 0,
    };
    this.repoIdSeq += 1;
    this.seq += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** A repository by its numeric id, for Relay global ids. */
  repoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.seq - b.seq);
  }

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** Resolve a branch name, full ref or oid to a commit oid (or null). */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    if (isOid(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  /** The commits reachable from `tip`, newest first (tip, then parents). */
  listCommits(repo: Repo, tip: string | null): string[] {
    if (tip === null) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  /** Write a file on `branch` (creating the branch from the default tip when needed). */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; contentSha: string } {
    let tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
      if (tip === null && repo.refs.size > 0) tip = [...repo.refs.values()][0] ?? null;
    }
    const blobSha = this.putObject(repo, 'blob', content);
    let baseTree: string | null = null;
    const parents: string[] = [];
    if (tip !== null) {
      const tipObject = repo.objects.get(tip);
      if (tipObject !== undefined && tipObject.type === 'commit') {
        baseTree = parseCommit(tipObject.data).tree;
        parents.push(tip);
      } else if (tipObject !== undefined && tipObject.type === 'tag') {
        const peeled = peelToCommit(repo.objects, tip);
        if (peeled !== null) {
          const commitObject = repo.objects.get(peeled);
          if (commitObject !== undefined) baseTree = parseCommit(commitObject.data).tree;
          parents.push(peeled);
        }
      }
    }
    const treeOid = setPathInTree(repo.objects, baseTree, path.split('/'), blobSha);
    const commitData = buildCommit({ tree: treeOid, parents, message });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, contentSha: blobSha };
  }

  /** Remove a file on `branch`, committing the removal. Returns the commit sha or null. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return null;
    const tipObject = repo.objects.get(tip);
    if (tipObject === undefined || tipObject.type !== 'commit') return null;
    const commit = parseCommit(tipObject.data);
    const existing = getPathInTree(repo.objects, commit.tree, path.split('/'));
    if (existing === null) return null;
    const treeOid = setPathInTree(repo.objects, commit.tree, path.split('/'), null);
    const commitData = buildCommit({ tree: treeOid, parents: [tip], message });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return commitSha;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[] = []): Issue {
    repo.issueSeq += 1;
    const issue: Issue = {
      id: this.issueIdSeq,
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      seq: this.seq,
      comments: [],
    };
    this.issueIdSeq += 1;
    this.seq += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    repo.commentSeq += 1;
    const comment: Comment = { id: this.commentIdSeq, body, seq: this.seq };
    this.commentIdSeq += 1;
    this.seq += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | null {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return null;
    for (const existing of repo.prs.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) return null;
    }
    repo.prSeq += 1;
    const pr: PullRequest = {
      id: this.prIdSeq,
      number: repo.prSeq,
      title,
      body,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      seq: this.seq,
    };
    this.prIdSeq += 1;
    this.seq += 1;
    repo.prs.set(pr.number, pr);
    return pr;
  }

  /** The files a pull request changes, merge-base to head tip. */
  pullFiles(repo: Repo, pr: PullRequest): FileChange[] {
    const base = mergeBase(repo.objects, pr.headSha, pr.baseSha);
    const baseTree = base === null ? null : headTreeOf(repo, base);
    const headTree = headTreeOf(repo, pr.headSha);
    return diffTrees(repo.objects, baseTree, headTree);
  }

  /** Whether merging `pr` would conflict: a path changed on both sides of the merge base. */
  pullConflict(repo: Repo, pr: PullRequest): boolean {
    // The base side is the base branch as it stands now, not the tip the
    // pull request recorded at creation: after another pull request merges,
    // the base has moved and the same path may now differ on both sides.
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (baseTip === undefined) return false;
    const base = mergeBase(repo.objects, pr.headSha, baseTip);
    if (base === null) return false;
    const baseTree = headTreeOf(repo, base);
    const headChanges = diffTrees(repo.objects, baseTree, headTreeOf(repo, pr.headSha));
    const baseChanges = diffTrees(repo.objects, baseTree, headTreeOf(repo, baseTip));
    const baseChanged = new Map<string, string | null>();
    for (const change of baseChanges) baseChanged.set(change.path, change.newOid);
    for (const change of headChanges) {
      if (!baseChanged.has(change.path)) continue;
      if (baseChanged.get(change.path) !== change.newOid) return true;
    }
    return false;
  }

  /** Squash-merge `pr` onto its base branch. Returns the merge commit sha, or null on conflict. */
  mergePull(repo: Repo, pr: PullRequest): string | null {
    if (pr.state !== 'open' || pr.merged) return null;
    if (this.pullConflict(repo, pr)) return null;
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (baseTip === undefined) return null;
    const baseObject = repo.objects.get(baseTip);
    if (baseObject === undefined || baseObject.type !== 'commit') return null;
    const baseTree = parseCommit(baseObject.data).tree;
    const headTree = headTreeOf(repo, pr.headSha);
    const changes = diffTrees(repo.objects, baseTree, headTree);
    let treeOid: string | null = baseTree;
    for (const change of changes) {
      treeOid = setPathInTree(repo.objects, treeOid, change.path.split('/'), change.newOid);
    }
    const message = `Merge pull request #${pr.number} from ${pr.headRef}`;
    const commitData = buildCommit({ tree: treeOid as string, parents: [baseTip], message });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_ISO;
    pr.mergeSha = mergeSha;
    return mergeSha;
  }
}

/** The tree oid of a commit (following a tag), or null. */
export function headTreeOf(repo: Repo, oid: string): string | null {
  const peeled = peelToCommit(repo.objects, oid);
  if (peeled === null) return null;
  const object = repo.objects.get(peeled);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Count the lines of a text blob (a trailing newline does not add a line). */
export function lineCount(content: Buffer): number {
  if (content.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 0x0a) lines += 1;
  }
  if (content[content.length - 1] !== 0x0a) lines += 1;
  return lines;
}
