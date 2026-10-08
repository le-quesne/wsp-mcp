import assert from 'node:assert/strict'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// config.ts reads WA_MCP_HOME when it's imported, so point it at a scratch folder first.
const home = mkdtempSync(join(tmpdir(), 'wsp-mcp-test-'))
process.env.WA_MCP_HOME = home
const { CONFIG_PATH, ensureHome, loadConfig } = await import('../src/config.ts')

const write = (value: unknown) => writeFileSync(CONFIG_PATH, typeof value === 'string' ? value : JSON.stringify(value))

test('a fresh install can send to nobody and asks before sending', () => {
  ensureHome()
  assert.deepEqual(loadConfig(), { allowedRecipients: [], confirmBeforeSending: true, autoTranscribe: true })
})

test('the data folder and the config are private to the user', () => {
  ensureHome()
  assert.equal(statSync(home).mode & 0o777, 0o700)
  assert.equal(statSync(join(home, 'auth')).mode & 0o777, 0o700)
  assert.equal(statSync(CONFIG_PATH).mode & 0o777, 0o600)
})

test('the confirmation dialog only turns off with an explicit false', () => {
  for (const value of ['false', 0, null, 'no']) {
    write({ confirmBeforeSending: value })
    assert.equal(loadConfig().confirmBeforeSending, true, String(value))
  }
  write({ confirmBeforeSending: false })
  assert.equal(loadConfig().confirmBeforeSending, false)
})

test('anything but strings is dropped from the allowlist', () => {
  write({ allowedRecipients: ['56912345678', 42, null, { jid: 'x' }] })
  assert.deepEqual(loadConfig().allowedRecipients, ['56912345678'])
  write({ allowedRecipients: '*' })
  assert.deepEqual(loadConfig().allowedRecipients, [])
})

test('a broken config falls back to the safe defaults', () => {
  write('{ not json')
  assert.deepEqual(loadConfig(), { allowedRecipients: [], confirmBeforeSending: true, autoTranscribe: true })
})
