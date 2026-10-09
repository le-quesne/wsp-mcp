import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paceDelay } from '../src/pace.ts'

const ANA = '5491133334444@s.whatsapp.net'
const PEDRO = '56911111111@s.whatsapp.net'

test('the first message goes out right away', () => {
  assert.equal(paceDelay(undefined, ANA, 1_000_000, 15_000), 0)
})

test('a message to someone else waits until 15 s after the previous one', () => {
  const last = { chat: ANA, at: 1_000_000 }
  assert.equal(paceDelay(last, PEDRO, 1_000_000 + 4_000, 15_000), 11_000)
  assert.equal(paceDelay(last, PEDRO, 1_000_000 + 15_000, 15_000), 0)
  assert.equal(paceDelay(last, PEDRO, 1_000_000 + 60_000, 15_000), 0)
})

test('replies in the same chat are not held', () => {
  assert.equal(paceDelay({ chat: ANA, at: 1_000_000 }, ANA, 1_000_000 + 1_000, 15_000), 0)
})

test('0 turns pacing off', () => {
  assert.equal(paceDelay({ chat: ANA, at: 1_000_000 }, PEDRO, 1_000_000, 0), 0)
})
