// graphql.ts — a small GraphQL executor for the documents gh and
// github-mcp-server actually send (see the kit's checks-graphql.ts header).
//
// Supported: queries and mutations, variables, inline input objects and
// enum lists, null variables, operation names, inline fragments
// (`... on Repository`), aliases, `__type` introspection, and operation
// batching (a JSON array of documents answers an array of results).
//
// Unknown fields answer HTTP 200 with an `errors` array naming the field;
// an unknown repository reads `data.repository = null` with no errors;
// a missing token is a 401 (checked in app.ts before this runs).

import {
  FIXED_TIME,
  VIEWER_LOGIN,
  globalId,
  parseGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let out = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1] as string;
          i += 2;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(i, i + 4), 16));
            i += 4;
          } else out += esc;
        } else {
          out += source[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let num = '';
      if (ch === '-') {
        num += '-';
        i += 1;
      }
      while (i < source.length && /[0-9.]/.test(source[i] as string)) {
        num += source[i] as string;
        i += 1;
      }
      tokens.push({ kind: 'int', value: Number.parseInt(num, 10) });
      continue;
    }
    if (isNameStart(ch)) {
      let name = '';
      while (i < source.length && isNameChar(source[i] as string)) {
        name += source[i] as string;
        i += 1;
      }
      tokens.push({ kind: 'name', value: name });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in query`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser: documents -> operations with selections
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'lit'; value: string | number | boolean | null }
  | { kind: 'enum'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selections: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  type: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: Map<string, ValueNode | null>;
  selections: SelectionNode[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of query');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, got ${token.kind}:${token.value}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind}:${token.value}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') {
        name = this.next().value as string;
      }
    }
    const varDefs = new Map<string, ValueNode | null>();
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.skipType();
        let def: ValueNode | null = null;
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          def = this.parseValue();
        }
        varDefs.set(varName, def);
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, varDefs, selections };
  }

  /** Skip a type expression: Name, [Name], Name!, [Name!]! and friends. */
  private skipType(): void {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      this.skipType();
      this.expectPunct(']');
    } else if (token.kind !== 'name') {
      throw new Error(`expected a type, got ${token.kind}:${token.value}`);
    }
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const type = this.expectName();
        return { kind: 'fragment', type, selections: this.parseSelectionSet() };
      }
      throw new Error('named fragments are not supported');
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    // Directives (@include/@skip) are parsed and ignored: the suite sends none.
    while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const tok = this.next();
          if (tok.kind === 'punct' && tok.value === '(') depth += 1;
          if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
        }
      }
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'var', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.set(fieldName, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'lit', value: token.value };
    if (token.kind === 'int') return { kind: 'lit', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'lit', value: true };
      if (token.value === 'false') return { kind: 'lit', value: false };
      if (token.value === 'null') return { kind: 'lit', value: null };
      return { kind: 'enum', name: token.value };
    }
    throw new Error(`unexpected value token ${token.kind}:${token.value}`);
  }
}

// ---------------------------------------------------------------------------
// Values and the schema surface for __type
// ---------------------------------------------------------------------------

type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlObject
  | GqlValue[];

interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergedAt', 'mergeCommitSha', 'files', 'headRefOid', 'baseRefOid', 'url', 'createdAt', 'updatedAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Ref: ['id', 'name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  SearchType: [],
};

const TYPE_ENUMS: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

/** The fields each mutation payload (and edge) object carries. */
const PAYLOAD_FIELDS: Record<string, readonly string[]> = {
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node', 'cursor'],
  Edge: ['node'],
  Comment: ['id', 'body'],
};

function typeInfo(name: string): GqlObject | null {
  if (name in TYPE_FIELDS || name in TYPE_ENUMS) {
    return {
      __type: '__Type',
      name,
      kind: name in TYPE_ENUMS ? 'ENUM' : 'OBJECT',
      fields: (TYPE_FIELDS[name] ?? []).map((field) => ({ __type: '__Field', name: field })),
      enumValues: (TYPE_ENUMS[name] ?? []).map((value) => ({ __type: '__EnumValue', name: value })),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

export interface GraphQLCtx {
  store: Store;
  /** The parsed JSON body: one operation or an array of them. */
  body: unknown;
}

interface ExecState {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name] ?? null;
    case 'lit':
      return node.value;
    case 'enum':
      return node.name;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = evalValue(value, variables);
  return out;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObject(store: Store, repo: Repo, issue: Issue): GqlObject {
  void store;
  return {
    __type: 'Issue',
    id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issueState(issue),
    body: issue.body,
  };
}

function pullObject(store: Store, repo: Repo, pull: Pull): GqlObject {
  void store;
  return {
    __type: 'PullRequest',
    id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    state: pullState(pull),
    body: pull.body,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    mergeCommitSha: pull.mergeCommitSha,
  };
}

function repoObject(repo: Repo): GqlObject {
  return {
    __type: 'Repository',
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: repo.owner,
    description: repo.description,
    repo,
  };
}

function userObject(login: string): GqlObject {
  return { __type: 'User', login, name: login, email: `${login}@example.invalid` };
}

/** Encode a pagination cursor for an issue number in a direction. */
function issueCursor(number: number, direction: 'asc' | 'desc'): string {
  return Buffer.from(`issue:${number}:${direction}`, 'utf8').toString('base64url');
}

/** Decode a pagination cursor; null when it is not one of ours. */
function parseIssueCursor(cursor: string): { number: number; direction: 'asc' | 'desc' } | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^issue:(\d+):(asc|desc)$/.exec(text);
    if (match === null) return null;
    return { number: Number.parseInt(match[1] as string, 10), direction: match[2] as 'asc' | 'desc' };
  } catch {
    return null;
  }
}

/** Resolve one field of a typed object; undefined when the field does not exist. */
function resolveField(state: ExecState, source: GqlObject, field: FieldNode): unknown {
  const type = source.__type;
  const args = argsOf(field, state.variables);
  const store = state.store;
  // Mutation payloads, edges and comments resolve their recorded fields.
  const payloadFields = PAYLOAD_FIELDS[type];
  if (payloadFields !== undefined) {
    return payloadFields.includes(field.name) ? source[field.name] : undefined;
  }
  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') return userObject(VIEWER_LOGIN);
      if (field.name === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoObject(repo);
      }
      if (field.name === 'node') {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repo = store.reposById.get(Number(parsed.parts[0]));
          return repo === undefined ? null : repoObject(repo);
        }
        if (parsed.kind === 'Issue') {
          const repo = store.reposById.get(Number(parsed.parts[0]));
          const issue = repo?.issues.get(Number(parsed.parts[1]));
          return issue === undefined || repo === undefined ? null : issueObject(store, repo, issue);
        }
        if (parsed.kind === 'PullRequest') {
          const repo = store.reposById.get(Number(parsed.parts[0]));
          const pull = repo?.pulls.get(Number(parsed.parts[1]));
          return pull === undefined || repo === undefined ? null : pullObject(store, repo, pull);
        }
        return null;
      }
      if (field.name === '__type') return typeInfo(String(args.name ?? ''));
      if (field.name === '__schema') return { __type: '__Schema', queryType: { __type: '__Type', name: 'Query' } };
      return undefined;
    }
    case 'Repository': {
      const repo = source.repo as Repo;
      switch (field.name) {
        case 'id':
          return source.id;
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userObject(repo.owner);
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : { __type: 'Ref', name: repo.defaultBranch };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'createdAt':
        case 'updatedAt':
          return FIXED_TIME;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}`;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueObject(store, repo, issue);
        }
        case 'issues': {
          const first = typeof args.first === 'number' ? args.first : 10;
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
          const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
          let issues = store.listIssues(repo, 'all', direction);
          if (states !== null) {
            const wanted = new Set(states.map((entry) => entry.toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const after = typeof args.after === 'string' ? parseIssueCursor(args.after) : null;
          if (after !== null) {
            issues = issues.filter((issue) =>
              after.direction === 'desc' ? issue.number < after.number : issue.number > after.number,
            );
          }
          const nodes = issues.slice(0, first);
          const hasNextPage = issues.length > first;
          const endCursor = nodes.length > 0 ? issueCursor(nodes[nodes.length - 1]?.number as number, direction) : null;
          return {
            __type: 'IssueConnection',
            nodes: nodes.map((issue) => issueObject(store, repo, issue)),
            pageInfo: {
              __type: 'PageInfo',
              hasNextPage,
              hasPreviousPage: after !== null,
              startCursor: nodes.length > 0 ? issueCursor(nodes[0]?.number as number, direction) : null,
              endCursor,
            },
            totalCount: issues.length,
          };
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : 10;
          const pulls = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq).filter((pull) => pull.state === 'open');
          const nodes = pulls.slice(0, first);
          return {
            __type: 'PullRequestConnection',
            nodes: nodes.map((pull) => pullObject(store, repo, pull)),
            pageInfo: { __type: 'PageInfo', hasNextPage: pulls.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: pulls.length,
          };
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullObject(store, repo, pull);
        }
        default:
          return undefined;
      }
    }
    case 'Issue': {
      switch (field.name) {
        case 'id':
        case 'number':
        case 'title':
        case 'state':
        case 'body':
          return source[field.name];
        default:
          return undefined;
      }
    }
    case 'PullRequest': {
      switch (field.name) {
        case 'id':
        case 'number':
        case 'title':
        case 'state':
        case 'body':
        case 'headRefName':
        case 'baseRefName':
        case 'merged':
        case 'mergedAt':
        case 'mergeCommitSha':
          return source[field.name];
        case 'mergeable': {
          const repoId = Number((parseGlobalId(String(source.id)).parts[0] ?? ''));
          const repo = store.reposById.get(repoId);
          const found = repo?.pulls.get(Number(source.number));
          if (repo === undefined || found === undefined) return 'UNKNOWN';
          return store.pullMergeable(repo, found);
        }
        case 'files': {
          const repoId = Number((parseGlobalId(String(source.id)).parts[0] ?? ''));
          const repo = store.reposById.get(repoId);
          const found = repo?.pulls.get(Number(source.number));
          if (repo === undefined || found === undefined) {
            return { __type: 'PullRequestChangedFileConnection', nodes: [], pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 };
          }
          const first = typeof args.first === 'number' ? args.first : 10;
          const files = store.pullFiles(repo, found).slice(0, first);
          return {
            __type: 'PullRequestChangedFileConnection',
            nodes: files.map((file) => ({ __type: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes })),
            pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: files.length,
          };
        }
        default:
          return undefined;
      }
    }
    case 'User': {
      switch (field.name) {
        case 'login':
        case 'name':
        case 'email':
          return source[field.name];
        default:
          return undefined;
      }
    }
    case 'Ref': {
      return field.name === 'name' ? source.name : undefined;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      switch (field.name) {
        case 'nodes':
        case 'pageInfo':
        case 'totalCount':
          return source[field.name];
        case 'edges':
          return ((source.nodes as unknown[]) ?? []).map((node) => ({ __type: 'Edge', node }));
        default:
          return undefined;
      }
    }
    case 'PullRequestChangedFile': {
      switch (field.name) {
        case 'path':
        case 'additions':
        case 'deletions':
        case 'changes':
          return source[field.name];
        default:
          return undefined;
      }
    }
    case 'PageInfo': {
      switch (field.name) {
        case 'hasNextPage':
        case 'hasPreviousPage':
        case 'startCursor':
        case 'endCursor':
          return source[field.name];
        default:
          return undefined;
      }
    }
    case '__Type': {
      switch (field.name) {
        case 'name':
        case 'kind':
          return source[field.name];
        case 'fields': {
          const fields = (source.fields ?? []) as { name: string }[];
          return fields.map((entry) => ({ __type: '__Field', name: entry.name }));
        }
        case 'enumValues': {
          const values = (source.enumValues ?? []) as { name: string }[];
          return values.map((entry) => ({ __type: '__EnumValue', name: entry.name }));
        }
        default:
          return undefined;
      }
    }
    case '__Field':
    case '__EnumValue': {
      return field.name === 'name' ? source.name : undefined;
    }
    case '__Schema': {
      return field.name === 'queryType' ? { __type: '__Type', name: 'Query' } : undefined;
    }
    case 'Mutation': {
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Resolve a selection set against a typed object value. */
function resolveSelections(state: ExecState, source: GqlObject, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.type === source.__type) {
        Object.assign(out, resolveSelections(state, source, selection.selections));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = source.__type;
      continue;
    }
    const value = resolveField(state, source, selection);
    if (value === undefined) {
      state.errors.push({ message: `Cannot query field "${selection.name}" on type "${source.__type}".` });
      out[key] = null;
      continue;
    }
    out[key] = resolveValue(state, value, selection.selections);
  }
  return out;
}

/** Apply a field's sub-selections to its resolved value. */
function resolveValue(state: ExecState, value: unknown, selections: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (selections === null) return value;
  if (Array.isArray(value)) return value.map((entry) => resolveValue(state, entry, selections));
  if (typeof value === 'object') {
    return resolveSelections(state, value as GqlObject, selections);
  }
  return value;
}

/** Execute the root fields of one operation (query or mutation). */
function executeOperation(state: ExecState, operation: Operation): Record<string, unknown> {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const out: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind === 'fragment') continue;
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = rootType;
      continue;
    }
    if (rootType === 'Mutation') {
      out[key] = executeMutation(state, selection);
      continue;
    }
    const source: GqlObject = { __type: 'Query' };
    const value = resolveField(state, source, selection);
    if (value === undefined) {
      state.errors.push({ message: `Cannot query field "${selection.name}" on type "Query".` });
      out[key] = null;
      continue;
    }
    out[key] = resolveValue(state, value, selection.selections);
  }
  return out;
}

