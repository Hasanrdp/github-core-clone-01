# github-core-clone-01

A standalone GitHub-compatible git forge in a single Node process, with no
dependencies beyond the Node standard library and no outside service.

It serves, from its own in-memory store:

- git smart HTTP (protocol v2 and v0): clone, fetch, push, shallow clones,
  annotated tags, sideband framing and report-status;
- the GitHub REST v3 API: repositories, branches, commits, contents, labels,
  issues, comments and pull requests with squash merges;
- GraphQL v4: the viewer/repository/issue/pull-request documents `gh` and
  `github-mcp-server` send, plus Relay global ids and `__type` introspection;
- MCP over streamable HTTP: `server/discover`, `initialize`, `tools/list` and
  `tools/call` for six tools that share the same store as REST.

## Running

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The process binds an ephemeral port, registers it with the environment,
serves until the environment reports done, then exits 0.

## Layout

- `main.ts` — the entry/environment lifecycle.
- `app.ts` — the HTTP server and route dispatch.
- `store.ts` — the in-memory forge: repositories, objects, refs, issues,
  pull requests, and the git object model.
- `pack.ts` — pkt-line framing and packfile read/write.
- `githttp.ts` — the smart-HTTP endpoints.
- `rest.ts` — the REST v3 endpoints.
- `views.ts` — the JSON shapes the surfaces share.
- `graphql.ts` — a small GraphQL parser and executor.
- `mcp.ts` — the MCP endpoint and its tools.

All timestamps the forge stores are fixed constants, so two runs over the
same requests produce the same state.
