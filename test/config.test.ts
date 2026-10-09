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

const DEFAULTS = { allowedRecipients: ['*'], confirmBeforeSending: false, autoTranscribe: true, minSecondsBetweenRecipients: 15 }

test('a fresh install sends to anyone without asking, paced 15 s between different people', () => {
  ensureHome()
  assert.deepEqual(loadConfig(), DEFAULTS)
})

test('the data folder and the config are private to the user', () => {
  ensureHome()
  assert.equal(statSync(home).mode & 0o777, 0o700)
  assert.equal(statSync(join(home, 'auth')).mode & 0o777, 0o700)
  assert.equal(statSync(CONFIG_PATH).mode & 0o777, 0o600)
})

test('the confirmation dialog only turns on with an explicit true', () => {
  for (const value of ['true', 1, 'yes', null]) {
    write({ confirmBeforeSending: value })
    assert.equal(loadConfig().confirmBeforeSending, false, String(value))
  }
  write({ confirmBeforeSending: true })
  assert.equal(loadConfig().confirmBeforeSending, true)
})

test('an allowlist that was written but is not a list sends to nobody, not to everybody', () => {
  write({ allowedRecipients: '*' })
  assert.deepEqual(loadConfig().allowedRecipients, [])
  write({ allowedRecipients: [] })
  assert.deepEqual(loadConfig().allowedRecipients, [])
  write({})
  assert.deepEqual(loadConfig().allowedRecipients, ['*'])
})

test('pacing takes any number of seconds from 0 up, and falls back to 15 otherwise', () => {
  for (const [value, expected] of [[0, 0], [30, 30], [2.5, 2.5], [-1, 15], ['10', 15], [null, 15]] as const) {
    write({ minSecondsBetweenRecipients: value })
    assert.equal(loadConfig().minSecondsBetweenRecipients, expected, String(value))
  }
})

test('anything but strings is dropped from the allowlist', () => {
  write({ allowedRecipients: ['56912345678', 42, null, { jid: 'x' }] })
  assert.deepEqual(loadConfig().allowedRecipients, ['56912345678'])
})

test('a broken config falls back to the defaults', () => {
  write('{ not json')
  assert.deepEqual(loadConfig(), DEFAULTS)
})
