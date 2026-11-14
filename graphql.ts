// GraphQL over the same store: a small tokenizer, parser and executor that
// covers exactly the documents the suite sends (queries, mutations,
// fragments, variables, aliases, inline enums and input objects), plus the
// introspection the suite probes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIXED_ISO, VIEWER_LOGIN } from './store.ts';
import type { Forge, Issue, IssueComment, Pull, Repo } from './store.ts';
import { b64, commentGlobalId, issueGlobalId, pullGlobalId, repoGlobalId, unb64 } from './views.ts';

export interface GraphqlContext {
  forge: Forge;
  token: string;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  requestId: () => string;
}

// ---------------------------------------------------------------------------
// Tokenizer and parser
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '#') {
      if (ch === '#') while (i < source.length && source[i] !== '\n') i += 1;
      else i += 1;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === ':' || ch === '$' || ch === '!' || ch === '=' || ch === '[' || ch === ']' || ch === '@') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1] as string;
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: 'int', value: Number.parseFloat(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, unknown>;
  selections: Selection[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selections: Selection[];
}

type Selection = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Record<string, { default?: unknown }>;
  selections: Selection[];
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.index] as Token;
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value;
      this.next();
    }
    let name: string | undefined;
    const nameToken = this.peek();
    if (nameToken.kind === 'name') {
      name = nameToken.value;
      this.next();
    }
    const variables: Record<string, { default?: unknown }> = {};
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        this.expectPunct('$');
        const varToken = this.next();
        if (varToken.kind !== 'name') throw new Error('expected variable name');
        this.expectPunct(':');
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('expected variable type');
        if (this.isPunct('!')) this.next();
        if (this.isPunct('[')) this.next();
        if (this.isPunct(']')) this.next();
        if (this.isPunct('!')) this.next();
        let def: unknown;
        if (this.isPunct('=')) {
          this.next();
          def = this.parseValue({});
        }
        variables[varToken.value] = { default: def };
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.isPunct('...')) {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('expected type condition');
        return { kind: 'fragment', typeCondition: typeToken.value, selections: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        this.next();
        return { kind: 'fragment', selections: this.parseSelectionSet() };
      }
      return { kind: 'fragment', selections: this.parseSelectionSet() };
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error('expected field name');
    let alias: string | undefined;
    let name = first.value;
    if (this.isPunct(':')) {
      this.next();
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('expected field name after alias');
      alias = name;
      name = nameToken.value;
    }
    const args: Record<string, unknown> = {};
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argToken = this.next();
        if (argToken.kind !== 'name') throw new Error('expected argument name');
        this.expectPunct(':');
        args[argToken.value] = this.parseValue({});
      }
      this.expectPunct(')');
    }
    let selections: Selection[] = [];
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(variables: Record<string, unknown>): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const varToken = this.next();
      if (varToken.kind !== 'name') throw new Error('expected variable name');
      return { __variable: varToken.value };
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value;
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue(variables));
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (!this.isPunct('}')) {
        const keyToken = this.next();
        if (keyToken.kind !== 'name') throw new Error('expected object field name');
        this.expectPunct(':');
        object[keyToken.value] = this.parseValue(variables);
      }
      this.expectPunct('}');
      return object;
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__variable' in (value as Record<string, unknown>)) {
      const name = (value as { __variable: string }).__variable;
      return variables[name] ?? null;
    }
    if (Array.isArray(value)) return value.map((item) => resolveVariables(item, variables));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = resolveVariables(item, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Object shapes handed to the executor
// ---------------------------------------------------------------------------

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pr: Pull): GqlObject {
  return { __typename: 'PullRequest', repo, pr };
}

function commentObject(repo: Repo, issue: Issue, comment: IssueComment): GqlObject {
  return { __typename: 'IssueComment', repo, issue, comment };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'PULL_REQUEST'],
};

function typeInfo(name: string): GqlObject {
  return {
    __typename: '__Type',
    name,
    kind: name.endsWith('Type') ? 'ENUM' : 'OBJECT',
    fields: (TYPE_FIELDS[name] ?? []).map((field) => ({ name: field })),
    enumValues: (ENUM_VALUES[name] ?? []).map((value) => ({ name: value })),
  };
}

function cursorFor(index: number): string {
  return b64(`cursor:${index}`);
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  const decoded = unb64(cursor);
  if (!decoded.startsWith('cursor:')) return -1;
  const n = Number.parseInt(decoded.slice('cursor:'.length), 10);
  return Number.isFinite(n) ? n : -1;
}

