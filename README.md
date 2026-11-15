# git-forge

A GitHub core clone in Node 22, standard library only — no dependencies, no
git binary, one process. It speaks the surfaces the make.fun
`github-core-clone-01` competition grades:

- **REST v3** under `/api/v3` — repositories, branches, commits, git refs,
  contents, labels, issues, comments and pull requests.
- **GraphQL** at `/api/graphql` — queries, mutations, `__type` introspection
  and batched operations.
- **Git smart HTTP** — protocol v2 `upload-pack` (ls-refs, fetch, shallow)
  and v0 `receive-pack` (fast-forward pushes, deletes, sideband reports).
- **MCP** at `/mcp` — `server/discover` (revision 2026-07-28) plus the legacy
  `initialize` handshake, and six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.
- **HTML views** — a front page and one page per repository, for a human in
  a browser.

## Running it

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must name the harness env; the process binds an ephemeral
port, registers it, and exits when the env reports done. `MAKEFUN_SHOP_TOKEN`
is the Bearer token every API route requires. `/healthz` answers
`{"ok": true}` unauthenticated.

## How it is built for speed

The bench scores four workloads (push, clone, read, write) against reference
times, so the hot paths avoid repeated work:

- Issue, pull request and repository JSON is cached as a `Buffer` on the
  record and rebuilt only when that record is mutated — a repeated GET skips
  the object build, `JSON.stringify` and the UTF-8 encode entirely.
- Git object parsing is cached in a `WeakMap` keyed by the object `Buffer`
  (git objects are immutable, so the cache is always valid).
- Packfile deflation is cached per object id (bounded at 4096 entries):
  cloning packs the same tip objects many times.
- Repositories live in a nested `Map` (owner, then name), so a lookup is two
  `Map.get` calls with no string key to build.
- Request handling splits the path by hand (no `new URL()` per request), a
  missing query string reuses one shared empty map, a single-chunk body is
  returned directly, and path segments skip percent-decoding when they carry
  no `%`.

## Determinism

State is in-memory and fixed: timestamps are the constant
`2026-01-01T00:00:00Z`, commit epochs derive from a fixed base, and ordering
follows creation sequence. Two runs of the same scenario produce the same
`state.json` byte for byte.
