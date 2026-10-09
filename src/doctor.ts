// `pnpm run doctor`: everything that has to be true for Claude to read and send, checked in
// order, each problem with the command that fixes it. It only reads; it changes nothing.
//
// No dependencies beyond Node itself, so it also works before `pnpm install`.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify, styleText } from 'node:util'
import { findBin } from './bin.ts'
import { bridge } from './bridge-client.ts'
import { AUTH_DIR, CONFIG_PATH, DB_PATH, HOME, loadConfig, WHISPER_MODEL } from './config.ts'
import { openReader } from './db.ts'
import { stats } from './queries.ts'

const run = promisify(execFile)

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MCP_ENTRY = join(REPO, 'src', 'mcp.ts')
export const AGENT_PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.whatsapp-mcp.bridge.plist')
export const MENUBAR_PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.whatsapp-mcp.menubar.plist')
export const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin'

export type Level = 'ok' | 'warn' | 'fail' | 'info'
export type Check = { level: Level; title: string; detail?: string; fix?: string }

export const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p)

// Whether a phone has really linked this session. `account` (the device identity the phone signs)
// is only written when the link succeeds, by QR or by code. Neither the file nor `me` will do: the
// file exists from the first QR on, and asking for a pairing code already fills in `me`.
export function isPaired(authDir = AUTH_DIR): boolean {
  try {
    const creds = JSON.parse(readFileSync(join(authDir, 'creds.json'), 'utf8'))
    return !!creds?.account
  } catch {
    return false
  }
}

// Which copy of the code a launchd agent runs, read from its plist.
export function agentTarget(plist: string, suffix: string): string | undefined {
  if (!existsSync(plist)) return
  const xml = readFileSync(plist, 'utf8')
  for (const m of xml.matchAll(/<string>([^<]+)<\/string>/g)) {
    if (m[1].endsWith(suffix)) return m[1]
  }
}

// What Claude Code has registered as "whatsapp", if anything. `claude mcp get` starts the server
// to report its status, hence the generous timeout.
// The server path in the "Args:" line of `claude mcp get`. It starts at the first "/" after a
// space and may itself contain spaces, so splitting on whitespace would cut it.
export const entryFromArgs = (args: string): string | undefined => /(?:^|\s)(\/.*mcp\.ts)\s*$/.exec(args)?.[1]

export function claudeBin(): string | undefined {
  const local = join(homedir(), '.local', 'bin', 'claude')
  return findBin('claude') ?? (existsSync(local) ? local : undefined)
}

export async function claudeRegistration(): Promise<{ cli: boolean; entry?: string; registered: boolean }> {
  const claude = claudeBin()
  if (!claude) return { cli: false, registered: false }
  try {
    const { stdout } = await run(claude, ['mcp', 'get', 'whatsapp'], { timeout: 30_000 })
    const args = /^\s*Args:\s*(.*)$/m.exec(stdout)?.[1] ?? ''
    return { cli: true, registered: true, entry: entryFromArgs(args) }
  } catch {
    return { cli: true, registered: false }
  }
}

// The bridge's connection state, or undefined if no bridge answers on the socket.
export async function bridgeConnection(): Promise<string | undefined> {
  try {
    return String((await bridge('GET', '/status', 2000)).body.connection)
  } catch {
    return undefined
  }
}

