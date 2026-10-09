// The user's voice: how they actually write on WhatsApp, learned from their own messages, so that
// what Claude sends as them sounds like them. `pnpm run voice` builds the profile (voice-build.ts);
// the MCP server serves it through style_guide and checks every message against it before sending.
//
// Everything here is measured, not assumed: a rule only exists if the user's own history shows it
// (e.g. "never ends with a period" only when they almost never do).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { HOME } from './config.ts'
import { norm } from './db.ts'

export const VOICE_PATH = join(HOME, 'voice.json')
// The written archetype (`pnpm run voice --narrative`), served next to the numbers.
export const VOICE_NOTES_PATH = join(HOME, 'voice.md')

export type ChatLog = {
  jid: string
  group: boolean
  // Chronological; `me` = written by the user (messages the bridge sent are already left out).
  msgs: { me: boolean; ts: number; text: string; type: string }[]
}

export type Fingerprint = {
  messages: number
  wordsMedian: number
  wordsP90: number
  wordsP99: number
  oneWordShare: number
  // Consecutive messages per turn, counting a gap of up to 10 minutes as the same turn.
  bubblesPerTurn: number
  emojiShare: number
  laughShare: number
  exclamationShare: number
  questionShare: number
  // Share of questions that open with ¿ (Spanish).
  openingQuestionShare: number
  finalPeriodShare: number
  elongationShare: number
  accentsPerWord: number
}

export type ChatVoice = Fingerprint & {
  // Words the user uses a lot elsewhere and never in this chat (e.g. swearing with a client).
  never: string[]
}

export type VoiceProfile = {
  builtAt: string
  global: Fingerprint & {
    contactsAccentsPerWord: number
    emDashShare: number
    semicolonShare: number
    replies: [string, number][]
    openers: [string, number][]
    // Words the user uses far more than the people who write to them.
    signature: string[]
    // Words the people who write to them use often and the user (almost) never does.
    avoid: string[]
    emoji: [string, number][]
    laughs: [string, number][]
  }
  direct: Fingerprint
  groups: Fingerprint
  chats: Record<string, ChatVoice>
}

const TURN_GAP = 600
const PICTOGRAPH = /\p{Extended_Pictographic}/u
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// Whole emoji, so 😶‍🌫️ or 🫶🏼 count once and keep their parts together.
export const emojiOf = (text: string): string[] =>
  [...graphemes.segment(text)].map(g => g.segment).filter(g => PICTOGRAPH.test(g)).map(g => g.replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu, ''))
const ELONGATION = /(\p{L})\1{2,}/u
const ACCENTED = /[áéíóúàèìòùâêôãõç]/i
// Laughter in the languages this is used in most: jaja/jsjs, haha/lol/lmao, kkkk/rsrs, xd.
const LAUGH = /^(?:[ja]*j[ajs]*j[ajs]*|(?:j[aeiou])+j?|(?:h[aei])+h?|k{3,}|(?:rs){2,}|x+d+|lol|lmao|jsj[sj]*)$/i

export const words = (text: string): string[] => norm(text.replace(/https?:\/\/\S+/g, ' ')).match(/[\p{L}\p{N}]+/gu) ?? []
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length
export const isLaugh = (token: string) => token.length >= 2 && LAUGH.test(token) && !/^(?:ha|he|hi|ja|je|ji|jo|ju)$/i.test(token)

// Pastes, links and forwarded templates say nothing about how someone types.
export const isOwnTyping = (text: string) =>
  !!text.trim() && text.length <= 600 && !/^https?:\/\/\S+$/.test(text.trim()) && text.split('\n').length <= 8

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