/** Execute one mutation root field against the store. */
function executeMutation(state: ExecState, field: FieldNode): unknown {
  const store = state.store;
  const args = argsOf(field, state.variables);
  const input = (args.input ?? {}) as Record<string, unknown>;
  const fail = (message: string): null => {
    state.errors.push({ message });
    return null;
  };
  switch (field.name) {
    case 'createIssue': {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (parsed === null || parsed.kind !== 'Repository') return fail('createIssue: repositoryId is not a repository id');
      const repo = store.reposById.get(Number(parsed.parts[0]));
      if (repo === undefined) return fail('createIssue: repository not found');
      const created = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in created) return fail(`createIssue: ${created.error}`);
      const issue = issueObject(store, repo, created.issue);
      return resolveValue(state, { __type: 'CreateIssuePayload', issue }, field.selections);
    }
    case 'closeIssue': {
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (parsed === null || parsed.kind !== 'Issue') return fail('closeIssue: issueId is not an issue id');
      const repo = store.reposById.get(Number(parsed.parts[0]));
      const issue = repo?.issues.get(Number(parsed.parts[1]));
      if (repo === undefined || issue === undefined) return fail('closeIssue: issue not found');
      issue.state = 'closed';
      issue.json = null;
      const closed = issueObject(store, repo, issue);
      return resolveValue(state, { __type: 'CloseIssuePayload', issue: closed }, field.selections);
    }
    case 'createPullRequest': {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (parsed === null || parsed.kind !== 'Repository') return fail('createPullRequest: repositoryId is not a repository id');
      const repo = store.reposById.get(Number(parsed.parts[0]));
      if (repo === undefined) return fail('createPullRequest: repository not found');
      const created = store.createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in created) return fail(`createPullRequest: ${created.error}`);
      const pull = pullObject(store, repo, created.pull);
      return resolveValue(state, { __type: 'CreatePullRequestPayload', pullRequest: pull }, field.selections);
    }
    case 'mergePullRequest': {
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (parsed === null || parsed.kind !== 'PullRequest') return fail('mergePullRequest: pullRequestId is not a pull request id');
      const repo = store.reposById.get(Number(parsed.parts[0]));
      const pull = repo?.pulls.get(Number(parsed.parts[1]));
      if (repo === undefined || pull === undefined) return fail('mergePullRequest: pull request not found');
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return fail(`mergePullRequest: ${merged.error}`);
      const done = pullObject(store, repo, pull);
      return resolveValue(state, { __type: 'MergePullRequestPayload', pullRequest: done }, field.selections);
    }
    case 'addComment': {
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (parsed === null || parsed.kind !== 'Issue') return fail('addComment: subjectId is not an issue id');
      const repo = store.reposById.get(Number(parsed.parts[0]));
      const issue = repo?.issues.get(Number(parsed.parts[1]));
      if (repo === undefined || issue === undefined) return fail('addComment: issue not found');
      const comment = store.addComment(repo, issue, String(input.body ?? ''));
      const node: GqlObject = {
        __type: 'Comment',
        id: globalId('IssueComment', repo.id, issue.number, comment.id),
        body: comment.body,
      };
      const edge: GqlObject = { __type: 'IssueCommentEdge', node, cursor: '' };
      return resolveValue(state, { __type: 'AddCommentPayload', commentEdge: edge }, field.selections);
    }
    default:
      return fail(`Cannot query field "${field.name}" on type "Mutation".`);
  }
}

