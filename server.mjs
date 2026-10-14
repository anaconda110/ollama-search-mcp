#!/usr/bin/env node
/*
 * ollama-search-mcp
 *
 * A dependency-free stdio MCP server that exposes Ollama Cloud's web search and
 * web fetch endpoints as tools, so any MCP client (ZCode, Codex CLI, Claude Code,
 * Cursor, ...) can search the live web without a search backend of its own.
 *
 *   web_search(query, max_results?, max_chars?)  -> ranked results with page text
 *   web_fetch(url, max_chars?)                   -> one page as readable text + links
 *
 * Upstream:
 *   POST https://ollama.com/api/web_search   { query, max_results }
 *   POST https://ollama.com/api/web_fetch    { url }
 * Auth: Authorization: Bearer <Ollama API key>  --  https://ollama.com/settings/keys
 *
 * stdout is reserved for JSON-RPC. Everything else goes to stderr.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tls from 'node:tls'

const HERE = dirname(fileURLToPath(import.meta.url))
const NAME = 'ollama-search-mcp'
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const SEARCH_PATH = '/api/web_search'
const FETCH_PATH = '/api/web_fetch'
const DEFAULTS = { baseUrl: 'https://ollama.com', timeoutMs: 60000, attempts: 3 }

function warn(message) {
  process.stderr.write(`[${NAME}] ${message}\n`)
}

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
    if (pkg.version) return pkg.version
  } catch {
    /* running as a bare copied file */
  }
  return 'dev'
}

const VERSION = readVersion()

// ---------------------------------------------------------------- configuration

function parseArgv(argv) {
  const out = { configPath: undefined, help: false, version: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--version' || arg === '-v') out.version = true
    else if (arg === '--config') out.configPath = argv[i + 1]
    else if (arg.startsWith('--config=')) out.configPath = arg.slice('--config='.length)
    else warn(`ignoring unknown argument: ${arg}`)
  }
  return out
}

function userConfigDir() {
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, NAME)
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, NAME)
  return join(homedir(), '.config', NAME)
}

function configCandidates(cliPath) {
  const list = []
  if (cliPath) list.push({ path: resolve(cliPath), explicit: true })
  if (process.env.OLLAMA_MCP_CONFIG) list.push({ path: resolve(process.env.OLLAMA_MCP_CONFIG), explicit: true })
  list.push({ path: join(HERE, 'config.json'), explicit: false })
  list.push({ path: join(userConfigDir(), 'config.json'), explicit: false })
  return list
}

function loadConfig() {
  const cli = parseArgv(process.argv.slice(2))
  if (cli.help) {
    process.stdout.write(
      `${NAME} ${VERSION} - stdio MCP server for Ollama Cloud web search and web fetch\n\n` +
        `Usage: ${NAME} [--config <path>]\n\n` +
        `This process speaks the Model Context Protocol over stdin/stdout and is meant to be\n` +
        `launched by an MCP client, not by hand. Run it in a terminal only to check for errors.\n\n` +
        `Configuration, lowest to highest precedence:\n` +
        `  1. built-in defaults\n` +
        `  2. config.json next to this file, or in ${join(userConfigDir(), 'config.json')}\n` +
        `  3. a file named by --config or OLLAMA_MCP_CONFIG\n` +
        `  4. environment variables (OLLAMA_API_KEY, OLLAMA_BASE_URL, OLLAMA_MCP_*)\n\n` +
        `See README.md for the full list.\n`
    )
    process.exit(0)
  }
  if (cli.version) {
    process.stdout.write(`${NAME} ${VERSION}\n`)
    process.exit(0)
  }

  let file = {}
  let usedPath = null
  for (const candidate of configCandidates(cli.configPath)) {
    try {
      file = JSON.parse(readFileSync(candidate.path, 'utf8'))
      usedPath = candidate.path
      break
    } catch (err) {
      const isMissing = err.code === 'ENOENT'
      if (candidate.explicit) {
        // The user named this file, so a problem is fatal rather than a fallback.
        warn(isMissing ? `config file not found: ${candidate.path}` : `could not read ${candidate.path}: ${err.message}`)
        process.exit(2)
      }
      if (!isMissing) warn(`ignoring unreadable ${candidate.path}: ${err.message}`)
    }
  }

  const env = process.env
  const cfg = {
    baseUrl: DEFAULTS.baseUrl,
    apiKey: '',
    timeoutMs: DEFAULTS.timeoutMs,
    attempts: DEFAULTS.attempts,
    configPath: usedPath,
  }

  if (typeof file.baseUrl === 'string') cfg.baseUrl = file.baseUrl
  if (typeof file.apiKey === 'string') cfg.apiKey = file.apiKey
  if (Number.isFinite(Number(file.timeoutMs))) cfg.timeoutMs = Number(file.timeoutMs)
  if (Number.isFinite(Number(file.attempts))) cfg.attempts = Number(file.attempts)

  // Environment wins over the file. Blank values are ignored so that an unset-looking
  // shell variable (OLLAMA_API_KEY=) cannot silently wipe a key that is in the file.
  const envValue = (name) => {
    const raw = env[name]
    return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined
  }
  if (envValue('OLLAMA_BASE_URL') !== undefined) cfg.baseUrl = envValue('OLLAMA_BASE_URL')
  if (envValue('OLLAMA_API_KEY') !== undefined) cfg.apiKey = envValue('OLLAMA_API_KEY')
  if (envValue('OLLAMA_MCP_TIMEOUT_MS') !== undefined) cfg.timeoutMs = Number(envValue('OLLAMA_MCP_TIMEOUT_MS'))
  if (envValue('OLLAMA_MCP_ATTEMPTS') !== undefined) cfg.attempts = Number(envValue('OLLAMA_MCP_ATTEMPTS'))

  cfg.baseUrl = String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '')
  cfg.apiKey = String(cfg.apiKey || '').trim()
  cfg.timeoutMs = Number.isFinite(cfg.timeoutMs) ? Math.min(Math.max(cfg.timeoutMs, 1000), 600000) : DEFAULTS.timeoutMs
  cfg.attempts = Number.isFinite(cfg.attempts) ? Math.min(Math.max(Math.trunc(cfg.attempts), 1), 5) : DEFAULTS.attempts
  return cfg
}