export async function runChecks(): Promise<Check[]> {
  const checks: Check[] = []
  const add = (c: Check) => checks.push(c)

  const major = Number(process.versions.node.split('.')[0])
  add(
    major >= 24
      ? { level: 'ok', title: `Node ${process.versions.node}` }
      : { level: 'fail', title: `Node ${process.versions.node} is too old`, fix: 'Install Node 24 or newer (e.g. nvm install 24)' },
  )
  add(
    process.platform === 'darwin'
      ? { level: 'ok', title: 'macOS' }
      : {
          level: 'warn',
          title: `${process.platform} is not supported yet`,
          detail: 'Reading may work, but the send confirmation dialog, the background agent and the menu bar icon are macOS-only.',
        },
  )

  if (!existsSync(join(REPO, 'node_modules', 'baileys'))) {
    add({ level: 'fail', title: 'Dependencies not installed', fix: 'pnpm install' })
  }

  if (!existsSync(HOME)) {
    add({ level: 'fail', title: `No data folder yet (${tilde(HOME)})`, fix: 'pnpm run setup' })
  } else if ((statSync(HOME).mode & 0o077) !== 0) {
    add({ level: 'warn', title: `${tilde(HOME)} can be read by other users`, fix: `chmod 700 ${tilde(HOME)}` })
  } else {
    add({ level: 'ok', title: `Data folder ${tilde(HOME)} (only you can read it)` })
  }

  const paired = isPaired()
  add(
    paired
      ? { level: 'ok', title: 'Phone linked' }
      : { level: 'fail', title: 'No phone linked yet', fix: 'pnpm run setup (or pnpm bridge and scan the QR code)' },
  )

  const connection = await bridgeConnection()
  if (connection) {
    add(
      connection === 'open'
        ? { level: 'ok', title: 'Bridge running and connected to WhatsApp' }
        : { level: 'warn', title: `Bridge running, but the connection is "${connection}"`, fix: 'tail -f ~/.whatsapp-mcp/bridge.log' },
    )
  } else {
    add({
      level: paired ? 'fail' : 'info',
      title: 'Bridge not running',
      detail: 'Stored messages stay readable, but nothing new arrives and nothing can be sent.',
      fix: 'pnpm agent:install (background, starts at login) or pnpm bridge (this terminal)',
    })
  }

  const agent = agentTarget(AGENT_PLIST, '/src/bridge.ts')
  if (!agent) {
    add({
      level: 'info',
      title: 'No background agent: the bridge only runs while `pnpm bridge` is open',
      fix: 'pnpm agent:install',
    })
  } else if (resolve(agent) !== join(REPO, 'src', 'bridge.ts')) {
    add({
      level: 'warn',
      title: 'The background agent runs another copy of this code',
      detail: tilde(agent),
      fix: 'pnpm agent:install (from this folder)',
    })
  } else {
    add({ level: 'ok', title: 'Background agent installed' })
  }

  const db = existsSync(DB_PATH) ? openReader() : undefined
  if (!db) {
    add({ level: paired ? 'warn' : 'info', title: 'No messages stored yet' })
  } else {
    const s = stats(db)
    db.close()
    const n = Number(s.messages ?? 0)
    add(
      n > 0
        ? { level: 'ok', title: `${n.toLocaleString('en-US')} messages in ${s.chats} chats, newest ${s.newest_message}` }
        : { level: 'warn', title: 'The database is empty', detail: 'The first history import can take a few minutes.' },
    )
  }

  const config = loadConfig()
  const media = [
    ['ffmpeg', 'ffmpeg'],
    ['whisper-cli', 'whisper-cpp'],
  ].filter(([bin]) => !findBin(bin))
  if (media.length) {
    add({
      level: 'warn',
      title: `${media.map(([bin]) => bin).join(' and ')} not found`,
      detail: 'Voice notes and videos won’t be transcribed; videos over 16 MB can’t be sent.',
      fix: `brew install ${media.map(([, pkg]) => pkg).join(' ')}`,
    })
  } else {
    add({ level: 'ok', title: 'ffmpeg and whisper.cpp installed' })
  }
  if (existsSync(WHISPER_MODEL)) {
    add({ level: 'ok', title: `Speech model ${tilde(WHISPER_MODEL)}` })
  } else {
    add({
      level: config.autoTranscribe ? 'warn' : 'info',
      title: 'Speech model not downloaded',
      detail: tilde(WHISPER_MODEL),
      fix: 'pnpm run setup (downloads it, ~870 MB)',
    })
  }

  const allowed = config.allowedRecipients
  if (allowed.length === 0) {
    add({ level: 'info', title: 'Sending is off: nobody is in allowedRecipients', fix: `Add numbers or chat ids to ${tilde(CONFIG_PATH)}` })
  } else if (allowed.some(a => a.trim() === '*')) {
    add({ level: 'warn', title: 'Sending is allowed to anyone ("*")', fix: `List the recipients instead in ${tilde(CONFIG_PATH)}` })
  } else {
    add({ level: 'ok', title: `Sending allowed to ${allowed.length} recipient${allowed.length === 1 ? '' : 's'}` })
  }
  if (!config.confirmBeforeSending) {
    add({
      level: 'warn',
      title: 'Messages go out without the confirmation dialog',
      fix: `Remove "confirmBeforeSending": false from ${tilde(CONFIG_PATH)}`,
    })
  }

  const reg = await claudeRegistration()
  if (!reg.cli) {
    add({ level: 'warn', title: 'Claude Code CLI not found', fix: 'https://claude.com/claude-code' })
  } else if (!reg.registered) {
    add({ level: 'fail', title: 'Not registered with Claude Code', fix: 'pnpm run setup' })
  } else if (reg.entry && resolve(reg.entry) !== MCP_ENTRY) {
    add({
      level: 'warn',
      title: 'Claude Code runs another copy of this server',
      detail: tilde(reg.entry),
      fix: 'pnpm run setup (offers to point it here)',
    })
  } else {
    add({ level: 'ok', title: 'Registered with Claude Code as "whatsapp"' })
  }

  return checks
}

const MARK: Record<Level, string> = {
  ok: styleText('green', '✓'),
  warn: styleText('yellow', '!'),
  fail: styleText('red', '✗'),
  info: styleText('cyan', 'i'),
}

export function printChecks(checks: Check[]): void {
  for (const c of checks) {
    console.log(`  ${MARK[c.level]} ${c.title}`)
    if (c.detail) console.log(styleText('dim', `      ${c.detail}`))
    if (c.fix) console.log(`      → ${c.fix}`)
  }
  const fails = checks.filter(c => c.level === 'fail').length
  const warns = checks.filter(c => c.level === 'warn').length
  console.log()
  console.log(
    fails || warns
      ? `${fails} problem${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}.`
      : 'All good.',
  )
}

// Run as a script (`pnpm run doctor`), not when setup imports it.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(styleText('bold', 'wsp-mcp doctor\n'))
  const checks = await runChecks()
  printChecks(checks)
  if (checks.some(c => c.level === 'fail')) process.exitCode = 1
}
