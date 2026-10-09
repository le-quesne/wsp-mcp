// `pnpm run setup`: from a fresh clone to Claude reading your WhatsApp. Every step checks first
// and skips what's already done, so it's safe to run again. It asks before installing anything;
// `--yes` answers yes to every question. Without a terminal to ask in, it installs nothing and
// prints what it would have run.
//
// `--phone <number>` links the phone with a code instead of a QR, so the whole setup also runs
// where there's no terminal, like when Claude Code runs it:
//   pnpm run setup --yes --phone +56912345678
//
// No dependencies beyond Node itself: it's what runs `pnpm install`.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { styleText } from 'node:util'
import { findBin } from './bin.ts'
import { logFollower, phoneDigits, watchPairing } from './pair.ts'
import { CONFIG_PATH, ensureHome, HOME, loadConfig, WHISPER_MODEL } from './config.ts'
import {
  AGENT_PLIST,
  agentDataDir,
  agentTarget,
  bridgeConnection,
  claudeBin,
  claudeRegistration,
  isPaired,
  MCP_ENTRY,
  MENUBAR_PLIST,
  MODEL_URL,
  printChecks,
  REPO,
  runChecks,
  tilde,
} from './doctor.ts'

const YES = process.argv.includes('--yes') || process.argv.includes('-y')
const PHONE = (() => {
  const i = process.argv.indexOf('--phone')
  if (i > 0) return process.argv[i + 1] ?? ''
  return process.argv.find(a => a.startsWith('--phone='))?.slice('--phone='.length)
})()
const INTERACTIVE = process.stdin.isTTY && process.stdout.isTTY

const say = (text = '') => console.log(text)
const done = (text: string) => say(`  ${styleText('green', '✓')} ${text}`)
const skip = (text: string) => say(`  ${styleText('yellow', '–')} ${text}`)
const step = (n: number, title: string) => say(`\n${styleText('bold', `${n}. ${title}`)}`)

async function ask(question: string, byDefault: boolean): Promise<boolean> {
  if (YES) return true
  if (!INTERACTIVE) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question(`  ${question} ${byDefault ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
  rl.close()
  return answer ? answer.startsWith('y') : byDefault
}

// Runs a command in this terminal, so its prompts and progress bars work.
const quote = (arg: string) => (/[\s'"]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg)

function sh(cmd: string, args: string[]): boolean {
  say(styleText('dim', `  $ ${[cmd, ...args].map(quote).join(' ')}`))
  return spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO }).status === 0
}

// A step the user declined, or that couldn't ask: say what to run later.
function later(what: string, command: string): void {
  skip(`${what}${INTERACTIVE || YES ? '' : ' (no terminal to ask in)'}. Later: ${command}`)
}

if (process.platform !== 'darwin') {
  say('Setup is macOS-only for now: the send dialog and the background agent are Mac-specific.')
  say('See the README for running the bridge and the MCP server by hand.')
  process.exit(1)
}

say(styleText('bold', 'wsp-mcp setup'))
say('Every step checks first and skips what is already done.')

step(1, 'Dependencies')
if (existsSync(join(REPO, 'node_modules', 'baileys'))) done('Installed')
else if (!sh('pnpm', ['install', '--frozen-lockfile'])) {
  say('  pnpm install failed. Fix that first, then run setup again.')
  process.exit(1)
}

step(2, 'Voice note transcription (ffmpeg + whisper.cpp)')
const missing = (
  [
    ['ffmpeg', 'ffmpeg'],
    ['whisper-cli', 'whisper-cpp'],
  ] as const
).filter(([bin]) => !findBin(bin))
if (!missing.length) done('Installed')
else {
  const pkgs = missing.map(([, pkg]) => pkg)
  // By its path: Homebrew's folder isn't always on PATH.
  const brew = findBin('brew')
  if (!brew) later(`Missing ${pkgs.join(', ')} and Homebrew isn't installed`, `brew install ${pkgs.join(' ')}`)
  else if (await ask(`Install ${pkgs.join(' and ')} with Homebrew? Voice notes are transcribed on this Mac.`, true)) {
    sh(brew, ['install', ...pkgs])
  } else later('Skipped', `brew install ${pkgs.join(' ')}`)
}

step(3, 'Speech model')
if (existsSync(WHISPER_MODEL)) done(tilde(WHISPER_MODEL))
else if (await ask('Download the whisper.cpp speech model (large-v3-turbo, about 870 MB)?', true)) {
  mkdirSync(dirname(WHISPER_MODEL), { recursive: true })
  const partial = `${WHISPER_MODEL}.partial`
  // -C - resumes an interrupted download.
  if (sh('curl', ['-L', '--fail', '--progress-bar', '-C', '-', '-o', partial, MODEL_URL])) {
    renameSync(partial, WHISPER_MODEL)
    done(tilde(WHISPER_MODEL))
  } else skip('Download failed; run setup again to resume it.')
} else later('Skipped (voice notes won’t be transcribed)', 'pnpm run setup')

step(4, 'Link your phone')
ensureHome()
// Linking by code is the default: the background bridge does it and keeps running afterwards.
// The QR needs a bridge in this terminal, and stopping it to hand over can lose part of the first
// history import (see pair.ts), so it's only the fallback.
let linkPhone: string | undefined
async function askPhone(): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question('  Your WhatsApp number with country code, to link with a code\n  (or press Enter to scan a QR code instead): ')).trim()
  rl.close()
  return answer || undefined
}
const agentScript = join(REPO, 'scripts', 'agent.sh')
// The installed agent is this setup's when it runs this code AND uses this data folder.
const ownAgent = () =>
  resolve(agentTarget(AGENT_PLIST, '/src/bridge.ts') ?? '') === join(REPO, 'src', 'bridge.ts') &&
  resolve(agentDataDir(AGENT_PLIST) ?? '') === resolve(HOME)