function fingerprint(texts: string[], turns: number[]): Fingerprint {
  const n = texts.length || 1
  const lens = texts.map(wordCount).sort((a, b) => a - b)
  const share = (fn: (t: string) => boolean) => texts.filter(fn).length / n
  const questions = texts.filter(t => t.includes('?'))
  const allWords = texts.reduce((acc, t) => acc + wordCount(t), 0) || 1
  return {
    messages: texts.length,
    wordsMedian: quantile(lens, 0.5),
    wordsP90: quantile(lens, 0.9),
    wordsP99: quantile(lens, 0.99),
    oneWordShare: share(t => wordCount(t) <= 1),
    bubblesPerTurn: turns.length ? turns.reduce((a, b) => a + b, 0) / turns.length : 1,
    emojiShare: share(t => PICTOGRAPH.test(t)),
    laughShare: share(t => words(t).some(isLaugh)),
    exclamationShare: share(t => t.includes('!')),
    questionShare: questions.length / n,
    openingQuestionShare: questions.length ? questions.filter(t => /[¿]/.test(t)).length / questions.length : 0,
    finalPeriodShare: share(t => /[^.]\.$/.test(t.trim())),
    elongationShare: share(t => ELONGATION.test(t)),
    accentsPerWord: texts.reduce((acc, t) => acc + t.split(/\s+/).filter(w => ACCENTED.test(w)).length, 0) / allWords,
  }
}

// Bubbles per turn: runs of the user's messages with no one else in between and short gaps.
function turnSizes(log: ChatLog): number[] {
  const out: number[] = []
  let run = 0
  let last = 0
  for (const m of log.msgs) {
    if (m.me && run && m.ts - last <= TURN_GAP) run++
    else {
      if (run) out.push(run)
      run = m.me ? 1 : 0
    }
    last = m.ts
  }
  if (run) out.push(run)
  return out
}

const top = <T>(counts: Map<T, number>, n: number): [T, number][] =>
  [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)

function count<T>(items: Iterable<T>): Map<T, number> {
  const m = new Map<T, number>()
  for (const x of items) m.set(x, (m.get(x) ?? 0) + 1)
  return m
}