function pageOf<T>(items: T[], first: unknown, after: unknown): { nodes: T[]; endCursor: string | null; hasNextPage: boolean } {
  const start = indexOfCursor(after) + 1;
  const count = typeof first === 'number' && Number.isFinite(first) ? first : items.length;
  const nodes = items.slice(start, start + count);
  const last = nodes.length === 0 ? null : cursorFor(start + nodes.length - 1);
  return { nodes, endCursor: last, hasNextPage: start + count < items.length };
}

class GraphqlError extends Error {}

function unknownField(typeName: string, field: string): GraphqlError {
  return new GraphqlError(`Cannot query field "${field}" on type "${typeName}".`);
}

function stateEnum(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function prStateEnum(pr: Pull): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveField(
  ctx: GraphqlContext,
  typeName: string,
  field: string,
  source: GqlObject | null,
  args: Record<string, unknown>,
): unknown {
  if (field === '__typename') return typeName;

  if (typeName === 'Query') {
    if (field === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN };
    if (field === 'repository') {
      const owner = args.owner as string | undefined;
      const name = args.name as string | undefined;
      if (owner !== VIEWER_LOGIN) return null;
      const repo = typeof name === 'string' ? ctx.forge.getRepo(VIEWER_LOGIN, name) ?? null : null;
      return repo === null ? null : repoObject(repo);
    }
    if (field === 'node') {
      const id = args.id as string | undefined;
      if (typeof id !== 'string') return null;
      return resolveNode(ctx, id);
    }
    if (field === '__type') {
      const name = args.name as string | undefined;
      return typeof name === 'string' ? typeInfo(name) : null;
    }
    throw unknownField('Query', field);
  }

  if (typeName === 'Mutation') {
    if (field === 'createIssue') return mutateCreateIssue(ctx, args.input as Record<string, unknown> | undefined);
    if (field === 'closeIssue') return mutateCloseIssue(ctx, args.input as Record<string, unknown> | undefined);
    if (field === 'addComment') return mutateAddComment(ctx, args.input as Record<string, unknown> | undefined);
    if (field === 'createPullRequest') return mutateCreatePullRequest(ctx, args.input as Record<string, unknown> | undefined);
    if (field === 'mergePullRequest') return mutateMergePullRequest(ctx, args.input as Record<string, unknown> | undefined);
    throw unknownField('Mutation', field);
  }

  if (source === null) throw unknownField(typeName, field);

  if (typeName === 'User') {
    if (field === 'login') return (source as { login?: string }).login ?? VIEWER_LOGIN;
    throw unknownField('User', field);
  }

  if (typeName === 'Repository') {
    const repo = source.repo as Repo;
    switch (field) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return { __typename: 'User', login: repo.owner };
      case 'defaultBranchRef':
        return { __typename: 'Ref', name: repo.defaultBranch };
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const number = args.number as number | undefined;
        const issue = typeof number === 'number' ? repo.issues.get(number) ?? null : null;
        return issue === null ? null : issueObject(repo, issue);
      }
      case 'issues': {
        let issues = [...repo.issues.values()];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => state.toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy?.direction === 'DESC') issues = [...issues].reverse();
        const page = pageOf(issues, args.first, args.after);
        const start = indexOfCursor(args.after) + 1;
        return {
          __typename: 'IssueConnection',
          nodes: page.nodes.map((issue) => issueObject(repo, issue)),
          edges: page.nodes.map((issue, index) => ({
            __typename: 'IssueEdge',
            cursor: cursorFor(start + index),
            node: issueObject(repo, issue),
          })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: page.hasNextPage, endCursor: page.endCursor, hasPreviousPage: false, startCursor: null },
          totalCount: issues.length,
        };
      }
      case 'pullRequests': {
        const prs = [...repo.prs.values()];
        const page = pageOf(prs, args.first, args.after);
        const start = indexOfCursor(args.after) + 1;
        return {
          __typename: 'PullRequestConnection',
          nodes: page.nodes.map((pr) => pullObject(repo, pr)),
          edges: page.nodes.map((pr, index) => ({
            __typename: 'PullRequestEdge',
            cursor: cursorFor(start + index),
            node: pullObject(repo, pr),
          })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: page.hasNextPage, endCursor: page.endCursor, hasPreviousPage: false, startCursor: null },
          totalCount: prs.length,
        };
      }
      case 'pullRequest': {
        const number = args.number as number | undefined;
        const pr = typeof number === 'number' ? repo.prs.get(number) ?? null : null;
        return pr === null ? null : pullObject(repo, pr);
      }
      default:
        throw unknownField('Repository', field);
    }
  }

  if (typeName === 'Issue') {
    const issue = source.issue as Issue;
    const repo = source.repo as Repo;
    switch (field) {
      case 'id':
        return issueGlobalId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return stateEnum(issue.state);
      case 'body':
        return issue.body;
      case 'author':
        return { __typename: 'User', login: VIEWER_LOGIN };
      case 'labels':
        return { __typename: 'LabelConnection', nodes: issue.labels.map((name) => ({ __typename: 'Label', name })) };
      case 'comments':
        return { __typename: 'IssueCommentConnection', nodes: issue.comments.map((comment) => commentObject(repo, issue, comment)) };
      default:
        throw unknownField('Issue', field);
    }
  }

  if (typeName === 'PullRequest') {
    const pr = source.pr as Pull;
    const repo = source.repo as Repo;
    switch (field) {
      case 'id':
        return pullGlobalId(repo, pr);
      case 'number':
        return pr.number;
      case 'title':
        return pr.title;
      case 'state':
        return prStateEnum(pr);
      case 'headRefName':
        return pr.headRef;
      case 'baseRefName':
        return pr.baseRef;
      case 'mergeable':
        return ctx.forge.pullConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
      case 'merged':
        return pr.merged;
      case 'files': {
        const changes = ctx.forge.pullFiles(repo, pr);
        const page = pageOf(changes, args.first, args.after);
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: page.nodes.map((change) => ({ __typename: 'PullRequestChangedFile', path: change.path })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: page.hasNextPage, endCursor: page.endCursor, hasPreviousPage: false, startCursor: null },
          totalCount: changes.length,
        };
      }
      default:
        throw unknownField('PullRequest', field);
    }
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    const nodes = (source as unknown as { nodes?: unknown[] }).nodes ?? [];
    const pageInfo = (source as unknown as { pageInfo?: unknown }).pageInfo;
    const totalCount = (source as unknown as { totalCount?: number }).totalCount;
    const edges = (source as unknown as { edges?: unknown[] }).edges ?? [];
    if (field === 'nodes') return nodes;
    if (field === 'edges') return edges;
    if (field === 'pageInfo') return pageInfo;
    if (field === 'totalCount') return totalCount;
    throw unknownField(typeName, field);
  }

  if (typeName === 'IssueEdge' || typeName === 'PullRequestEdge') {
    const node = (source as unknown as { node?: unknown }).node;
    const cursor = (source as unknown as { cursor?: string }).cursor;
    if (field === 'cursor') return cursor;
    if (field === 'node') return node;
    throw unknownField(typeName, field);
  }

  if (typeName === 'PullRequestChangedFile') {
    if (field === 'path') return (source as unknown as { path?: string }).path;
    throw unknownField('PullRequestChangedFile', field);
  }

  if (typeName === 'PageInfo') {
    const info = source as unknown as Record<string, unknown>;
    if (field in info) return info[field];
    throw unknownField('PageInfo', field);
  }

  if (typeName === 'Ref') {
    if (field === 'name') return (source as unknown as { name?: string }).name;
    throw unknownField('Ref', field);
  }

  if (typeName === '__Type') {
    const info = source as unknown as Record<string, unknown>;
    if (field === 'name' || field === 'kind') return info[field];
    if (field === 'fields') {
      const includeDeprecated = args.includeDeprecated === true;
      const fields = (info.fields as Array<{ name: string }>) ?? [];
      return includeDeprecated ? fields : fields;
    }
    if (field === 'enumValues') {
      const includeDeprecated = args.includeDeprecated === true;
      const values = (info.enumValues as Array<{ name: string }>) ?? [];
      return includeDeprecated ? values : values;
    }
    throw unknownField('__Type', field);
  }

  if (typeName === 'IssueComment') {
    const comment = source.comment as IssueComment;
    const repo = source.repo as Repo;
    const issue = source.issue as Issue;
    if (field === 'id') return commentGlobalId(repo, issue, comment);
    if (field === 'body') return comment.body;
    if (field === 'author') return { __typename: 'User', login: VIEWER_LOGIN };
    throw unknownField('IssueComment', field);
  }

  if (typeName === 'IssueCommentEdge') {
    const node = (source as unknown as { node?: unknown }).node;
    if (field === 'node') return node;
    if (field === 'cursor') return null;
    throw unknownField('IssueCommentEdge', field);
  }

  if (typeName === 'Label') {
    if (field === 'name') return (source as unknown as { name?: string }).name;
    throw unknownField('Label', field);
  }

  if (typeName === 'LabelConnection' || typeName === 'IssueCommentConnection') {
    const nodes = (source as unknown as { nodes?: unknown[] }).nodes ?? [];
    if (field === 'nodes') return nodes;
    if (field === 'totalCount') return nodes.length;
    throw unknownField(typeName, field);
  }

  // Mutation payloads and the comment edge.
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload' || typeName === 'MergePullRequestPayload') {
    const issue = (source as unknown as { issue?: unknown }).issue;
    const pr = (source as unknown as { pullRequest?: unknown }).pullRequest;
    if (field === 'issue') return issue;
    if (field === 'pullRequest') return pr;
    throw unknownField(typeName, field);
  }
  if (typeName === 'CreatePullRequestPayload') {
    const pr = (source as unknown as { pullRequest?: unknown }).pullRequest;
    if (field === 'pullRequest') return pr;
    throw unknownField(typeName, field);
  }
  if (typeName === 'AddCommentPayload') {
    const edge = (source as unknown as { commentEdge?: unknown }).commentEdge;
    if (field === 'commentEdge') return edge;
    throw unknownField(typeName, field);
  }

  throw unknownField(typeName, field);
}