if (isPaired()) {
  done('Already linked')
  // A link by code left the number in the agent's plist (setup stopped before cleaning it up).
  if (ownAgent() && readFileSync(AGENT_PLIST, 'utf8').includes('<string>--phone</string>')) sh('sh', [agentScript, 'forget-phone'])
} else if (
  (linkPhone = PHONE ?? (INTERACTIVE && !YES ? await askPhone() : undefined)) !== undefined
) {
  const digits = phoneDigits(linkPhone)
  if (!digits) {
    say(`  "${linkPhone}" doesn't look like a phone number. Use the full number with country code: --phone +56912345678`)
    process.exit(1)
  }
  if ((await bridgeConnection()) !== undefined) {
    say('  Another bridge is running and holds the WhatsApp session. Stop it first')
    say('  (Ctrl+C in its terminal, or pnpm agent:uninstall), then run setup again.')
    process.exit(1)
  }
  // There's one background bridge per Mac (one launchd label). If the installed one belongs to
  // another copy or another data folder, linking here replaces it, and a failed link removes it.
  const otherTarget = agentTarget(AGENT_PLIST, '/src/bridge.ts')
  const otherData = agentDataDir(AGENT_PLIST)
  if (otherTarget && !ownAgent()) {
    say(`  A background bridge is already installed for another setup:`)
    say(`    code ${tilde(otherTarget)}, data ${tilde(otherData ?? '')}`)
    if (!(await ask('Replace it with this one? Its phone stays linked in its data folder, but it stops syncing.', false))) {
      later('Kept the other background bridge', 'pnpm agent:uninstall, then pnpm run setup')
      process.exit(1)
    }
  }
  // The background bridge asks for the code and, once linked, keeps running: no restart to cut
  // the first history import short (see pair.ts).
  const readNew = logFollower(join(HOME, 'bridge.log'))
  if (!sh('sh', [agentScript, 'pair', digits])) process.exit(1)
  say('  Asking WhatsApp for a pairing code…')
  // Everything the bridge says is kept, so a failure can show why.
  const recent: string[] = []
  const result = await watchPairing({
    readNew,
    isPaired,
    onCode: (code, replacesEarlier) => {
      say()
      if (replacesEarlier) say(`  NEW PAIRING CODE (the previous one no longer works): ${styleText('bold', code)}`)
      else {
        say(`  PAIRING CODE: ${styleText('bold', code)}`)
        say('  On your phone: WhatsApp → Settings → Linked devices → Link a device →')
        say('  "Link with phone number instead", and type the code. Waiting up to 5 minutes…')
      }
      say()
    },
    onLine: line => {
      recent.push(line)
      if (recent.length > 40) recent.shift()
      if (/Connected as|Connection closed|Another bridge|logged|Fatal|Unhandled|rror|Could not/.test(line)) {
        say(styleText('dim', `  ${line}`))
      }
    },
  })
  if (result === 'paired') {
    sh('sh', [agentScript, 'forget-phone'])
    done('Linked. Your history keeps importing in the background; it can take a few minutes.')
  } else {
    // Left running, it would keep asking WhatsApp for codes nobody types.
    sh('sh', [agentScript, 'uninstall'])
    say(
      result === 'timeout'
        ? '  The code wasn\'t entered within 5 minutes. Run setup again for a new one.'
        : '  The bridge couldn\'t link the phone.',
    )
    if (recent.length) {
      say('  Last lines from the bridge:')
      for (const line of recent) say(styleText('dim', `    ${line}`))
    }
    process.exit(1)
  }
} else if (!INTERACTIVE) later('Needs a terminal to show the QR code, or --phone to link with a code', 'pnpm run setup')
else if (await ask('Show the QR code now?', true)) {
  say()
  say('  On your phone: WhatsApp → Settings → Linked devices → Link a device, and scan the code.')
  say('  Then leave it running while "History sync" lines appear. Press Ctrl+C only after they have')
  say('  stopped for a couple of minutes: stopping during the first import can lose part of your history.')
  say()
  // Ctrl+C is meant for the bridge: setup keeps going once it exits.
  const ignore = () => {}
  process.on('SIGINT', ignore)
  await new Promise<void>(resolveExit => {
    spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(REPO, 'src', 'bridge.ts')], {
      stdio: 'inherit',
      cwd: REPO,
    }).on('exit', () => resolveExit())
  })
  process.off('SIGINT', ignore)
  say()
  if (isPaired()) done('Linked')
  else {
    say('  The phone is not linked yet. Run setup again when you are ready to scan.')
    process.exit(1)
  }
} else later('Skipped', 'pnpm run setup')

