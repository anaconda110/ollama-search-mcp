# ollama-search-mcp

A dependency-free [MCP](https://modelcontextprotocol.io) server that gives any MCP client —
Claude Code, Codex CLI, ZCode, Cursor, Cline, Zed — two tools:

- **`web_search`** — search the live web, get ranked results with title, URL and page text
- **`web_fetch`** — read one URL as clean text, plus its outgoing links

It is a thin wrapper around [Ollama's web search and web fetch APIs](https://docs.ollama.com/capabilities/web-search).
Ollama ships those as plain REST endpoints; this turns them into tools your agent can call.

```
your agent  ──stdio/JSON-RPC──▶  ollama-search-mcp  ──HTTPS──▶  ollama.com/api/web_{search,fetch}
```

- **One file, zero dependencies.** No `npm install`, no build step, no transitive supply chain.
- **Any MCP client.** Plain stdio JSON-RPC; nothing client-specific.
- **Free.** A free Ollama account includes the search API. No credit card, unlike most search APIs.
- **Search *and* read.** Results come back with page text already attached, and `web_fetch` reads
  any URL — the pair covers most grounding needs without a second vendor.

> Scope: this is an independent community project. It is not affiliated with or endorsed by Ollama.
> It talks to Ollama's public API with your own key, and you are subject to their terms and quotas.

## Requirements

- Node.js **20+** (24+ recommended: it can read the OS trust store, which matters behind TLS-inspecting antivirus — see [Troubleshooting](#troubleshooting))
- A free Ollama API key: <https://ollama.com/settings/keys>

## Install

### 1. Get a key

Create one at <https://ollama.com/settings/keys>. It looks like a long random string.

### 2. Add the server to your client

Two ways in: run the published package through `npx`, or point your client at a local checkout.
Either way the key comes from `OLLAMA_API_KEY` or a config file (see [Configuration](#configuration)).

#### From npm (recommended)

Claude Code — `--scope user` matters, since the default `local` scope would confine the server to
the directory you ran the command in:

```bash
claude mcp add --scope user ollama-search -e OLLAMA_API_KEY=your-key-here \
  -- npx -y ollama-search-mcp
```

Codex CLI:

```bash
codex mcp add ollama-search --env OLLAMA_API_KEY=your-key-here \
  -- npx -y ollama-search-mcp
```

Any client with a JSON config file:

```json
{
  "mcpServers": {
    "ollama-search": {
      "command": "npx",
      "args": ["-y", "ollama-search-mcp"],
      "env": { "OLLAMA_API_KEY": "your-key-here" }
    }
  }
}
```

On Windows, if the client cannot find `npx`, write `cmd /c npx -y ollama-search-mcp` instead, or
use the local-checkout form below.

#### From a local checkout

The same three clients, pointed at `server.mjs` in a clone of this repo. On Windows, use the full
path to `node.exe` (`C:\Program Files\nodejs\node.exe`) and double the backslashes in JSON.

##### Claude Code

```bash
claude mcp add --scope user ollama-search -e OLLAMA_API_KEY=your-key-here \
  -- node /absolute/path/to/server.mjs
```

##### Codex CLI

```bash
codex mcp add ollama-search --env OLLAMA_API_KEY=your-key-here \
  -- node /absolute/path/to/server.mjs
```

##### Any client with a JSON config file

```json
{
  "mcpServers": {
    "ollama-search": {
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"],
      "env": { "OLLAMA_API_KEY": "your-key-here" }
    }
  }
}
```

On Windows, use the full path to `node.exe` (`C:\Program Files\nodejs\node.exe`) and double the
backslashes in JSON.

### 3. Verify

```bash
OLLAMA_API_KEY=your-key-here node test/live.test.js   # or: npm run test:live
```

A healthy run prints four passing tests. If your client shows the server as failed, run `server.mjs`
by hand — it prints a plain-English diagnostic to **stderr** (stdout is reserved for JSON-RPC):

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | node server.mjs
```

## Configuration

Everything is optional; the defaults work with only an API key.

| Setting | Default | Environment variable | Meaning |
|---|---|---|---|
| `baseUrl` | `https://ollama.com` | `OLLAMA_BASE_URL` | Upstream host. Point it at a proxy if you have one. |
| `apiKey` | *(none)* | `OLLAMA_API_KEY` | Your Ollama key. Required. |
| `timeoutMs` | `60000` | `OLLAMA_MCP_TIMEOUT_MS` | Per-request timeout. |
| `attempts` | `3` | `OLLAMA_MCP_ATTEMPTS` | Tries per request, for connection-level failures and 429/5xx. 1–5. |

Resolution order, lowest to highest precedence:

1. built-in defaults
2. `config.json` next to `server.mjs`
3. `config.json` in your user config dir (`%APPDATA%\ollama-search-mcp\`, or `~/.config/ollama-search-mcp/`)
4. the file named by `--config <path>` or `OLLAMA_MCP_CONFIG`
5. environment variables

Blank environment variables are ignored, so `OLLAMA_API_KEY=` (an unset-looking shell variable)
cannot silently wipe a key that is in the file.

Copy [`config.example.json`](config.example.json) to `config.json` to use a file. **`config.json`
is gitignored** — keep real keys out of version control.

Two extra switches: `OLLAMA_MCP_TRUST_SYSTEM_CA=0` disables the OS trust store merge, and
`--help` / `--version` print usage without starting the protocol loop.

## Tools

### `web_search`

| Argument | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | Required. Natural language. |
| `max_results` | integer 1–10 | `5` | Clamped, because upstream errors on out-of-range values instead of clamping. |
| `max_chars` | integer ≥200 | `1500` | Per-result text budget; longer bodies end with `...[truncated, N more chars]`. |

Returns a numbered list of `title / url / text`. Raised to 10 results with the default budget, a
response is around 15k characters — comfortable for any modern context window.

### `web_fetch`

| Argument | Type | Default | Notes |
|---|---|---|---|
| `url` | string | — | Required. Absolute `http(s)` URL only. |
| `max_chars` | integer ≥500 | `20000` | Total text budget for the page. |

Returns the page title, its text, and up to 40 outgoing links. Handles HTML pages and PDFs.

Both tools are read-only and annotated as such (`readOnlyHint`, `openWorldHint`), so clients can
auto-approve them without a permission prompt.

### Typical agent loop

```
1. web_search("latest release notes for <project>")   → finds the right page
2. web_fetch("<that url>")                            → reads it in full
3. answer, citing the URL
```

Search results already carry page text, so step 2 is only needed when the snippet is truncated.

## Troubleshooting

### Intermittent `could not reach …: SELF_SIGNED_CERT_IN_CHAIN`

**This is the most likely failure you will hit, and it is not a bug in this server.** If a
TLS-inspecting antivirus or corporate proxy (Kaspersky, Zscaler, Netskope, …) is installed, it
re-signs *some* outbound handshakes with its own root. Browsers and curl trust that root because
they use the OS store; Node uses its own bundled list, so a fraction of requests fail while the
rest succeed — typically 30–70%, which looks exactly like flaky networking.

Check it:

```bash
echo | openssl s_client -connect ollama.com:443 2>/dev/null | grep -E '^ *[0-9]+ s:'
# a chain mentioning Kaspersky / Zscaler / your AV  =  intercepted
```

Fixes, applied automatically where possible:

1. `server.mjs` merges the OS trust store into the process at startup
   (`tls.getCACertificates('system')` → `setDefaultCACertificates`). Node 24+. Nothing to configure.
2. Add `--use-system-ca` to the command in your client config (Node 22.9+). Belt and braces.
3. Requests already retry `attempts` times on connection-level errors.

Measured on an affected machine: 3/10 success before, 12/12 after. If you still see it, raise
`attempts`, and check that your client config still passes `--use-system-ca` after upgrades.

Do **not** "fix" this with `NODE_TLS_REJECT_UNAUTHORIZED=0` — that disables certificate
verification entirely instead of trusting the right root.

### `no Ollama API key configured`

The key is not reaching the process. Environment variables set in one shell do not propagate into
GUI-launched clients, so put the key in the config file, or in the `env` block of your client's
MCP config. Run with `--config /path/to/config.json` to be explicit.

### `Ollama rejected the credentials (HTTP 401)`

Key revoked or wrong. Note that Ollama has separate keys for the cloud API and for local
`ollama serve`; you want one from <https://ollama.com/settings/keys>.

### The tool never appears in the client

Check the client's own MCP status (`claude mcp list`, `codex mcp get <name>`, or the client's log).
Most clients bind their tool list when a session starts, so an already-open session will not see a
newly added server — start a new one. Claude Code's default `local` scope is per-directory; use
`--scope user`.

### Server shows as failed on Windows

Use the absolute path to `node.exe`, and if you go through a `.cmd` shim, quote it. Paths with
spaces must be quoted in the client config.

## Development

```bash
npm test              # 30 unit tests, offline, ~5s (stub upstream, no network)
npm run test:live     # 4 tests against the real API, needs OLLAMA_API_KEY
```

The unit suite spawns the real server as a child process and talks JSON-RPC to it over stdio, with
a local HTTP stub standing in for ollama.com — so it covers the actual protocol surface, not just
internal functions. It asserts the wire format, argument clamping, truncation, retry policy
(non-retriable 4xx is called once; 5xx is retried), config precedence, and that no failure path
kills the process.

Layout:

```
server.mjs             the whole server
config.example.json    copy to config.json (gitignored)
test/harness.mjs       stdio client + HTTP stub
test/server.test.js    offline suite
test/live.test.js      network suite
```

## Notes and limitations

- **No search quota is documented.** In testing, serial and parallel bursts (4 at once, 2×3 rounds)
  all returned 200 with identical bodies. Treat it as unmetered but unguaranteed; your account's
  limits, if any, apply.
- **Upstream shapes are used as-is.** `web_search` expects `{results:[{title,url,content}]}`;
  `web_fetch` expects `{title,content,links}`. If Ollama changes these, the tools return a clear
  error rather than silently degrading.
- **No image/video/news verticals**, no domain filters, no date ranges — Ollama's endpoints do not
  offer them. `web_search` results are general web pages.
- **`web_fetch` is a plain fetch.** Pages behind a login or heavy bot protection will not render.
- **Not an MCP "search provider"** in the host-app sense: some clients (Claude Desktop, ChatGPT)
  only accept their own first-party search. This works in clients that let you add MCP servers.

## License

MIT — see [LICENSE](LICENSE).

中文说明见 [README.zh-CN.md](README.zh-CN.md)。
