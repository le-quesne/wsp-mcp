import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAllowed } from '../src/allow.ts'

const PERSON = '56912345678@s.whatsapp.net'
const GROUP = '120363000000000000@g.us'
const canon = (jid: string) => (jid === '99999@lid' ? PERSON : jid)

test('an empty allowlist sends to nobody', () => {
  assert.equal(isAllowed(PERSON, [], canon), false)
})

test('"*" sends to anyone', () => {
  assert.equal(isAllowed(PERSON, ['*'], canon), true)
  assert.equal(isAllowed(GROUP, [' * '], canon), true)
})

test('a phone number matches in any formatting', () => {
  for (const entry of ['56912345678', '+56 9 1234 5678', '(+56) 9-1234-5678']) {
    assert.equal(isAllowed(PERSON, [entry], canon), true, entry)
  }
})

test('a phone number must match whole, not as a suffix or prefix', () => {
  assert.equal(isAllowed(PERSON, ['12345678'], canon), false)
  assert.equal(isAllowed(PERSON, ['569123456789'], canon), false)
})

test('a phone number never matches a group', () => {
  assert.equal(isAllowed(GROUP, ['120363000000000000'], canon), false)
})

test('a group is allowed by its exact chat id', () => {
  assert.equal(isAllowed(GROUP, [GROUP], canon), true)
  assert.equal(isAllowed(GROUP, ['120363000000000001@g.us'], canon), false)
})

test('a LID entry matches the chat stored under its phone number', () => {
  assert.equal(isAllowed(PERSON, ['99999@lid'], canon), true)
})

test('entries with no digits allow nothing', () => {
  assert.equal(isAllowed(PERSON, ['', '   ', 'mom'], canon), false)
})