function resolveNode(ctx: GraphqlContext, id: string): GqlObject | null {
  const decoded = unb64(id);
  const parts = decoded.split(':');
  if (parts[0] === 'Repository' && parts.length === 2) {
    const repo = ctx.forge.repoById(Number.parseInt(parts[1] as string, 10));
    return repo === null ? null : repoObject(repo);
  }
  if (parts[0] === 'Issue' && parts.length === 3) {
    const repo = ctx.forge.repoById(Number.parseInt(parts[1] as string, 10));
    const issue = repo?.issues.get(Number.parseInt(parts[2] as string, 10)) ?? null;
    return repo !== null && issue !== null ? issueObject(repo, issue) : null;
  }
  if (parts[0] === 'PullRequest' && parts.length === 3) {
    const repo = ctx.forge.repoById(Number.parseInt(parts[1] as string, 10));
    const pr = repo?.prs.get(Number.parseInt(parts[2] as string, 10)) ?? null;
    return repo !== null && pr !== null ? pullObject(repo, pr) : null;
  }
  if (parts[0] === 'IssueComment' && parts.length === 4) {
    const repo = ctx.forge.repoById(Number.parseInt(parts[1] as string, 10));
    const issue = repo?.issues.get(Number.parseInt(parts[2] as string, 10)) ?? null;
    const comment = issue?.comments.find((candidate) => candidate.id === Number.parseInt(parts[3] as string, 10)) ?? null;
    return repo !== null && issue !== null && comment !== null ? commentObject(repo, issue, comment) : null;
  }
  return null;
}

