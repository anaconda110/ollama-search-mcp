import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initialized, killAll, startServer, startStub } from './harness.mjs'

const SEARCH = '/api/web_search'
const FETCH = '/api/web_fetch'

const searchBody = {
  results: [
    { title: 'First', url: 'https://example.com/a', content: 'alpha '.repeat(200) },
    { title: '', url: 'https://example.com/b', content: null },
  ],
}
const fetchBody = { title: 'Doc', content: 'body text', links: ['https://example.com/x', null, 'https://example.com/y'] }

const stub = await startStub({
  [SEARCH]: { body: searchBody },
  [FETCH]: { body: fetchBody },
})
after(() => {
  killAll()
  return stub.close()
})

describe('protocol', () => {
  it('answers initialize with a supported protocol version and server info', async () => {
    const { server, init } = await initialized({ baseUrl: stub.baseUrl })
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.equal(init.result.serverInfo.name, 'ollama-search-mcp')
    assert.equal(typeof init.result.serverInfo.version, 'string')
    await server.stop()
  })

  it('echoes an older protocol version the client asked for', async () => {
    const server = startServer({ baseUrl: stub.baseUrl })
    const res = await server.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    assert.equal(res.result.protocolVersion, '2024-11-05')
    await server.stop()
  })

  it('falls back for an unknown protocol version', async () => {
    const server = startServer({ baseUrl: stub.baseUrl })
    const res = await server.call('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    assert.equal(res.result.protocolVersion, '2025-06-18')
    await server.stop()
  })

  it('lists both tools with input schemas', async () => {
    const { server } = await initialized({ baseUrl: stub.baseUrl })
    const res = await server.call('tools/list')
    const names = res.result.tools.map((t) => t.name)
    assert.deepEqual(names, ['web_search', 'web_fetch'])
    for (const tool of res.result.tools) {
      assert.equal(tool.inputSchema.type, 'object')
      assert.ok(Array.isArray(tool.inputSchema.required))
      assert.ok(tool.inputSchema.required.length > 0)
    }
    await server.stop()
  })

  it('answers ping', async () => {
    const { server } = await initialized({ baseUrl: stub.baseUrl })
    const res = await server.call('ping')
    assert.deepEqual(res.result, {})
    await server.stop()
  })

  it('returns a JSON-RPC error for an unknown method', async () => {
    const { server } = await initialized({ baseUrl: stub.baseUrl })
    const res = await server.call('resources/list')
    assert.equal(res.error.code, -32601)
    await server.stop()
  })

  it('reports malformed JSON as a parse error without dying', async () => {
    const server = startServer({ baseUrl: stub.baseUrl })
    const init = await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    assert.equal(init.result.serverInfo.name, 'ollama-search-mcp')

    server.write('this is not json')
    // A parse error is emitted with a null id, so it never resolves a pending call;
    // the server must survive it and keep answering.
    const res = await server.call('ping')
    assert.deepEqual(res.result, {})
    await server.stop()
  })

  it('exits cleanly when stdin closes', async () => {
    const { server } = await initialized({ baseUrl: stub.baseUrl })
    const { code } = await server.stop()
    assert.equal(code, 0)
  })
})

describe('web_search', () => {
  it('formats results and forwards the query upstream with auth', async () => {
    const { server } = await initialized({ baseUrl: stub.baseUrl })
    const res = await server.call('tools/call', { name: 'web_search', arguments: { query: 'hello world', max_results: 2 } })
    const text = res.result.content[0].text
    assert.equal(res.result.isError, false)
    assert.match(text, /2 result\(s\) for "hello world"/)
    assert.match(text, /1\. First/)
    assert.match(text, /https:\/\/example\.com\/a/)
    assert.match(text, /2\. \(untitled\)/)

    const upstream = stub.requests.at(-1)
    assert.equal(upstream.path, SEARCH)
    assert.equal(upstream.body.query, 'hello world')
    assert.equal(upstream.body.max_results, 2)
    assert.equal(upstream.auth, 'Bearer test-key')
    await server.stop()
  })

  it('clamps max_results into 1..10 instead of letting upstream reject it', async () => {
    const { server } = await initialized({ baseUrl: stub.baseUrl })
    await server.call('tools/call', { name: 'web_search', arguments: { query: 'x', max_results: 99 } })
    assert.equal(stub.requests.at(-1).body.max_results, 10)
    await server.call('tools/call', { name: 'web_search', arguments: { query: 'x', max_results: 0 } })
    assert.equal(stub.requests.at(-1).body.max_results, 1)
    await server.call('tools/call', { name: 'web_search', arguments: { query: 'x' } })
    assert.equal(stub.requests.at(-1).body.max_results, 5)
    await server.stop()
  })

  it('truncates long content at max_chars', async () => {
    const { server } = await initialized({ baseUrl: stub.baseUrl })
    const res = await server.call('tools/call', { name: 'web_search', arguments: { query: 'x', max_chars: 200 } })
    const text = res.result.content[0].text
    assert.match(text, /truncated, \d+ more chars/)
    await server.stop()
  })

  it('reports a missing query as a tool error, not a crash', async () => {
    const { server } = await initialized({ baseUrl: stub.baseUrl })
    const res = await server.call('tools/call', { name: 'web_search', arguments: { query: '   ' } })
    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /query is required/)
    await server.stop()
  })

  it('handles an empty result set', async () => {
    const empty = await startStub({ [SEARCH]: { body: { results: [] } } })
    try {
      const { server } = await initialized({ baseUrl: empty.baseUrl })
      const res = await server.call('tools/call', { name: 'web_search', arguments: { query: 'nothing' } })
      assert.match(res.result.content[0].text, /No results for: nothing/)
      await server.stop()
    } finally {
      await empty.close()
    }
  })

  it('tolerates a response without a results array', async () => {
    const weird = await startStub({ [SEARCH]: { body: { unexpected: true } } })
    try {
      const { server } = await initialized({ baseUrl: weird.baseUrl })
      const res = await server.call('tools/call', { name: 'web_search', arguments: { query: 'q' } })
      assert.equal(res.result.isError, false)
      assert.match(res.result.content[0].text, /No results for: q/)
      await server.stop()
    } finally {
      await weird.close()
    }
  })
})

