import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { norm, SCHEMA } from '../src/db.ts'
import { type ChatLog, buildProfile, describeVoice, isLaugh, lintVoice, ownBursts, readLogs } from '../src/voice.ts'

const FRIEND = '56911111111@s.whatsapp.net'
const CLIENT = '56922222222@s.whatsapp.net'
const GROUP = '120363000000000000@g.us'

// Someone who texts in short lowercase bursts, laughs "jajaj", swears with a friend but never with a
// client, and whose contacts write "q", "porfa" and "jeje", which they never do.
function history(): ChatLog[] {
  const friend: ChatLog = { jid: FRIEND, group: false, msgs: [] }
  const client: ChatLog = { jid: CLIENT, group: false, msgs: [] }
  const group: ChatLog = { jid: GROUP, group: true, msgs: [] }
  let ts = 1_790_000_000
  for (let i = 0; i < 200; i++) {
    friend.msgs.push({ me: false, ts: (ts += 60), type: 'text', text: 'q haces porfa jeje' })
    friend.msgs.push({ me: true, ts: (ts += 30), type: 'text', text: 'wena wn' })
    friend.msgs.push({ me: true, ts: (ts += 5), type: 'text', text: 'jajaj dale' })
    client.msgs.push({ me: false, ts: (ts += 60), type: 'text', text: 'hola, q tal? porfa me ayudas jeje' })
    client.msgs.push({ me: true, ts: (ts += 30), type: 'text', text: 'hola estimado lo revisamos' })
    group.msgs.push({ me: true, ts: (ts += 3600), type: 'text', text: 'cabros dale' })
  }
  return [friend, client, group]
}

test('laughter in several languages counts, words that look like it do not', () => {
  for (const l of ['jajaj', 'jajajja', 'ajjaja', 'jsjs', 'haha', 'kkkk', 'xd', 'lol', 'jejeje']) assert.ok(isLaugh(l), l)
  for (const w of ['ja', 'ha', 'hola', 'jamas', 'kiosko']) assert.ok(!isLaugh(w), w)
})

test('the profile measures length, bursts and laughter', () => {
  const p = buildProfile(history(), '2026-10-09T00:00:00Z')
  assert.equal(p.global.messages, 800)
  assert.equal(p.global.wordsMedian, 2)
  assert.equal(p.global.finalPeriodShare, 0)
  assert.ok(p.chats[FRIEND].bubblesPerTurn >= 1.9, 'two messages per turn with the friend')
  assert.ok(p.chats[FRIEND].laughShare > 0.4)
  assert.equal(p.global.laughs[0][0], 'jajaj')
})

test('words the contacts use and the user never does are learned', () => {
  const p = buildProfile(history())
  for (const w of ['q', 'porfa', 'jeje']) assert.ok(p.global.avoid.includes(w), w)
  assert.ok(!p.global.avoid.includes('hola'), 'the user says hola too')
  assert.ok(p.global.signature.includes('wena'))
})

test('a word used everywhere but never in one chat is a rule for that chat', () => {
  const p = buildProfile(history())
  assert.ok(p.chats[CLIENT].never.includes('wn'))
  assert.ok(!p.chats[FRIEND].never.includes('wn'))
})

test('the check passes text in their voice and lists what is unlike them', () => {
  const p = buildProfile(history())
  assert.deepEqual(lintVoice(['wena wn', 'jajaj dale'], p, FRIEND), [])
  const issues = lintVoice(['¿Cómo estás? Te escribo porfa por lo de mañana.'], p, CLIENT)
  assert.ok(issues.some(i => i.includes('¿')))
  assert.ok(issues.some(i => i.includes('period')))
  assert.ok(issues.some(i => i.includes('porfa')))
  assert.ok(lintVoice(['dale wn'], p, CLIENT).some(i => i.includes('never in this chat')))
  assert.ok(lintVoice(['**listo**'], p, FRIEND).some(i => i.includes('Markdown')))
  assert.ok(lintVoice(['uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince'], p, FRIEND).length > 0)
})

test('without a profile the guide still shows their recent messages', () => {
  const text = describeVoice(undefined, undefined, { jid: FRIEND, group: false, bursts: ['wena wn / jajaj dale'] })
  assert.ok(text.includes('pnpm run voice'))
  assert.ok(text.includes('wena wn / jajaj dale'))
})

test('messages the bridge sent are not the user typing', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  db.prepare('INSERT INTO chats (jid, name, is_group) VALUES (?, ?, 0)').run(FRIEND, null)
  const add = db.prepare(`INSERT INTO messages (chat_jid, id, from_me, ts, type, text, text_norm) VALUES (?, ?, ?, ?, 'text', ?, ?)`)
  const msg = (id: string, me: number, ts: number, text: string) => add.run(FRIEND, id, me, ts, text, norm(text))
  msg('a', 0, 1000, 'hola')
  msg('b', 1, 1010, 'wena')
  msg('c', 1, 1015, 'como estai')
  msg('d', 1, 5000, 'Mensaje que escribió Claude.')
  msg('e', 1, 9000, 'mi password es 123456789')
  db.prepare('INSERT INTO sent_by_bridge (chat_jid, id) VALUES (?, ?)').run(FRIEND, 'd')

  assert.deepEqual(ownBursts(db, FRIEND), ['wena / como estai'])
  const [log] = readLogs(db)
  assert.ok(!log.msgs.some(m => m.text.includes('Claude')))
})