function repoFromGlobalId(ctx: GraphqlContext, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = unb64(id);
  const parts = decoded.split(':');
  if (parts[0] !== 'Repository' || parts.length !== 2) return null;
  return ctx.forge.repoById(Number.parseInt(parts[1] as string, 10));
}

function issueFromGlobalId(ctx: GraphqlContext, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = unb64(id);
  const parts = decoded.split(':');
  if (parts[0] !== 'Issue' || parts.length !== 3) return null;
  const repo = ctx.forge.repoById(Number.parseInt(parts[1] as string, 10));
  if (repo === null) return null;
  const issue = repo.issues.get(Number.parseInt(parts[2] as string, 10)) ?? null;
  return issue === null ? null : { repo, issue };
}

function prFromGlobalId(ctx: GraphqlContext, id: unknown): { repo: Repo; pr: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = unb64(id);
  const parts = decoded.split(':');
  if (parts[0] !== 'PullRequest' || parts.length !== 3) return null;
  const repo = ctx.forge.repoById(Number.parseInt(parts[1] as string, 10));
  if (repo === null) return null;
  const pr = repo.prs.get(Number.parseInt(parts[2] as string, 10)) ?? null;
  return pr === null ? null : { repo, pr };
}

function mutateCreateIssue(ctx: GraphqlContext, input: Record<string, unknown> | undefined): GqlObject {
  if (input === undefined) throw new GraphqlError('createIssue requires an input');
  const repo = repoFromGlobalId(ctx, input.repositoryId);
  if (repo === null) throw new GraphqlError('repository not found');
  const issue = ctx.forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''));
  return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
}

function mutateCloseIssue(ctx: GraphqlContext, input: Record<string, unknown> | undefined): GqlObject {
  if (input === undefined) throw new GraphqlError('closeIssue requires an input');
  const found = issueFromGlobalId(ctx, input.issueId);
  if (found === null) throw new GraphqlError('issue not found');
  found.issue.state = 'closed';
  return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue) };
}