export function buildProfile(logs: ChatLog[], builtAt = new Date().toISOString()): VoiceProfile {
  const mineOf = (l: ChatLog) => l.msgs.filter(m => m.me && m.type === 'text' && isOwnTyping(m.text)).map(m => m.text)
  const allMine = logs.flatMap(mineOf)
  const theirs = logs.flatMap(l => l.msgs.filter(m => !m.me && m.type === 'text' && isOwnTyping(m.text)).map(m => m.text))
  const turns = logs.flatMap(turnSizes)

  // Vocabulary only from chat-sized messages without links: the rest is mostly invites and pastes.
  const chatSized = (t: string) => wordCount(t) <= 40 && !/https?:\/\//.test(t)
  const myWords = count(allMine.filter(chatSized).flatMap(words))
  const theirWords = count(theirs.filter(chatSized).flatMap(words))
  // In how many chats contacts use a word: one busy group's topic is not how people write.
  const theirSpread = new Map<string, number>()
  for (const l of logs) {
    const here = new Set(l.msgs.filter(m => !m.me && m.type === 'text' && chatSized(m.text)).flatMap(m => words(m.text)))
    for (const w of here) theirSpread.set(w, (theirSpread.get(w) ?? 0) + 1)
  }
  const spread = Math.max(2, Math.round(logs.length * 0.05))
  const myTotal = [...myWords.values()].reduce((a, b) => a + b, 0) || 1
  const theirTotal = [...theirWords.values()].reduce((a, b) => a + b, 0) || 1
  const rate = (m: Map<string, number>, w: string, total: number) => (1000 * (m.get(w) ?? 0)) / total
  const isWord = (w: string) => !/^\d+$/.test(w)
  const overuse = (w: string) => (rate(myWords, w, myTotal) + 0.05) / (rate(theirWords, w, theirTotal) + 0.05)

  const signature = [...myWords.entries()]
    .filter(([w, c]) => c >= 15 && isWord(w))
    .map(([w, c]) => ({ w, c, ratio: overuse(w) }))
    .filter(x => x.ratio >= 4)
    .sort((a, b) => b.c * Math.log(b.ratio) - a.c * Math.log(a.ratio))
    .slice(0, 40)
    .map(x => x.w)
  const avoid = [...theirWords.entries()]
    .filter(([w, c]) => c >= 30 && isWord(w) && (theirSpread.get(w) ?? 0) >= spread)
    .filter(([w]) => rate(theirWords, w, theirTotal) >= 0.3 && rate(myWords, w, myTotal) <= 0.2 * rate(theirWords, w, theirTotal))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([w]) => w)

  const replies = count(allMine.filter(t => wordCount(t) <= 4).map(t => t.trim().toLowerCase()))
  const openers = count(
    logs.flatMap(l => {
      const out: string[] = []
      let last = -Infinity
      for (const m of l.msgs) {
        if (m.ts - last > 4 * 3600 && m.me && m.type === 'text' && isOwnTyping(m.text)) out.push(words(m.text).slice(0, 2).join(' '))
        last = m.ts
      }
      return out.filter(Boolean)
    }),
  )
  const theirsAll = theirs.reduce((acc, t) => acc + wordCount(t), 0) || 1
  const contactsAccentsPerWord = theirs.reduce((acc, t) => acc + t.split(/\s+/).filter(w => ACCENTED.test(w)).length, 0) / theirsAll

  const chats: Record<string, ChatVoice> = {}
  for (const l of logs) {
    const mine = mineOf(l)
    if (mine.length < 30) continue
    const here = count(mine.filter(chatSized).flatMap(words))
    const hereTotal = [...here.values()].reduce((a, b) => a + b, 0)
    // Only chats with enough history can show that a word is absent on purpose, and only words that
    // mark the user's style (they use them clearly more than their contacts): "wn" or "estimado"
    // missing from a chat is a register; a topic word missing is just a topic.
    const never =
      mine.length < 150
        ? []
        : [...myWords.entries()]
            .filter(([w, c]) => c >= 30 && isWord(w) && overuse(w) >= 2 && !here.has(w) && (c / myTotal) * hereTotal >= 5)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 25)
            .map(([w]) => w)
    chats[l.jid] = { ...fingerprint(mine, turnSizes(l)), never }
  }

  return {
    builtAt,
    global: {
      ...fingerprint(allMine, turns),
      contactsAccentsPerWord,
      emDashShare: allMine.filter(t => t.includes('—')).length / (allMine.length || 1),
      semicolonShare: allMine.filter(t => t.includes(';')).length / (allMine.length || 1),
      replies: top(replies, 30),
      openers: top(openers, 15),
      signature,
      avoid,
      emoji: top(count(allMine.flatMap(emojiOf)), 12),
      laughs: top(count(allMine.flatMap(t => words(t).filter(isLaugh))), 10),
    },
    direct: fingerprint(logs.filter(l => !l.group).flatMap(mineOf), logs.filter(l => !l.group).flatMap(turnSizes)),
    groups: fingerprint(logs.filter(l => l.group).flatMap(mineOf), logs.filter(l => l.group).flatMap(turnSizes)),
    chats,
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`

// Things the user doesn't do, as problems to fix before sending. Empty means it sounds like them.
export function lintVoice(parts: string[], p: VoiceProfile, chat?: string, group = false): string[] {
  const issues: string[] = []
  const g = p.global
  const here: Fingerprint & { never?: string[] } = (chat && p.chats[chat]) || (group ? p.groups : p.direct)
  const text = parts.join('\n')
  const tokens = new Set(words(text))

  const maxWords = Math.max(12, Math.ceil(Math.max(here.wordsP99, g.wordsP90) * 1.3))
  if (parts.some(b => wordCount(b) > maxWords)) {
    issues.push(`A message has more than ${maxWords} words; they rarely write that much at once: split it into shorter parts.`)
  }
  if (g.openingQuestionShare < 0.02 && /[¿¡]/.test(text)) issues.push(`Uses ¿ or ¡: they open ${pct(g.openingQuestionShare)} of questions with ¿.`)
  if (g.finalPeriodShare < 0.03 && parts.some(b => /[^.]\.$/.test(b.trim()) && !/https?:\/\/\S+$/.test(b.trim()))) {
    issues.push(`A message ends with a period: they do that in ${pct(g.finalPeriodShare)} of their messages.`)
  }
  if (here.exclamationShare < 0.02 && text.includes('!')) issues.push(`Uses "!": they do in ${pct(here.exclamationShare)} of their messages here.`)
  const emoji = emojiOf(text).length
  if (here.emojiShare < 0.05 && emoji > 1) issues.push(`${emoji} emoji: they use one in ${pct(here.emojiShare)} of their messages.`)
  if (/\*\*|^#{1,6} /m.test(text)) issues.push('Markdown (** or #) does not render on WhatsApp and reads as pasted.')
  if (g.emDashShare < 0.005 && text.includes('—')) issues.push('Em dash (—): they never type it.')
  if (g.semicolonShare < 0.005 && text.includes(';')) issues.push('Semicolon: they never type it.')
  const avoided = g.avoid.filter(w => tokens.has(w))
  if (avoided.length) issues.push(`Words they don't use (their contacts do): ${avoided.join(', ')}.`)
  const never = (here.never ?? []).filter(w => tokens.has(w))
  if (never.length) issues.push(`Words they use elsewhere but never in this chat: ${never.join(', ')}.`)
  const accented = text.split(/\s+/).filter(w => ACCENTED.test(w)).length
  if (g.contactsAccentsPerWord > 0.02 && g.accentsPerWord < 0.3 * g.contactsAccentsPerWord && accented > 2) {
    issues.push('Too many accents: they barely type them.')
  }
  return issues
}

