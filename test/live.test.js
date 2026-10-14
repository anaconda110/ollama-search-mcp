// Live tests against the real Ollama Cloud API. Skipped unless a key is present.
//
//   OLLAMA_API_KEY=... node --test test/live.test.js
//
// Kept out of `npm test` on purpose: these hit the network and consume the account's
// quota (Ollama documents no search quota, but this should never be part of CI).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { killAll, startServer } from './harness.mjs'

const apiKey = process.env.OLLAMA_API_KEY
const baseUrl = process.env.OLLAMA_BASE_URL

describe('live upstream', { skip: apiKey ? false : 'set OLLAMA_API_KEY to run these' }, () => {
  const boot = async () => {
    const server = startServer({ baseUrl, env: { OLLAMA_API_KEY: apiKey } })
    await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live', version: '1' } })
    return server
  }

  it('returns real search results with urls', async () => {
    const server = await boot()
    const res = await server.call('tools/call', { name: 'web_search', arguments: { query: 'Ollama web search API', max_results: 3 } })
    await server.stop()
    assert.equal(res.result.isError, false, res.result.content[0].text)
    const text = res.result.content[0].text
    assert.match(text, /result\(s\) for/)
    assert.match(text, /https?:\/\//)
  })

  it('fetches a page as readable text', async () => {
    const server = await boot()
    const res = await server.call('tools/call', { name: 'web_fetch', arguments: { url: 'https://example.com', max_chars: 1000 } })
    await server.stop()
    assert.equal(res.result.isError, false, res.result.content[0].text)
    assert.match(res.result.content[0].text, /Example Domain/i)
  })

  it('survives a burst of parallel searches', async () => {
    const server = await boot()
    const calls = Array.from({ length: 6 }, (_, i) =>
      server.call('tools/call', { name: 'web_search', arguments: { query: `burst ${i}`, max_results: 1, max_chars: 300 } })
    )
    const results = await Promise.all(calls)
    await server.stop()
    const failures = results.filter((r) => r.result.isError)
    assert.equal(failures.length, 0, failures.map((f) => f.result.content[0].text).join(' | '))
  })

  it('rejects a bad key instead of pretending to work', async () => {
    const server = startServer({ baseUrl, env: { OLLAMA_API_KEY: 'definitely-not-a-real-key' } })
    await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live', version: '1' } })
    const res = await server.call('tools/call', { name: 'web_search', arguments: { query: 'x' } })
    await server.stop()
    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /401|403|credentials/)
  })
})

process.on('exit', killAll)
