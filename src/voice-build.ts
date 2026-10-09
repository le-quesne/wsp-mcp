// `pnpm run voice`: learns how you write from your own messages and saves it to ~/.whatsapp-mcp/voice.json,
// so Claude writes like you (style_guide) and send_message catches what you'd never write.
//
//   pnpm run voice                      measure your style (local, nothing leaves your Mac)
//   pnpm run voice --narrative          also have Claude read a sample of your chats and write your
//                                       archetype to voice.md (uses Claude Code; sends that sample to Anthropic)
//   pnpm run voice --narrative --model opus
//
// Run it again every few months: the way people text drifts.
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findBin } from './bin.ts'
import { openReader } from './db.ts'
import { displayName, fmtTime } from './queries.ts'
import { type ChatLog, type VoiceProfile, VOICE_NOTES_PATH, VOICE_PATH, buildProfile, isOwnTyping, readLogs } from './voice.ts'

const SESSION_GAP = 2 * 3600
// How many of your messages Claude reads for the archetype, and the most from any one chat.
const SAMPLE_OWN = 1500
const PER_CHAT_SHARE = 0.12

const args = process.argv.slice(2)
const narrative = args.includes('--narrative')
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'sonnet'

const db = openReader()
if (!db) {
  console.error('No WhatsApp data yet: link your phone first (pnpm run setup).')
  process.exit(1)
}

const logs = readLogs(db)
const profile = buildProfile(logs)
if (profile.global.messages < 200) {
  console.error(`Only ${profile.global.messages} messages of yours are stored: wait for the history import to finish, or write more first.`)
  process.exit(1)
}
writeFileSync(VOICE_PATH, JSON.stringify(profile, null, 1) + '\n', { mode: 0o600 })

const g = profile.global
const pct = (x: number) => `${Math.round(x * 100)}%`
console.log(`Learned from ${g.messages} of your messages in ${logs.length} chats (${Object.keys(profile.chats).length} with their own profile).`)
console.log(`  median ${g.wordsMedian} words · ${pct(g.oneWordShare)} one word · ${g.bubblesPerTurn.toFixed(1)} messages per turn`)
console.log(`  emoji ${pct(g.emojiShare)} · laughter ${pct(g.laughShare)} · "!" ${pct(g.exclamationShare)} · final period ${pct(g.finalPeriodShare)}`)
if (g.signature.length) console.log(`  yours: ${g.signature.slice(0, 15).join(', ')}`)
if (g.avoid.length) console.log(`  never: ${g.avoid.slice(0, 15).join(', ')}`)
console.log(`Saved to ${VOICE_PATH}.`)

if (narrative) await writeNarrative(logs, profile)
else if (!existsSync(VOICE_NOTES_PATH)) console.log('Add --narrative to also get a written archetype (Claude reads a sample of your chats).')