function fingerprintLines(f: Fingerprint): string[] {
  return [
    `- Length: median ${f.wordsMedian} words, 90% under ${f.wordsP90 + 1}; ${pct(f.oneWordShare)} are a single word.`,
    `- ${f.bubblesPerTurn.toFixed(1)} messages per turn on average: split a thought into short parts instead of one block.`,
    `- Laughter in ${pct(f.laughShare)}, emoji in ${pct(f.emojiShare)}, "!" in ${pct(f.exclamationShare)}, ` +
      `stretched words (sooo) in ${pct(f.elongationShare)} of messages.`,
    `- Questions open with ¿ ${pct(f.openingQuestionShare)} of the time; ${pct(f.finalPeriodShare)} of messages end with a period.`,
  ]
}

export function loadVoice(): { profile?: VoiceProfile; notes?: string } {
  const profile = existsSync(VOICE_PATH) ? (JSON.parse(readFileSync(VOICE_PATH, 'utf8')) as VoiceProfile) : undefined
  const notes = existsSync(VOICE_NOTES_PATH) ? readFileSync(VOICE_NOTES_PATH, 'utf8') : undefined
  return { profile, notes }
}

const NOTES_LIMIT = 6000

// What Claude reads before writing as the user: the measured style, the written archetype, how they
// write in this chat, and their own recent messages there.
export function describeVoice(p: VoiceProfile | undefined, notes: string | undefined, chat?: { jid: string; group: boolean; bursts: string[] }): string {
  const lines: string[] = []
  if (!p) {
    lines.push('No writing profile yet. The user can build one with `pnpm run voice` in the wsp-mcp folder. Until then, imitate their recent messages below.')
  } else {
    const g = p.global
    lines.push(`How the user writes on WhatsApp, measured from ${g.messages} of their own messages (built ${p.builtAt.slice(0, 10)}):`)
    lines.push(...fingerprintLines(g))
    if (g.replies.length) lines.push(`- Their usual short replies: ${g.replies.slice(0, 20).map(([r]) => r).join(' · ')}`)
    if (g.signature.length) lines.push(`- Words that are typically theirs: ${g.signature.join(', ')}`)
    if (g.laughs.length) lines.push(`- How they laugh: ${g.laughs.map(([l]) => l).join(', ')}`)
    if (g.emoji.length) lines.push(`- Emoji they use: ${g.emoji.map(([e]) => e).join(' ')}`)
    if (g.avoid.length) lines.push(`- Never use (their contacts do, they don't): ${g.avoid.join(', ')}`)
    if (g.accentsPerWord < 0.3 * g.contactsAccentsPerWord && g.contactsAccentsPerWord > 0.02) lines.push('- They barely type accents.')
  }
  if (notes) {
    lines.push('', 'Their archetype, written from reading their chats:', notes.length > NOTES_LIMIT ? `${notes.slice(0, NOTES_LIMIT)}\n…` : notes)
  }
  if (chat) {
    const here = p?.chats[chat.jid]
    lines.push('')
    if (here) {
      lines.push(`In this chat (${here.messages} of their messages):`, ...fingerprintLines(here))
      if (here.never.length) lines.push(`- Words they use elsewhere but never here: ${here.never.join(', ')}`)
    } else if (p) {
      lines.push(`Little history in this chat; their usual style in ${chat.group ? 'groups' : 'direct chats'}:`, ...fingerprintLines(chat.group ? p.groups : p.direct))
    }
    if (chat.bursts.length) {
      lines.push('', 'Their recent messages in this chat, oldest first (match this tone above all):', ...chat.bursts.map(b => `- ${b}`))
    }
  }
  lines.push('', 'Write in that voice and send it with send_message `parts` (one short message each). Imitate the style, never copy private details from one chat into another.')
  return lines.join('\n')
}

