import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { forgetUnfinishedLink, pairingCodeIn, pairWithCode, phoneDigits } from '../src/pair.ts'

test('phone numbers become digits, and nonsense is refused', () => {
  assert.equal(phoneDigits('+56 9 1234 5678'), '56912345678')
  assert.equal(phoneDigits('(+54) 9 11 3333-4444'), '5491133334444')
  assert.equal(phoneDigits('1234'), undefined)
  assert.equal(phoneDigits('my number'), undefined)
})

test('the pairing code is read from the bridge log line', () => {
  assert.equal(pairingCodeIn('[10:02:11] Pairing code: ABCD-EF12'), 'ABCD-EF12')
  assert.equal(pairingCodeIn('[10:02:11] Pairing code: ABCDEF12'), 'ABCDEF12')
  assert.equal(pairingCodeIn('[10:02:11] Connected as Ana (+56912345678).'), undefined)
})

// A stand-in for the bridge: prints what the real one prints, and "links" by creating a file.
function fakeBridge(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'wsp-mcp-pair-'))
  const linked = join(dir, 'linked')
  return {
    command: process.execPath,
    args: ['-e', `const fs = require('node:fs'); const LINKED = ${JSON.stringify(linked)}; ${script}`],
    cwd: dir,
    isPaired: () => existsSync(linked),
  }
}

test('shows the code, waits for the link, lets the history import settle, then stops the bridge', async () => {
  const codes: string[] = []
  const bridge = fakeBridge(`
    console.log('Pairing code: WXYZ-1234')
    setTimeout(() => fs.writeFileSync(LINKED, ''), 300)
    setTimeout(() => console.log('History sync: +500 messages'), 1300)
    setInterval(() => {}, 1000)
  `)
  const result = await pairWithCode({ ...bridge, onCode: c => codes.push(c), quietMs: 400, syncCapMs: 10_000 })
  assert.equal(result, 'paired')
  assert.deepEqual(codes, ['WXYZ-1234'])
})

test('a new code replaces the earlier one', async () => {
  const codes: [string, boolean][] = []
  const bridge = fakeBridge(`
    console.log('Pairing code: AAAA-1111')
    console.log('Pairing code: AAAA-1111')
    setTimeout(() => console.log('Pairing code: BBBB-2222'), 100)
    setTimeout(() => fs.writeFileSync(LINKED, ''), 200)
    setInterval(() => {}, 1000)
  `)
  await pairWithCode({ ...bridge, onCode: (c, again) => codes.push([c, again]), quietMs: 200 })
  assert.deepEqual(codes, [['AAAA-1111', false], ['BBBB-2222', true]])
})

test('gives up when nobody types the code', async () => {
  const bridge = fakeBridge(`console.log('Pairing code: WXYZ-1234'); setInterval(() => {}, 1000)`)
  assert.equal(await pairWithCode({ ...bridge, onCode: () => {}, pairTimeoutMs: 500 }), 'timeout')
})

test('reports a bridge that stops before linking', async () => {
  const bridge = fakeBridge(`console.error('Another bridge is already running.'); process.exit(1)`)
  const lines: string[] = []
  assert.equal(await pairWithCode({ ...bridge, onCode: () => {}, onLine: l => lines.push(l) }), 'exited')
  assert.deepEqual(lines, ['Another bridge is already running.'])
})

test('a history import that never goes quiet is still cut off', async () => {
  const bridge = fakeBridge(`
    fs.writeFileSync(LINKED, '')
    setInterval(() => console.log('History sync: +10 messages'), 100)
  `)
  const started = Date.now()
  assert.equal(await pairWithCode({ ...bridge, onCode: () => {}, quietMs: 500, syncCapMs: 2000 }), 'paired')
  assert.ok(Date.now() - started < 6000)
})

test('an unfinished code request is forgotten, a linked session is kept', () => {
  const pending = { registered: false, pairingCode: 'WXYZ1234', me: { id: '56912345678@s.whatsapp.net', name: '~' } }
  assert.equal(forgetUnfinishedLink(pending), true)
  assert.equal(pending.me, undefined)
  assert.equal(pending.pairingCode, undefined)

  const linked = { account: { details: 'x' }, me: { id: '56912345678:12@s.whatsapp.net' } }
  assert.equal(forgetUnfinishedLink(linked), false)
  assert.deepEqual(linked.me, { id: '56912345678:12@s.whatsapp.net' })

  assert.equal(forgetUnfinishedLink({}), false, 'a fresh session has nothing to forget')
})