/**
 * One operation document -> one {data, errors?} result. A document that
 * fails to parse answers errors too (HTTP 200, per the GraphQL contract).
 */
export function executeGraphQL(ctx: GraphQLCtx, operationBody: unknown): Record<string, unknown> {
  const state: ExecState = { store: ctx.store, variables: {}, errors: [] };
  if (!isRecord(operationBody)) {
    return { data: null, errors: [{ message: 'GraphQL request body must be an object' }] };
  }
  const query = operationBody.query;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'GraphQL request has no query string' }] };
  }
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof operationBody.operationName === 'string' ? operationBody.operationName : null;
  const operation = operationName !== null ? operations.find((entry) => entry.name === operationName) : operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: `Unknown operation ${JSON.stringify(operationName)}` }] };
  }
  const variables = isRecord(operationBody.variables) ? operationBody.variables : {};
  const mergedVariables: Record<string, unknown> = {};
  for (const [name, def] of operation.varDefs) {
    if (name in variables) mergedVariables[name] = variables[name];
    else if (def !== null) mergedVariables[name] = evalValue(def, {});
    else mergedVariables[name] = null;
  }
  for (const [name, value] of Object.entries(variables)) {
    if (!(name in mergedVariables)) mergedVariables[name] = value;
  }
  state.variables = mergedVariables;
  const data = executeOperation(state, operation);
  if (state.errors.length > 0) return { data, errors: state.errors };
  return { data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Handle POST /api/graphql: one document or a batch array of documents. */
export function handleGraphQL(ctx: GraphQLCtx): Record<string, unknown> | Record<string, unknown>[] {
  if (Array.isArray(ctx.body)) {
    return ctx.body.map((entry) => executeGraphQL(ctx, entry));
  }
  return executeGraphQL(ctx, ctx.body);
}