const cfg = loadConfig()

// ------------------------------------------------------------- OS trust store
//
// TLS-inspecting security software (Kaspersky, Zscaler, corporate proxies) re-signs
// outbound handshakes with a root that Node's bundled CA store does not know, which
// shows up as intermittent `fetch failed` / SELF_SIGNED_CERT_IN_CHAIN while curl and
// browsers work fine. Merging the OS root store fixes it without disabling
// verification. Best effort: older Node versions simply skip this.
// Set OLLAMA_MCP_TRUST_SYSTEM_CA=0 to opt out.

function trustSystemCertificates() {
  if (process.env.OLLAMA_MCP_TRUST_SYSTEM_CA === '0') return
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return
  try {
    const system = tls.getCACertificates('system')
    if (!Array.isArray(system) || system.length === 0) return
    const merged = [...new Set([...tls.getCACertificates('default'), ...system])]
    tls.setDefaultCACertificates(merged)
  } catch (err) {
    warn(`could not load the OS trust store: ${err.message}`)
  }
}

trustSystemCertificates()

if (!cfg.apiKey) {
  warn(
    `no API key configured. Put one in ${cfg.configPath || join(HERE, 'config.json')}, ` +
      `in ${join(userConfigDir(), 'config.json')}, or set OLLAMA_API_KEY. ` +
      `Keys are free from https://ollama.com/settings/keys`
  )
}

// ------------------------------------------------------------------ upstream

class UpstreamError extends Error {
  constructor(message, { retriable = false, status } = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.retriable = retriable
    this.status = status
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function statusMessage(status, path, body) {
  if (status === 401 || status === 403) {
    return `Ollama rejected the credentials (HTTP ${status}). Check OLLAMA_API_KEY or the apiKey in your config file. ${body}`
  }
  if (status === 404) return `${path} is not available on ${cfg.baseUrl} (HTTP 404). ${body}`
  if (status === 429) return `Ollama rate-limited the request (HTTP 429). ${body}`
  return `${path} -> HTTP ${status}: ${body}`
}

async function callUpstreamOnce(path, payload) {
  let res
  try {
    res = await fetch(cfg.baseUrl + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    })
  } catch (err) {
    const cause = err?.cause?.code || err?.cause?.message || err?.message || 'unknown error'
    throw new UpstreamError(`could not reach ${cfg.baseUrl}${path}: ${cause}`, { retriable: true })
  }

  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new UpstreamError(statusMessage(res.status, path, text.slice(0, 300)), {
      status: res.status,
      retriable: res.status === 429 || res.status >= 500,
    })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new UpstreamError(`${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
}

async function callUpstream(path, payload) {
  if (!cfg.apiKey) {
    throw new UpstreamError(
      `no Ollama API key configured. Set OLLAMA_API_KEY, add "apiKey" to your config file, ` +
        `or create a free key at https://ollama.com/settings/keys`
    )
  }
  let lastError
  for (let attempt = 1; attempt <= cfg.attempts; attempt += 1) {
    try {
      return await callUpstreamOnce(path, payload)
    } catch (err) {
      lastError = err
      if (!err.retriable || attempt === cfg.attempts) throw err
      await sleep(250 * attempt)
    }
  }
  throw lastError
}

