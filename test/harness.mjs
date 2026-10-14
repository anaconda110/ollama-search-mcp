// Shared harness: spawns server.mjs as a child process and talks JSON-RPC over stdio,
// with OLLAMA_BASE_URL pointed at a stub upstream so tests never hit the network.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SERVER = join(HERE, '..', 'server.mjs')

/** Every server spawned in this process, so a failing test cannot leak a child. */
const spawned = new Set()

/** Kill anything still running; call from a top-level after() hook. */
export function killAll() {
  for (const child of spawned) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  spawned.clear()
}

/** HTTP stub standing in for ollama.com. Routes are keyed by pathname. */
export async function startStub(routes) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let json = null
      try {
        json = JSON.parse(body || '{}')
      } catch {
        /* leave null */
      }
      seen.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: json })
      const route = routes[req.url]
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      res.writeHead(route.status ?? 200, { 'content-type': 'application/json' })
      res.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests: seen,
    close: () =>
      new Promise((r) => {
        // fetch keeps connections alive; without this, close() never resolves.
        server.closeAllConnections?.()
        server.close(r)
      }),
  }
}

/** Spawns the server, returns { call, stderr, exit, stop }. Pass `env: {KEY: undefined}` to unset. */
export function startServer({ baseUrl, env = {}, args = [], configPath } = {}) {
  const argv = [...args, ...(configPath ? ['--config', configPath] : [])]
  const childEnv = {
    ...process.env,
    OLLAMA_API_KEY: 'test-key',
    ...(baseUrl ? { OLLAMA_BASE_URL: baseUrl } : {}),
    ...env,
  }
  for (const key of Object.keys(childEnv)) {
    if (childEnv[key] === undefined) delete childEnv[key]
  }
  const child = spawn(process.execPath, [SERVER, ...argv], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  spawned.add(child)
  child.on('exit', () => spawned.delete(child))

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c) => (stderr += c))

  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))

  let buffer = ''
  const waiters = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
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
        continue
      }
      const waiter = waiters.get(message.id)
      if (waiter) {
        waiters.delete(message.id)
        waiter(message)
      }
    }
  })

  let nextId = 1
  const call = (method, params) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        reject(new Error(`timed out waiting for ${method} (id ${id}); stderr: ${stderr.slice(-400)}`))
      }, 20000)
      waiters.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)

  /** Writes a raw line to the server's stdin (for malformed-input tests). */
  const write = (raw) => child.stdin.write(raw.endsWith('\n') ? raw : `${raw}\n`)

  return {
    call,
    notify,
    write,
    get stderr() {
      return stderr
    },
    exited,
    stop() {
      child.stdin.end()
      return exited
    },
  }
}

export async function initialized(options) {
  const server = startServer(options)
  const init = await server.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  })
  server.notify('notifications/initialized')
  return { server, init }
}