describe('web_fetch', () => {
  it('returns title, text and de-duplicated links', async () => {
    const { server } = await initialized({ baseUrl: stub.baseUrl })
    const res = await server.call('tools/call', { name: 'web_fetch', arguments: { url: 'https://example.com/doc' } })
    const text = res.result.content[0].text
    assert.equal(res.result.isError, false)
    assert.match(text, /Title: Doc/)
    assert.match(text, /body text/)
    assert.match(text, /Links \(2\)/)
    assert.equal(stub.requests.at(-1).body.url, 'https://example.com/doc')
    await server.stop()
  })

  it('rejects non-http URLs before calling upstream', async () => {
    const before = stub.requests.length
    const { server } = await initialized({ baseUrl: stub.baseUrl })
    const res = await server.call('tools/call', { name: 'web_fetch', arguments: { url: 'ftp://example.com' } })
    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /absolute http\(s\) URL/)
    assert.equal(stub.requests.length, before)
    await server.stop()
  })
})

describe('failure handling', () => {
  it('explains a 401 as a credential problem', async () => {
    const bad = await startStub({ [SEARCH]: { status: 401, body: { error: 'unauthorized' } } })
    try {
      const { server } = await initialized({ baseUrl: bad.baseUrl })
      const res = await server.call('tools/call', { name: 'web_search', arguments: { query: 'q' } })
      assert.equal(res.result.isError, true)
      assert.match(res.result.content[0].text, /credentials/)
      await server.stop()
    } finally {
      await bad.close()
    }
  })

  it('does not retry a 4xx that is not retriable', async () => {
    const bad = await startStub({ [SEARCH]: { status: 400, body: { error: 'bad' } } })
    try {
      const { server } = await initialized({ baseUrl: bad.baseUrl })
      await server.call('tools/call', { name: 'web_search', arguments: { query: 'q' } })
      assert.equal(bad.requests.length, 1)
      await server.stop()
    } finally {
      await bad.close()
    }
  })

  it('retries a 500 up to `attempts`', async () => {
    const flaky = await startStub({ [SEARCH]: { status: 503, body: { error: 'unavailable' } } })
    try {
      const { server } = await initialized({ baseUrl: flaky.baseUrl, env: { OLLAMA_MCP_ATTEMPTS: '3' } })
      const res = await server.call('tools/call', { name: 'web_search', arguments: { query: 'q' } })
      assert.equal(res.result.isError, true)
      assert.equal(flaky.requests.length, 3)
      await server.stop()
    } finally {
      await flaky.close()
    }
  })

  it('reports an unreachable upstream without hanging', async () => {
    // port 9 (discard) on loopback: connection refused immediately
    const { server } = await initialized({ baseUrl: 'http://127.0.0.1:9', env: { OLLAMA_MCP_ATTEMPTS: '1' } })
    const res = await server.call('tools/call', { name: 'web_search', arguments: { query: 'q' } })
    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /could not reach/)
    await server.stop()
  })

  it('rejects a non-JSON body', async () => {
    const html = await startStub({ [SEARCH]: { body: '<html>nope</html>' } })
    try {
      const { server } = await initialized({ baseUrl: html.baseUrl })
      const res = await server.call('tools/call', { name: 'web_search', arguments: { query: 'q' } })
      assert.equal(res.result.isError, true)
      assert.match(res.result.content[0].text, /non-JSON/)
      await server.stop()
    } finally {
      await html.close()
    }
  })

  it('warns on stderr but stays usable when no key is configured', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ollama-search-mcp-nokey-')), 'no-key.json')
    writeFileSync(path, JSON.stringify({ baseUrl: stub.baseUrl }))
    const server = startServer({ configPath: path, env: { OLLAMA_API_KEY: '' } })
    await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    const res = await server.call('tools/call', { name: 'web_search', arguments: { query: 'q' } })
    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /no Ollama API key configured/)
    assert.match(server.stderr, /no API key configured/)
    await server.stop()
  })

  it('lists an unknown tool as a tool error', async () => {
    const { server } = await initialized({ baseUrl: stub.baseUrl })
    const res = await server.call('tools/call', { name: 'nope', arguments: {} })
    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /Unknown tool: nope/)
    await server.stop()
  })
})