function mutateAddComment(ctx: GraphqlContext, input: Record<string, unknown> | undefined): GqlObject {
  if (input === undefined) throw new GraphqlError('addComment requires an input');
  const found = issueFromGlobalId(ctx, input.subjectId);
  if (found === null) throw new GraphqlError('issue not found');
  const comment = ctx.forge.addComment(found.repo, found.issue, String(input.body ?? ''));
  return {
    __typename: 'AddCommentPayload',
    commentEdge: { __typename: 'IssueCommentEdge', node: commentObject(found.repo, found.issue, comment) },
  };
}

function mutateCreatePullRequest(ctx: GraphqlContext, input: Record<string, unknown> | undefined): GqlObject {
  if (input === undefined) throw new GraphqlError('createPullRequest requires an input');
  const repo = repoFromGlobalId(ctx, input.repositoryId);
  if (repo === null) throw new GraphqlError('repository not found');
  const pr = ctx.forge.createPull(
    repo,
    String(input.title ?? ''),
    String(input.body ?? ''),
    String(input.headRefName ?? ''),
    String(input.baseRefName ?? ''),
  );
  if (pr === null) throw new GraphqlError('A pull request already exists for this head branch');
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pr) };
}

function mutateMergePullRequest(ctx: GraphqlContext, input: Record<string, unknown> | undefined): GqlObject {
  if (input === undefined) throw new GraphqlError('mergePullRequest requires an input');
  const found = prFromGlobalId(ctx, input.pullRequestId);
  if (found === null) throw new GraphqlError('pull request not found');
  const sha = ctx.forge.mergePull(found.repo, found.pr);
  if (sha === null) throw new GraphqlError('Merge conflict');
  return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(found.repo, found.pr) };
}

function isGqlObject(value: unknown): value is GqlObject {
  return typeof value === 'object' && value !== null && '__typename' in (value as Record<string, unknown>);
}

function executeSelections(
  ctx: GraphqlContext,
  typeName: string,
  source: GqlObject | null,
  selections: Selection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelections(ctx, typeName, source, selection.selections, variables));
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(selection.args)) args[key] = resolveVariables(value, variables);
    const value = resolveField(ctx, typeName, selection.name, source, args);
    const key = selection.alias ?? selection.name;
    if (selection.selections.length === 0) {
      out[key] = value;
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (isGqlObject(item)) return executeSelections(ctx, item.__typename, item, selection.selections, variables);
        return item;
      });
      continue;
    }
    if (isGqlObject(value)) {
      out[key] = executeSelections(ctx, value.__typename, value, selection.selections, variables);
      continue;
    }
    // Plain objects (pageInfo, __Type field lists) carry no __typename.
    if (typeof value === 'object') {
      const wrapped = value as Record<string, unknown>;
      const inferred = (wrapped.__typename as string | undefined) ?? 'Object';
      out[key] = executeSelections(ctx, inferred, value as GqlObject, selection.selections, variables);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOperation(ctx: GraphqlContext, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const allVariables: Record<string, unknown> = { ...variables };
  for (const [name, def] of Object.entries(operation.variables)) {
    if (!(name in allVariables) && def.default !== undefined) allVariables[name] = resolveVariables(def.default, variables);
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = executeSelections(ctx, rootType, null, operation.selections, allVariables);
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'execution failed' }] };
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, ctx: GraphqlContext): Promise<boolean> {
  if (req.method !== 'POST') {
    ctx.sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (ctx.token !== '' && req.headers.authorization !== `Bearer ${ctx.token}`) {
    res.writeHead(401, { 'content-type': 'application/json', 'x-github-request-id': ctx.requestId() });
    res.end(JSON.stringify({ message: 'Bad credentials' }));
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    ctx.sendJson(res, 400, { message: 'could not read the request body' });
    return true;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    ctx.sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  const operations = Array.isArray(payload) ? payload : [payload];
  const results = operations.map((operation) => {
    if (typeof operation !== 'object' || operation === null || typeof (operation as { query?: unknown }).query !== 'string') {
      return { data: null, errors: [{ message: 'a query string is required' }] };
    }
    const query = (operation as { query: string }).query;
    const variables = (operation as { variables?: Record<string, unknown> }).variables ?? {};
    let parsed: Operation[];
    try {
      parsed = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'could not parse the query' }] };
    }
    if (parsed.length === 0) return { data: null, errors: [{ message: 'empty query' }] };
    const operationName = (operation as { operationName?: string }).operationName;
    const chosen = operationName === undefined ? parsed[0] : parsed.find((item) => item.name === operationName) ?? parsed[0];
    return executeOperation(ctx, chosen as Operation, variables);
  });
  ctx.sendJson(res, 200, Array.isArray(payload) ? results : results[0]);
  return true;
}

export { FIXED_ISO };
