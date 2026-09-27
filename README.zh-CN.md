# any2cli

[English](README.md) | 简体中文

**把任意 MCP 服务或 OpenAPI 文档变成 Agent 可以直接调用的命令行工具。**

`any2cli` 把 [Model Context Protocol](https://modelcontextprotocol.io) 服务（stdio、SSE、Streamable HTTP）以及用 OpenAPI 3.x / Swagger 2.0 描述的 REST API 包装成普通的 shell 命令，并内置 OAuth2 浏览器登录。能执行 shell 的 LLM Agent（Claude Code、Codex、Aider 或你自己的 Agent 循环）无需把 MCP schema 塞进上下文，也无需为每个工具写胶水代码，就能用上所有工具。

```console
$ any2cli add mcp fs -- npx -y @modelcontextprotocol/server-filesystem ~/src
$ any2cli add openapi petstore https://petstore3.swagger.io/api/v3/openapi.json

$ any2cli tools petstore --filter pet
petstore (openapi) — 10 of 19 tools
Call: any2cli call petstore <tool> --param value   Details: any2cli describe petstore <tool>

update-pet: Update an existing pet.
  --name <string> --photoUrls <string[]> [--id <integer>] [--category <json>] [--tags <json[]>] [--status <available|pending|sold>]
find-pets-by-status: Finds Pets by status.
  --status <available|pending|sold>
...

$ any2cli petstore find-pets-by-status --status sold
[{"id":14326,"category":{"id":2,"name":"Perros"},"name":"Max","photoUrls":[...],"status":"sold"}, ...]
```

## 为什么给 Agent 用 CLI？

- **省上下文。** Agent 按需查看工具（`any2cli tools`、`any2cli describe`），不必在提示词里带着全部 schema。
- **统一接口。** MCP 工具和 REST 接口的调用方式完全一样：`any2cli <target> <tool> --param value`。
- **可脚本化、可组合。** 结果可以接 `jq`、在 shell 里循环、在 CI 里运行，或生成快捷命令，让 `github search-repos --q mcp` 直接可用。
- **认证只做一次。** `any2cli auth login <target>` 打开浏览器登录，安全保存 token 并自动刷新。

## 安装

```sh
npm install -g any2cli   # 需要 Node.js 20+
npx any2cli --help       # 或者不安装直接运行
```

## 添加目标

### MCP 服务

```sh
# stdio：-- 之后的内容是启动服务的命令
any2cli add mcp fs -- npx -y @modelcontextprotocol/server-filesystem ~/src
any2cli add mcp gh -e GITHUB_TOKEN='${GITHUB_TOKEN}' -- npx -y @modelcontextprotocol/server-github

# 远程：默认 Streamable HTTP；URL 以 /sse 结尾时自动识别为 SSE，也可用 --transport sse 指定
any2cli add mcp linear https://mcp.linear.app/mcp --oauth
any2cli add mcp internal https://mcp.example.com/sse -H 'Authorization: Bearer ${INTERNAL_TOKEN}'

# 从现有客户端配置一次性导入
any2cli import ~/Library/Application\ Support/Claude/claude_desktop_config.json
any2cli import .mcp.json           # Claude Code / Cursor（mcpServers）或 VS Code（servers）
```

### OpenAPI

```sh
any2cli add openapi petstore https://petstore3.swagger.io/api/v3/openapi.json
any2cli add openapi github ./api.github.com.yaml --include 'tag:repos,tag:issues' --bearer '${GITHUB_TOKEN}'
any2cli add openapi acme https://api.acme.dev/openapi.json --oauth --client-id my-cli-app
```

每个接口会变成一个工具，名字取自 `operationId` 的 kebab-case 形式（`listPets` → `list-pets`；没有 id 时类似 `delete-pets-pet-id`）。路径、查询、请求头和 Cookie 参数都变成命令行参数。JSON 对象请求体也会展开成参数（`--name Rex --tag dog`），其他请求体通过 `--body '<json>'` 传入。二进制字段（`format: binary`、文件上传、`application/octet-stream` 请求体）用 `@/path/to/file` 传文件；其他字段里以 `@` 开头的值按普通文本发送。

`--include` / `--exclude` 支持对工具名和 operationId 使用通配符，也支持 `tag:<name>`，大型 API 也能保持清爽。文档只编译一次并缓存；文档变化后运行 `any2cli refresh <target>`。Swagger 2.0 文档会自动转换；相对的 `servers` 地址会基于文档 URL 解析，也可以用 `--base-url` 指定。添加目标时，服务器地址会固定写入配置，之后远程文档即使被修改也无法把你的凭证引到别处；`refresh` 时如果文档里的地址变了会提示你。

## 调用工具

```sh
any2cli call <target> <tool> --param value      # 或简写为：
any2cli <target> <tool> --param value
```

| 输入 | 写法 |
|---|---|
| 标量 | `--limit 10 --verbose` / `--no-verbose`（按 schema 类型转换） |
| 数组 | 重复参数（`--tag a --tag b`）或 `--tag '["a","b"]'` |
| 对象 | JSON：`--filter '{"status":"open"}'` |
| 一次性传全部参数 | `--args '{"q":"x"}'`、`--args-file args.json`、`--args-file -`（从标准输入读取） |

参数名匹配不区分大小写和连字符（`--pet-id` 可以匹配 `petId`）。保留选项：`--dry-run`（只显示将要发出的 MCP 调用或 HTTP 请求，凭证会被遮蔽）、`--raw`（完整的 MCP 结果，或 HTTP 状态码 + 响应头 + 响应体）、`--call-timeout <ms>`、`--save <file>`（保存二进制输出）、`--help`（查看该工具的参数）。

**输出：** 结构化结果以 JSON 输出（被管道接收时为紧凑格式），文本结果按原样输出；图片和二进制内容只输出摘要，除非用 `--save` 保存。进度和错误信息写到 stderr，stdout 始终可以直接解析。

**退出码：** `0` 成功 · `2` 用法错误（参数错误或缺失、工具不存在） · `3` 需要登录 · `4` 工具或 API 返回错误（输出仍会打印） · `5` 连接失败或超时 · `6` 配置问题。加上 `--json`（放在命令前或工具参数后都可以），错误也会以 JSON 输出。

## 认证

| 目标 | 选项 |
|---|---|
| 任意 HTTP 目标 | `--bearer <token>`、`--basic user:pass`、`--api-key <value>`（`--api-key-name`、`--api-key-in header\|query\|cookie`；默认值取自文档） |
| 远程 MCP 服务 | `--oauth`：遵循 [MCP 授权规范](https://modelcontextprotocol.io/specification/latest/basic/authorization)，自动发现元数据、动态注册客户端、使用 PKCE。如果服务要求预先注册的客户端，传入 `--client-id`。 |
| OpenAPI | `--oauth --client-id <id>`：OAuth2 端点和 scope 从文档的 `securitySchemes`（`oauth2` 或 `openIdConnect`）读取；可用 `--auth-url`、`--token-url`、`--discovery-url`、`--scopes`、`--audience` 覆盖 |

```sh
any2cli auth login acme              # 打开浏览器，等待回调，保存 token
any2cli auth login acme --no-browser # 只打印登录链接（适合 SSH 会话）
any2cli auth login acme --flow device_code   # RFC 8628 设备码流程，适合没有浏览器的机器
any2cli auth status                  # 从不打印 token
any2cli auth logout acme
```

支持的 OAuth2 授权方式：带 PKCE 的 `authorization_code`（默认）、`device_code`，以及 `client_credentials`（自动获取，无需登录）。访问 token 会在过期前自动刷新，API 返回 401 时还会再刷新一次并重试。如果你的 OAuth 应用要求精确匹配回调地址，请注册 `http://127.0.0.1:<port>/callback` 并加上 `--redirect-port <port>`。

OAuth2 端点必须使用 `https`（只有 localhost 允许 `http`）；从文档中读取的端点会在添加目标时打印出来，方便你核对。

**不要把密钥写进配置**：配置里的任何字符串都可以用 `${VAR}`、`${env:VAR}` 或 `${VAR:-default}` 引用环境变量；`any2cli show` 会遮蔽直接写入的密钥。

## 教会你的 Agent

```sh
any2cli gen skill -o .claude/skills            # 索引 skill：如何使用 any2cli 以及已配置的目标
any2cli gen skill github linear -o .claude/skills   # 每个目标一个 skill，列出它的工具
any2cli gen shim github                         # 生成 ~/.local/bin/github，之后可直接 `github <tool> --param value`
```

也可以直接告诉 Agent：*"用 `any2cli list`、`any2cli tools <target>` 和 `any2cli call` 调用外部工具。"* 每条错误都带有 `hint:` 行，提示下一步该运行什么命令。

## 命令一览

| 命令 | 用途 |
|---|---|
| `add mcp <name> <url \| -- command args...>` | 添加 MCP 服务 |
| `add openapi <name> <spec>` | 添加 OpenAPI / Swagger API |
| `import <file>` | 从 Claude Desktop / Claude Code / Cursor / VS Code 导入 `mcpServers` |
| `list` · `show <name>` · `remove <name>` · `refresh <name>` | 管理目标 |
| `tools <target> [--filter text] [--names]` | 列出工具及其参数签名 |
| `describe <target> <tool>` | 查看完整参数说明 |
| `call <target> <tool> ...` / `<target> <tool> ...` | 调用工具 |
| `auth login\|status\|logout` | OAuth 登录和已保存的凭证 |
| `doctor [targets...]` | 检查连通性和认证状态 |
| `gen skill [targets...]` · `gen shim <target>` | 生成 Agent skill / shell 快捷命令 |

全局选项：`--json`（机器可读的输出和错误）、`--pretty`、`-v/--verbose`（显示 MCP 服务的 stderr）、`-c/--config <path>`。

## 文件

| 路径 | 内容 |
|---|---|
| `./.any2cli.json` 或 `~/.config/any2cli/config.json` | 目标配置（项目内的文件优先；可用 `--config` 或 `ANY2CLI_CONFIG` 覆盖） |
| `~/.config/any2cli/credentials/<target>.json` | OAuth token，文件权限 `0600`，所在目录 `0700` |
| `~/.config/any2cli/cache/<target>.openapi.json` | 编译后的 OpenAPI 清单 |

上传（`@file`）和 `--save` 都不能读写 any2cli 自己的目录和配置文件，因此工具调用无法泄露或覆盖已保存的 token。但 any2cli 不是沙箱：它和 Agent 执行的其他命令一样，以你的用户权限运行。

`ANY2CLI_HOME` 可以整体迁移配置目录；`ANY2CLI_NO_BROWSER=1` 禁止自动打开浏览器；`BROWSER=<command>` 指定使用的浏览器。

## 开发

```sh
pnpm install
pnpm test          # 单元、集成和 CLI 端到端测试（使用真实的 MCP、OAuth 和 HTTP 测试服务）
pnpm coverage
pnpm typecheck
pnpm build         # 生成 dist/cli.js
pnpm dev -- list   # 从源码运行
```

## 许可证

MIT
