# anycli

**Turn any MCP server or OpenAPI spec into a CLI your agent can call.**

`anycli` wraps [Model Context Protocol](https://modelcontextprotocol.io) servers (stdio, SSE, Streamable HTTP) and REST APIs described by OpenAPI 3.x / Swagger 2.0 as ordinary shell commands, with built-in OAuth2 browser login. LLM agents that can run a shell (Claude Code, Codex, Aider, your own loop) get every tool without loading MCP schemas into their context, and without per-tool glue code.

```console
$ anycli add mcp fs -- npx -y @modelcontextprotocol/server-filesystem ~/src
$ anycli add openapi petstore https://petstore3.swagger.io/api/v3/openapi.json

$ anycli tools petstore --filter pet
petstore (openapi) — 10 of 19 tools
Call: anycli call petstore <tool> --param value   Details: anycli describe petstore <tool>

update-pet: Update an existing pet.
  --name <string> --photoUrls <string[]> [--id <integer>] [--category <json>] [--tags <json[]>] [--status <available|pending|sold>]
find-pets-by-status: Finds Pets by status.
  --status <available|pending|sold>
...

$ anycli petstore find-pets-by-status --status sold
[{"id":14326,"category":{"id":2,"name":"Perros"},"name":"Max","photoUrls":[...],"status":"sold"}, ...]
```

## Why a CLI for agents?

- **Context-cheap.** Agents discover tools on demand (`anycli tools`, `anycli describe`) instead of carrying every schema in the prompt.
- **One interface for everything.** MCP tools and REST operations look the same: `anycli <target> <tool> --param value`.
- **Scriptable and composable.** Pipe results into `jq`, loop in shell, run in CI, or generate a shim so `github search-repos --q mcp` just works.
- **Auth handled once.** `anycli auth login <target>` opens the browser, stores tokens securely and refreshes them automatically.

## Install

```sh
npm install -g anycli-mcp  # Node.js 20+; installs the `anycli` command
npx anycli-mcp --help      # or run it without installing
```

## Adding targets

### MCP servers

```sh
# stdio: everything after -- is the server command
anycli add mcp fs -- npx -y @modelcontextprotocol/server-filesystem ~/src
anycli add mcp gh -e GITHUB_TOKEN='${GITHUB_TOKEN}' -- npx -y @modelcontextprotocol/server-github

# remote: Streamable HTTP (default) or SSE (auto-detected for URLs ending in /sse, or --transport sse)
anycli add mcp linear https://mcp.linear.app/mcp --oauth
anycli add mcp internal https://mcp.example.com/sse -H 'Authorization: Bearer ${INTERNAL_TOKEN}'

# import everything from an existing client config
anycli import ~/Library/Application\ Support/Claude/claude_desktop_config.json
anycli import .mcp.json           # Claude Code / Cursor (mcpServers) or VS Code (servers)
```

### OpenAPI

```sh
anycli add openapi petstore https://petstore3.swagger.io/api/v3/openapi.json
anycli add openapi github ./api.github.com.yaml --include 'tag:repos,tag:issues' --bearer '${GITHUB_TOKEN}'
anycli add openapi acme https://api.acme.dev/openapi.json --oauth --client-id my-cli-app
```

Each operation becomes a tool named after its `operationId` in kebab-case (`listPets` → `list-pets`; without an id: `delete-pets-pet-id`). Path, query, header and cookie parameters become flags. JSON object bodies are flattened into flags too (`--name Rex --tag dog`); other bodies are passed as `--body '<json>'`. Binary fields (`format: binary`, file uploads, `application/octet-stream` bodies) take `@/path/to/file`; everywhere else a leading `@` is sent as text.

`--include` / `--exclude` accept globs over tool names and operationIds, or `tag:<name>`; large APIs stay navigable. The spec is compiled once and cached; run `anycli refresh <target>` after it changes. Swagger 2.0 documents are converted automatically; relative `servers` URLs resolve against the spec URL, or set `--base-url`. The base URL is pinned in the config when the target is added, so a later change to a remote spec cannot redirect your credentials; `refresh` tells you if the spec now points elsewhere.

## Calling tools

```sh
anycli call <target> <tool> --param value      # or the shorthand:
anycli <target> <tool> --param value
```

| Input | How |
|---|---|
| scalars | `--limit 10 --verbose` / `--no-verbose` (converted to the schema type) |
| arrays | repeat the flag (`--tag a --tag b`) or `--tag '["a","b"]'` |
| objects | JSON: `--filter '{"status":"open"}'` |
| everything at once | `--args '{"q":"x"}'`, `--args-file args.json`, `--args-file -` (stdin) |

Parameter names are matched case- and dash-insensitively (`--pet-id` works for `petId`). Reserved options: `--dry-run` (show the MCP call / HTTP request with credentials masked), `--raw` (full MCP result or HTTP status + headers + body), `--call-timeout <ms>`, `--save <file>` (binary output), `--help` (this tool's parameters).

**Output:** structured results are printed as JSON (compact when piped), text results as plain text; images and binary bodies are summarized unless you `--save` them. Progress and errors go to stderr, so stdout stays parseable.

**Exit codes:** `0` ok · `2` usage (bad/missing parameters, unknown tool) · `3` login required · `4` the tool or API returned an error (its output is still printed) · `5` connection/timeout · `6` config problem. Add `--json` (before the command or after the tool arguments) to get errors as JSON too.

## Authentication

| Target | Options |
|---|---|
| any HTTP target | `--bearer <token>`, `--basic user:pass`, `--api-key <value>` (`--api-key-name`, `--api-key-in header\|query\|cookie`; defaults come from the spec) |
| remote MCP server | `--oauth`: the [MCP authorization spec](https://modelcontextprotocol.io/specification/latest/basic/authorization) — metadata discovery, dynamic client registration, PKCE. Pass `--client-id` if the server requires a pre-registered client. |
| OpenAPI | `--oauth --client-id <id>`: OAuth2 endpoints and scopes are read from the spec's `securitySchemes` (`oauth2` or `openIdConnect`); override with `--auth-url`, `--token-url`, `--discovery-url`, `--scopes`, `--audience` |

```sh
anycli auth login acme              # opens the browser, waits for the redirect, stores tokens
anycli auth login acme --no-browser # prints the URL instead (SSH sessions)
anycli auth login acme --flow device_code   # RFC 8628 device flow for headless machines
anycli auth status                  # never prints tokens
anycli auth logout acme
```

OAuth2 grants: `authorization_code` with PKCE (default), `device_code`, and `client_credentials` (fetched automatically, no login needed). Access tokens are refreshed automatically before they expire and once more if the API answers 401. If your OAuth app requires an exact redirect URI, register `http://127.0.0.1:<port>/callback` and add `--redirect-port <port>`.

OAuth2 endpoints must use `https` (plain `http` only for localhost); endpoints read from a spec are printed when you add the target so you can check them.

**Keep secrets out of the config**: every string in the config may reference the environment as `${VAR}`, `${env:VAR}` or `${VAR:-default}`, and `anycli show` masks literal secrets.

## Teaching your agent

```sh
anycli gen skill -o .claude/skills            # index skill: how to use anycli + your targets
anycli gen skill github linear -o .claude/skills   # one skill per target, listing its tools
anycli gen shim github                         # ~/.local/bin/github → `github <tool> --param value`
```

Or just tell the agent: *"Use `anycli list`, `anycli tools <target>` and `anycli call` to reach external tools."* Every error carries a `hint:` line with the next command to run.

## Command reference

| Command | Purpose |
|---|---|
| `add mcp <name> <url \| -- command args...>` | add an MCP server |
| `add openapi <name> <spec>` | add an OpenAPI / Swagger API |
| `import <file>` | import `mcpServers` from Claude Desktop / Claude Code / Cursor / VS Code |
| `list` · `show <name>` · `remove <name>` · `refresh <name>` | manage targets |
| `tools <target> [--filter text] [--names]` | list tools with signatures |
| `describe <target> <tool>` | full parameter documentation |
| `call <target> <tool> ...` / `<target> <tool> ...` | call a tool |
| `auth login\|status\|logout` | OAuth login and stored credentials |
| `doctor [targets...]` | check connectivity and auth |
| `gen skill [targets...]` · `gen shim <target>` | generate agent skills / shell shims |

Global options: `--json` (machine-readable output and errors), `--pretty`, `-v/--verbose` (show MCP server stderr), `-c/--config <path>`.

## Files

| Path | Content |
|---|---|
| `./.anycli.json` or `~/.config/anycli/config.json` | targets (a project file wins; override with `--config` or `ANYCLI_CONFIG`) |
| `~/.config/anycli/credentials/<target>.json` | OAuth tokens, mode `0600` in a `0700` directory |
| `~/.config/anycli/cache/<target>.openapi.json` | compiled OpenAPI manifest |

Uploads (`@file`) and `--save` refuse to read or write anycli's own directory and config file, so a tool call cannot leak or overwrite stored tokens. anycli is not a sandbox, though: it runs with your user's permissions, like any other command your agent executes.

`ANYCLI_HOME` relocates the whole directory; `ANYCLI_NO_BROWSER=1` disables opening a browser; `BROWSER=<command>` picks the browser.

## Development

```sh
pnpm install
pnpm test          # unit + integration + CLI end-to-end tests (real MCP, OAuth and HTTP fixtures)
pnpm coverage
pnpm typecheck
pnpm build         # dist/cli.js
pnpm dev -- list   # run from source
```

## License

MIT