// Whole conversations at random, so Claude sees how you answer, not just isolated lines.
function sample(logs: ChatLog[]): string {
  const sessions: { log: ChatLog; msgs: ChatLog['msgs'] }[] = []
  for (const log of logs) {
    let cur: ChatLog['msgs'] = []
    for (const m of log.msgs) {
      if (cur.length && m.ts - cur[cur.length - 1].ts > SESSION_GAP) {
        sessions.push({ log, msgs: cur })
        cur = []
      }
      cur.push(m)
    }
    if (cur.length) sessions.push({ log, msgs: cur })
  }
  const useful = sessions.filter(s => s.msgs.filter(m => m.me && m.type === 'text').length >= 3)
  for (let i = useful.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[useful[i], useful[j]] = [useful[j], useful[i]]
  }
  const perChat = new Map<string, number>()
  const cap = Math.ceil(SAMPLE_OWN * PER_CHAT_SHARE)
  const picked: typeof useful = []
  let own = 0
  for (const s of useful) {
    const msgs = s.msgs.slice(-80)
    const n = msgs.filter(m => m.me).length
    if ((perChat.get(s.log.jid) ?? 0) + n > cap) continue
    perChat.set(s.log.jid, (perChat.get(s.log.jid) ?? 0) + n)
    picked.push({ log: s.log, msgs })
    own += n
    if (own >= SAMPLE_OWN) break
  }
  return picked
    .map(({ log, msgs }) => {
      const name = displayName(db!, log.jid) ?? (log.group ? 'a group' : 'a contact')
      const lines = msgs.map(m => {
        const body = m.type === 'text' ? m.text.replace(/\n/g, ' ⏎ ') : `[${m.type}]`
        if (m.me) return `${fmtTime(m.ts).slice(11)} ME: ${isOwnTyping(m.text) ? body.slice(0, 500) : '[pasted text]'}`
        return `${fmtTime(m.ts).slice(11)} THEM: ${body.slice(0, 160)}`
      })
      return `### ${name} (${log.group ? 'group' : 'direct'}) · ${fmtTime(msgs[0].ts).slice(0, 10)}\n${lines.join('\n')}`
    })
    .join('\n\n')
}

async function writeNarrative(logs: ChatLog[], p: VoiceProfile): Promise<void> {
  const claude = findBin('claude') ?? join(homedir(), '.local/bin/claude')
  if (!existsSync(claude)) {
    console.error('--narrative needs Claude Code (the `claude` command). Install it, or skip --narrative.')
    process.exit(1)
  }
  const prompt = `You are a sociolinguist. Below are measurements of how one person ("ME") writes on WhatsApp, and a random sample of their real conversations. Write their texting archetype so that another model can write messages that are indistinguishable from theirs.

Output Markdown only, in the language they write in, in this order:
1. "## Rules" — at most 30 short lines: the concrete rules to write like them (length and splitting into several messages, capitalization, punctuation, laughter, emoji, signature words and phrases, words to avoid, how formality changes by audience). This section is read before every message, so make every line count.
2. "## Archetype" — a name for their style and a one-paragraph portrait.
3. "## By audience" — how they write to each kind of person you can tell apart (work, clients, friends, partner, family, groups…): tone, openers, closers, address terms, what disappears.
4. "## How they…" — short subsections with verbatim examples: agree, say no, ask for things, apologize, joke, show affection, react to news, schedule.
5. "## Never" — what would immediately sound unlike them.
6. "## Examples" — 25 to 40 verbatim messages or short bursts (join a burst with " / "), each with a 3–6 word context label, covering the audiences above.

The measurements are authoritative where they speak: never present a word from "avoid" as theirs, and don't contradict the shares. Quote ONLY the ME lines, exactly as typed (typos included). Leave out phone numbers, emails, addresses, passwords, money details and anything intimate about other people.

Measurements (shares are of their messages):
${JSON.stringify({ global: { ...p.global, replies: p.global.replies.slice(0, 20) }, direct: p.direct, groups: p.groups }, null, 1)}

Conversations (ME = them; THEM = whoever they're talking to):
${sample(logs)}`

  console.log(`Asking Claude (${model}) to write your archetype from a sample of your chats…`)
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      claude,
      ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config',
        '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'project', '--disallowedTools', 'Bash,Write,Edit,Read,WebFetch,WebSearch'],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    )
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d))
    child.on('error', reject)
    child.on('close', code => {
      try {
        const r = JSON.parse(out)
        if (code !== 0 || r.is_error) reject(new Error(String(r.result ?? `exit ${code}`)))
        else resolve(String(r.result))
      } catch {
        reject(new Error(`claude exited with ${code}`))
      }
    })
    child.stdin.end(prompt)
  })
  writeFileSync(VOICE_NOTES_PATH, text.trim() + '\n', { mode: 0o600 })
  console.log(`Archetype saved to ${VOICE_NOTES_PATH}. Read it, and edit anything that isn't you: Claude reads it before writing as you.`)
}