// ---------------------------------------------------------------------- tools

function clip(text, maxChars) {
  const s = String(text ?? '')
  if (s.length <= maxChars) return s
  return `${s.slice(0, maxChars)}\n...[truncated, ${s.length - maxChars} more chars]`
}

function num(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

const tools = [
  {
    name: 'web_search',
    title: 'Web search',
    description:
      'Search the live web and get ranked results with title, URL and page text. ' +
      'Use it for current facts, news, releases, pricing or anything past the model cutoff.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
        max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'How many results to return (default 5).' },
        max_chars: { type: 'integer', minimum: 200, description: 'Per-result text budget in characters (default 1500).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'web_fetch',
    title: 'Web fetch',
    description: 'Fetch one URL and return its readable text plus outgoing links. Use it to read a page found by web_search.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
        max_chars: { type: 'integer', minimum: 500, description: 'Total text budget in characters (default 20000).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
]

async function runWebSearch(args) {
  const query = String(args?.query ?? '').trim()
  if (!query) throw new Error('query is required')
  const maxResults = num(args?.max_results, 5, 1, 10)
  const maxChars = num(args?.max_chars, 1500, 200, Number.MAX_SAFE_INTEGER)
  const data = await callUpstream(SEARCH_PATH, { query, max_results: maxResults })
  const results = Array.isArray(data?.results) ? data.results : []
  if (results.length === 0) return `No results for: ${query}`
  const body = results
    .map((r, i) => `${i + 1}. ${r.title || '(untitled)'}\n   ${r.url || ''}\n   ${clip(r.content, maxChars).replace(/\n/g, '\n   ')}`)
    .join('\n\n')
  return `${results.length} result(s) for "${query}":\n\n${body}`
}

async function runWebFetch(args) {
  const url = String(args?.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('url must be an absolute http(s) URL')
  const maxChars = num(args?.max_chars, 20000, 500, Number.MAX_SAFE_INTEGER)
  const data = await callUpstream(FETCH_PATH, { url })
  const links = Array.isArray(data?.links) ? data.links.filter(Boolean) : []
  const parts = [`Title: ${data?.title || '(untitled)'}`, `URL: ${url}`, '', clip(data?.content, maxChars)]
  if (links.length > 0) {
    parts.push('', `Links (${links.length}):`, links.slice(0, 40).map((l) => `- ${l}`).join('\n'))
  }
  return parts.join('\n')
}

const handlers = { web_search: runWebSearch, web_fetch: runWebFetch }

// ---------------------------------------------------------------- MCP plumbing

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendToolText(id, text, isError) {
  sendResult(id, { content: [{ type: 'text', text }], isError })
}

async function handle(message) {
  const { id, method, params } = message
  const isNotification = id === undefined || id === null

  switch (method) {
    case 'initialize': {
      if (isNotification) return
      const asked = params?.protocolVersion
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: VERSION },
      })
      return
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return
    case 'ping':
      if (!isNotification) sendResult(id, {})
      return
    case 'tools/list':
      if (!isNotification) sendResult(id, { tools })
      return
    case 'tools/call': {
      if (isNotification) return
      const handler = handlers[params?.name]
      if (!handler) {
        sendToolText(id, `Unknown tool: ${params?.name}`, true)
        return
      }
      try {
        sendToolText(id, await handler(params?.arguments ?? {}), false)
      } catch (err) {
        sendToolText(id, `${params.name} failed: ${err.message}`, true)
      }
      return
    }
    default:
      if (!isNotification) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
      }
  }
}

let pending = 0
let stdinEnded = false

function drainOrExit() {
  if (stdinEnded && pending === 0) process.exit(0)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue

    let message
    try {
      message = JSON.parse(line)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      continue
    }

    pending += 1
    handle(message)
      .catch((err) => {
        if (message && message.id !== undefined && message.id !== null) {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(err?.message || err) } })
        }
      })
      .finally(() => {
        pending -= 1
        drainOrExit()
      })
  }
})

process.stdin.on('end', () => {
  stdinEnded = true
  drainOrExit()
})
