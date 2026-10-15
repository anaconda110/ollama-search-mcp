# ollama-search-mcp

一个零依赖的 [MCP](https://modelcontextprotocol.io) 服务器，给任何支持 MCP 的客户端（Claude Code、
Codex CLI、ZCode、Cursor、Cline、Zed……）加两个工具：

- **`web_search`** —— 搜索实时网页，返回标题、链接和正文摘要
- **`web_fetch`** —— 把一个 URL 读成干净文本，附带出链

它包装的是 [Ollama 的 web search / web fetch 接口](https://docs.ollama.com/capabilities/web-search)。
Ollama 只把它们当普通 REST 接口提供，这个项目把它变成 agent 能直接调用的工具。

```
你的 agent  ──stdio/JSON-RPC──▶  ollama-search-mcp  ──HTTPS──▶  ollama.com/api/web_{search,fetch}
```

- **单文件、零依赖**：不用 `npm install`，没有构建步骤，没有供应链风险。
- **任何 MCP 客户端**：纯 stdio JSON-RPC，不带任何客户端特有的东西。
- **免费**：免费 Ollama 账号就能用搜索接口，不需要绑卡（多数搜索 API 都要绑卡）。
- **搜索 + 阅读**：搜索结果本身带正文，`web_fetch` 能读任意页面，两个工具基本覆盖日常查证需求。

> 声明：这是独立的社区项目，与 Ollama 官方无关。它用你自己的 key 调用 Ollama 的公开接口，
> 受其服务条款和额度约束。

## 环境要求

- Node.js **20+**（推荐 24+：能读取系统证书库，这在本机装了 TLS 拦截型杀软时很关键，见[疑难排查](#疑难排查)）
- 一个免费的 Ollama API key：<https://ollama.com/settings/keys>

## 安装

### 1. 拿 key

到 <https://ollama.com/settings/keys> 新建一个。key 是长随机字符串。

### 2. 把服务器加进客户端

两条路：跑 npm 上发布好的包（客户端用 `npx` 拉取），或者指向本地检出的 `server.mjs`。
key 的来源都是 `OLLAMA_API_KEY` 环境变量或配置文件（见[配置](#配置)）。

#### 从 npm 安装（推荐）

Claude Code —— `--scope user` 不能省，默认的 `local` scope 会把服务器限制在你执行命令的那个目录里：

```bash
claude mcp add --scope user ollama-search -e OLLAMA_API_KEY=你的key \
  -- npx -y ollama-search-mcp
```

Codex CLI：

```bash
codex mcp add ollama-search --env OLLAMA_API_KEY=你的key \
  -- npx -y ollama-search-mcp
```

任何用 JSON 配置的客户端：

```json
{
  "mcpServers": {
    "ollama-search": {
      "command": "npx",
      "args": ["-y", "ollama-search-mcp"],
      "env": { "OLLAMA_API_KEY": "你的key" }
    }
  }
}
```

Windows 上如果客户端找不到 `npx`，写成 `cmd /c npx -y ollama-search-mcp`，或者用下面的本地检出方式。

#### 从本地检出

同样的三个客户端，改成指向 clone 下来的 `server.mjs`。Windows 上把 `node` 写成 `node.exe`
的完整路径（`C:\Program Files\nodejs\node.exe`），JSON 里的反斜杠要写成双反斜杠。

##### Claude Code

```bash
claude mcp add --scope user ollama-search -e OLLAMA_API_KEY=你的key \
  -- node /绝对路径/server.mjs
```

##### Codex CLI

```bash
codex mcp add ollama-search --env OLLAMA_API_KEY=你的key \
  -- node /绝对路径/server.mjs
```

##### 任何用 JSON 配置的客户端

```json
{
  "mcpServers": {
    "ollama-search": {
      "command": "node",
      "args": ["/绝对路径/server.mjs"],
      "env": { "OLLAMA_API_KEY": "你的key" }
    }
  }
}
```

Windows 上把 `node` 写成 `node.exe` 的完整路径（`C:\Program Files\nodejs\node.exe`），
JSON 里的反斜杠要写成双反斜杠。

### 3. 验证

```bash
OLLAMA_API_KEY=你的key node test/live.test.js   # 等价于 npm run test:live
```

四条测试全过就是好的。如果客户端里显示服务器失败，手动跑一次 `server.mjs`——它会往
**stderr** 打人话诊断（stdout 被 JSON-RPC 占用）：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | node server.mjs
```

## 配置

全部可选，只给一个 key 也能跑。

| 配置项 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|
| `baseUrl` | `https://ollama.com` | `OLLAMA_BASE_URL` | 上游地址，可以指到自己的代理 |
| `apiKey` | 无 | `OLLAMA_API_KEY` | 你的 Ollama key，必填 |
| `timeoutMs` | `60000` | `OLLAMA_MCP_TIMEOUT_MS` | 单次请求超时 |
| `attempts` | `3` | `OLLAMA_MCP_ATTEMPTS` | 每个请求的尝试次数（连接类失败与 429/5xx 会重试），1–5 |

生效顺序（后者覆盖前者）：

1. 内置默认值
2. `server.mjs` 同目录的 `config.json`
3. 用户配置目录的 `config.json`（`%APPDATA%\ollama-search-mcp\` 或 `~/.config/ollama-search-mcp/`）
4. `--config <路径>` 或 `OLLAMA_MCP_CONFIG` 指定的文件
5. 环境变量

**空的环境变量会被忽略**，所以 `OLLAMA_API_KEY=`（看起来像"没设"的 shell 变量）不会把配置文件里的
key 悄悄抹掉。

要改用配置文件就把 [`config.example.json`](config.example.json) 复制成 `config.json`。
**`config.json` 已在 .gitignore 里**——真 key 别进版本库。

另外两个开关：`OLLAMA_MCP_TRUST_SYSTEM_CA=0` 关掉系统证书库合并；`--help` / `--version`
只打印用法，不进入协议循环。

## 工具

### `web_search`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | — | 必填，自然语言 |
| `max_results` | 整数 1–10 | `5` | 会被钳制——上游对越界值直接报错而不是截断 |
| `max_chars` | 整数 ≥200 | `1500` | 单条结果正文上限，超长结尾标 `...[truncated, N more chars]` |

返回编号列表：标题 / 链接 / 正文。取满 10 条并按默认预算，一次响应约 15k 字符，现代上下文窗口都吃得下。

### `web_fetch`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | — | 必填，只接受绝对 `http(s)` URL |
| `max_chars` | 整数 ≥500 | `20000` | 整页文本上限 |

返回页面标题、正文、最多 40 条出链。HTML 和 PDF 都能处理。

两个工具都是只读的，并声明了对应的注解（`readOnlyHint`、`openWorldHint`），
客户端可以免确认自动放行。

### 典型 agent 用法

```
1. web_search("某项目最新发布说明")   → 定位到正确页面
2. web_fetch("<那个 url>")            → 读全文
3. 给出结论并附链接
```

搜索结果自带正文，所以只有摘要被截断时才需要第 2 步。

## 疑难排查

### 间歇性 `could not reach …: SELF_SIGNED_CERT_IN_CHAIN`

**这是最容易踩的坑，而且不是本项目的 bug。** 如果机器上装了 TLS 拦截型杀软或企业代理
（卡巴斯基、Zscaler、Netskope……），它会替换**一部分**出站握手的证书。浏览器和 curl 走系统证书库，
所以能信任那个根；Node 用自己内置的证书列表，于是**一部分请求失败、一部分成功**——通常 30%~70%，
看起来跟"网络抖动"一模一样。

先确认：

```bash
echo | openssl s_client -connect ollama.com:443 2>/dev/null | grep -E '^ *[0-9]+ s:'
# 链里出现 Kaspersky / Zscaler / 你的杀软名  =  被中间人了
```

修法（能自动的已自动化）：

1. `server.mjs` 启动时把系统证书库并进进程（`tls.getCACertificates('system')` →
   `setDefaultCACertificates`），Node 24+，无需配置
2. 在客户端配置的命令里加 `--use-system-ca`（Node 22.9+），双保险
3. 请求本身已按 `attempts` 对连接类错误重试

在受影响的机器上实测：修之前 10 次成功 3 次，修之后 12 次全成。若仍然出现，调大 `attempts`，
并检查客户端配置在升级后是否还带着 `--use-system-ca`。

**不要**用 `NODE_TLS_REJECT_UNAUTHORIZED=0` "解决"这个问题——那是彻底关掉证书校验，
而正确做法是信任正确的根。

### `no Ollama API key configured`

key 没送到进程。在一个 shell 里设的环境变量不会传播给 GUI 启动的客户端，
所以把 key 写进配置文件或客户端的 MCP `env` 块里。也可以用 `--config /路径/config.json` 显式指定。

### `Ollama rejected the credentials (HTTP 401)`

key 被吊销或者用错了。注意 Ollama 的云端接口和本地 `ollama serve` 是两套 key，
你要的是 <https://ollama.com/settings/keys> 这里的。

### 客户端里根本看不到这个工具

先看客户端自己的 MCP 状态（`claude mcp list`、`codex mcp get <name>`，或客户端日志）。
多数客户端在会话启动时就固定了工具列表，所以已经开着的会话看不到新加的服务器——新开一个会话。
Claude Code 默认的 `local` scope 是按目录生效的，用 `--scope user`。

### Windows 上显示服务器启动失败

用 `node.exe` 的绝对路径；如果经过 `.cmd` 包装脚本，注意加引号。路径里有空格必须在客户端配置里加引号。

## 开发

```bash
npm test              # 30 个离线单测，约 5 秒（本地 stub 上游，不联网）
npm run test:live     # 4 个真接口测试，需要 OLLAMA_API_KEY
```

单测会把真正的服务器拉起成子进程，用 stdio 跟它讲 JSON-RPC，同时用一个本地 HTTP stub 顶替
ollama.com——所以覆盖的是真实协议面，而不是只测内部函数。断言内容包括报文格式、参数钳制、
截断、重试策略（不可重试的 4xx 只调一次，5xx 会重试）、配置优先级，以及任何失败路径都不会把进程搞死。

目录结构：

```
server.mjs             全部实现
config.example.json    复制成 config.json 用（已 gitignore）
test/harness.mjs       stdio 客户端 + HTTP stub
test/server.test.js    离线测试
test/live.test.js      联网测试
```

## 已知边界

- **官方没有公布搜索额度**。实测串行、并发（同时 4 个、2×3 轮）全部 200 且响应体一致。
  当它不限量，但别当保证——账号自身若有上限则以账号为准。
- **上游返回结构原样使用**：`web_search` 期望 `{results:[{title,url,content}]}`，
  `web_fetch` 期望 `{title,content,links}`。Ollama 改了结构会明确报错，不会静默降级。
- **没有图片/视频/新闻垂直搜索**，没有域名过滤、没有时间范围——Ollama 的接口不提供这些。
  `web_search` 返回的是普通网页结果。
- **`web_fetch` 就是普通抓取**，需要登录或强反爬的页面读不到。
- **不是宿主 App 意义上的"搜索引擎接入"**：有些客户端（Claude 桌面版、ChatGPT）只认自家的一方搜索。
  本项目适用于允许自行添加 MCP 服务器的客户端。

## 许可证

MIT，见 [LICENSE](LICENSE)。

English docs: [README.md](README.md)。