step(5, 'Run the bridge in the background')
const agent = agentTarget(AGENT_PLIST, '/src/bridge.ts')
const running = (await bridgeConnection()) !== undefined
if (ownAgent() && running) done('Installed and running (starts at login, restarts if it crashes)')
else if (!isPaired()) skip('Waiting for a linked phone')
else if (ownAgent()) {
  // A bridge WhatsApp logged out exits cleanly, and launchd only restarts crashes: after linking
  // again, the agent is still installed but nothing is running.
  if (await ask('The background bridge is installed but not running. Start it?', true)) {
    sh('sh', [agentScript, 'install'])
  } else later('Not started', 'pnpm agent:install')
} else {
  const question = agent
    ? `The background bridge belongs to another setup (code ${tilde(agent)}, data ${tilde(agentDataDir(AGENT_PLIST) ?? '')}). Replace it with this one?`
    : 'Keep the bridge running in the background (starts at login)?'
  if (await ask(question, !agent)) sh('sh', [agentScript, 'install'])
  else later('Skipped', 'pnpm agent:install')
}

step(6, 'Register with Claude Code')
const reg = await claudeRegistration()
const claude = claudeBin() ?? 'claude'
const addArgs = ['mcp', 'add', 'whatsapp', '--scope', 'user', '--', 'node', '--disable-warning=ExperimentalWarning', MCP_ENTRY]
const addCommand = `claude ${addArgs.map(quote).join(' ')}`
if (!reg.cli) later('Claude Code CLI not found', addCommand)
else if (reg.registered && reg.entry && resolve(reg.entry) === MCP_ENTRY) done('Registered as "whatsapp"')
else if (reg.registered) {
  if (await ask(`Claude Code runs another copy (${reg.entry ?? 'unknown'}). Point it at this folder?`, false)) {
    if (sh(claude, ['mcp', 'remove', 'whatsapp', '--scope', 'user'])) sh(claude, addArgs)
  } else later('Kept the other copy', 'claude mcp remove whatsapp --scope user, then pnpm run setup')
} else if (await ask('Add the WhatsApp tools to Claude Code (all your projects)?', true)) {
  if (sh(claude, addArgs)) done('Registered. Restart Claude Code to load it.')
} else later('Skipped', addCommand)

step(7, 'Menu bar icon (optional)')
const menubar = agentTarget(MENUBAR_PLIST, '/build/whatsapp-status')
if (menubar && resolve(menubar) === join(REPO, 'build', 'whatsapp-status')) done('Installed')
else if (!findBin('swiftc')) later('Needs the Xcode command line tools', 'xcode-select --install, then pnpm menubar:install')
else if (await ask('Add a menu bar icon that shows whether the bridge is connected?', false)) {
  sh('sh', [join(REPO, 'scripts', 'menubar.sh'), 'install'])
} else later('Skipped', 'pnpm menubar:install')

say(`\n${styleText('bold', 'Checkup')}`)
printChecks(await runChecks())

say(`\n${styleText('bold', 'Next')}`)
say('  Restart Claude Code and ask it something like "what did the family group talk about today?"')
const config = loadConfig()
if (!config.allowedRecipients.length) {
  say(`  Sending is off until you list who Claude may write to in ${tilde(CONFIG_PATH)}`)
  say(`  (see "Sending" in the README).${config.confirmBeforeSending ? ' Every message still asks you first.' : ''}`)
}