describe('configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ollama-search-mcp-'))

  it('prefers environment variables over the config file', async () => {
    const path = join(dir, 'env-wins.json')
    writeFileSync(path, JSON.stringify({ baseUrl: 'http://127.0.0.1:9', apiKey: 'from-file' }))
    const { server } = await initialized({ baseUrl: stub.baseUrl, configPath: path })
    await server.call('tools/call', { name: 'web_search', arguments: { query: 'q' } })
    assert.equal(stub.requests.at(-1).auth, 'Bearer test-key')
    await server.stop()
  })

  it('falls back to the config file when the environment is silent', async () => {
    const path = join(dir, 'from-file.json')
    writeFileSync(path, JSON.stringify({ baseUrl: stub.baseUrl, apiKey: 'file-key' }))
    const server = startServer({ configPath: path, env: { OLLAMA_API_KEY: '', OLLAMA_BASE_URL: '' } })
    await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    await server.call('tools/call', { name: 'web_search', arguments: { query: 'q' } })
    assert.equal(stub.requests.at(-1).auth, 'Bearer file-key')
    await server.stop()
  })

  it('exits with 2 when an explicitly named config file is missing', async () => {
    const server = startServer({ baseUrl: stub.baseUrl, args: ['--config', join(dir, 'does-not-exist.json')] })
    const { code } = await server.exited
    assert.equal(code, 2)
  })

  it('prints help and version without starting the protocol loop', async () => {
    for (const flag of ['--help', '--version']) {
      const server = startServer({ baseUrl: stub.baseUrl, args: [flag] })
      const { code } = await server.exited
      assert.equal(code, 0)
    }
  })
})