// Credentials, IDs and bare links teach nothing about style and shouldn't travel as examples.
const NOT_EXAMPLE = /https?:\/\/|\S{28,}|api.?key|token|password|contrase|clave|\S+@\S+\.\w+|\d{8,}/i

// Databases from before sent_by_bridge existed get it when the bridge next starts; until then
// nothing can be told apart, and readers (read-only) can't create it.
const notSentByBridge = (db: DatabaseSync) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sent_by_bridge'").get()
    ? 'AND NOT EXISTS (SELECT 1 FROM sent_by_bridge b WHERE b.chat_jid = m.chat_jid AND b.id = m.id)'
    : ''

// The user's own recent messages in a chat, grouped into the bursts they were sent in.
export function ownBursts(db: DatabaseSync, jid: string, limit = 30): string[] {
  const rows = db
    .prepare(
      `SELECT from_me, ts, type, text FROM messages m WHERE chat_jid = ? AND deleted = 0 ${notSentByBridge(db)}
        ORDER BY ts DESC LIMIT ?`,
    )
    .all(jid, limit * 4)
    .reverse()
  const out: string[] = []
  let cur: string[] = []
  let last = 0
  for (const r of rows) {
    const text = String(r.text ?? '')
    const ts = Number(r.ts)
    const usable = r.from_me === 1 && r.type === 'text' && isOwnTyping(text) && text.length <= 300 && !NOT_EXAMPLE.test(text)
    if (!usable || ts - last > TURN_GAP) {
      if (cur.length) out.push(cur.join(' / '))
      cur = []
    }
    if (usable) cur.push(text.replace(/\s*\n\s*/g, ' ⏎ '))
    last = ts
  }
  if (cur.length) out.push(cur.join(' / '))
  return out.slice(-limit)
}

// Every chat as the profile builder needs it, without what the bridge sent for Claude.
export function readLogs(db: DatabaseSync): ChatLog[] {
  const rows = db
    .prepare(
      `SELECT m.chat_jid, m.from_me, m.ts, m.type, m.text, COALESCE(c.is_group, 0) AS is_group
        FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
        WHERE m.deleted = 0 AND m.chat_jid != 'status@broadcast' ${notSentByBridge(db)}
        ORDER BY m.chat_jid, m.ts`,
    )
    .all()
  const logs = new Map<string, ChatLog>()
  for (const r of rows) {
    const jid = String(r.chat_jid)
    let log = logs.get(jid)
    if (!log) logs.set(jid, (log = { jid, group: r.is_group === 1, msgs: [] }))
    log.msgs.push({ me: r.from_me === 1, ts: Number(r.ts), type: String(r.type), text: String(r.text ?? '') })
  }
  return [...logs.values()].filter(l => l.msgs.some(m => m.me))
}
