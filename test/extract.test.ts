import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extract } from '../src/extract.ts'

test('plain and extended text', () => {
  assert.deepEqual(extract({ conversation: 'hola' }), { type: 'text', text: 'hola' })
  assert.deepEqual(extract({ extendedTextMessage: { text: 'see https://example.com' } }), {
    type: 'text',
    text: 'see https://example.com',
  })
})

test('a reply carries the quoted text, cut at 160 characters', () => {
  const long = 'x'.repeat(200)
  const r = extract({
    extendedTextMessage: { text: 'yes', contextInfo: { quotedMessage: { conversation: long } } },
  })
  assert.equal(r?.text, 'yes')
  assert.equal(r?.quoted, 'x'.repeat(160) + '…')
})

test('media is described, with its caption', () => {
  assert.deepEqual(extract({ imageMessage: { caption: 'the car' } }), { type: 'image', text: '[image] the car' })
  assert.deepEqual(extract({ videoMessage: { gifPlayback: true } }), { type: 'gif', text: '[gif]' })
  assert.deepEqual(extract({ audioMessage: { ptt: true, seconds: 65 } }), { type: 'voice', text: '[voice note 1:05]' })
  assert.deepEqual(extract({ documentMessage: { fileName: 'quote.pdf' } }), {
    type: 'document',
    text: '[document: quote.pdf]',
  })
})

test('wrappers are opened: disappearing messages and messages sent from another device', () => {
  assert.equal(extract({ ephemeralMessage: { message: { conversation: 'gone soon' } } })?.text, 'gone soon')
  assert.equal(extract({ deviceSentMessage: { message: { conversation: 'from my laptop' } } })?.text, 'from my laptop')
})

test('control messages are not stored as something a person wrote', () => {
  assert.equal(extract({ reactionMessage: { text: '👍' } }), undefined)
  assert.equal(extract({ protocolMessage: { type: 0 } }), undefined)
  assert.equal(extract(null), undefined)
})
