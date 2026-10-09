import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { forgetUnfinishedLink, logFollower, pairingCodeIn, phoneDigits, watchPairing } from '../src/pair.ts'

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

// The log as the background bridge would write it, a piece per poll.
function fakeLog(pieces: string[], linkAfter = Infinity) {
  let polls = 0
  return {
    readNew: () => pieces[polls++] ?? '',
    isPaired: () => polls > linkAfter,
  }
}

test('shows the code and returns once the phone accepts it', async () => {
  const codes: [string, boolean][] = []
  const log = fakeLog(['[10:00:01] Pairing code: WXYZ-1234\n', '', '[10:00:40] Connected as Ana\n'], 2)
  const result = await watchPairing({ ...log, onCode: (c, again) => codes.push([c, again]), pollMs: 5 })
  assert.equal(result, 'paired')
  assert.deepEqual(codes, [['WXYZ-1234', false]])
})

test('a new code replaces the earlier one, and a repeated line is not a new code', async () => {
  const codes: [string, boolean][] = []
  const log = fakeLog(['Pairing code: AAAA-1111\nPairing code: AAAA-1111\n', 'Pairing code: BBBB-2222\n'], 2)
  await watchPairing({ ...log, onCode: (c, again) => codes.push([c, again]), pollMs: 5 })
  assert.deepEqual(codes, [['AAAA-1111', false], ['BBBB-2222', true]])
})

test('a line split across two reads is read whole', async () => {
  const codes: string[] = []
  const log = fakeLog(['[10:00:01] Pairing co', 'de: WXYZ-1234\n'], 2)
  await watchPairing({ ...log, onCode: c => codes.push(c), pollMs: 5 })
  assert.deepEqual(codes, ['WXYZ-1234'])
})

test('gives up when nobody types the code', async () => {
  const log = fakeLog(['Pairing code: WXYZ-1234\n'])
  assert.equal(await watchPairing({ ...log, onCode: () => {}, timeoutMs: 100, pollMs: 10 }), 'timeout')
})

test('stops waiting when the bridge says it cannot link', async () => {
  const lines: string[] = []
  const log = fakeLog(['Another bridge is already running (/tmp/x.sock).\n'])
  const result = await watchPairing({ ...log, onCode: () => {}, onLine: l => lines.push(l), pollMs: 5 })
  assert.equal(result, 'failed')
  assert.deepEqual(lines, ['Another bridge is already running (/tmp/x.sock).'])
})

test('the log is read from where it ended, then only what is new', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wsp-mcp-log-')), 'bridge.log')
  writeFileSync(path, 'old line from yesterday\n')
  const readNew = logFollower(path)
  assert.equal(readNew(), '')
  appendFileSync(path, 'Pairing code: WXYZ-1234\n')
  assert.equal(readNew(), 'Pairing code: WXYZ-1234\n')
  assert.equal(readNew(), '')
  assert.equal(logFollower(join(tmpdir(), 'no-such-dir', 'bridge.log'))(), '')
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
