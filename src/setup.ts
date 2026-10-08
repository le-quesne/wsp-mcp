// `pnpm run setup`: from a fresh clone to Claude reading your WhatsApp. Every step checks first
// and skips what's already done, so it's safe to run again. It asks before installing anything;
// `--yes` answers yes to every question. Without a terminal to ask in, it installs nothing and
// prints what it would have run.
//
// No dependencies beyond Node itself: it's what runs `pnpm install`.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { styleText } from 'node:util'
import { findBin } from './bin.ts'
import { CONFIG_PATH, ensureHome, loadConfig, WHISPER_MODEL } from './config.ts'
import {
  AGENT_PLIST,
  agentTarget,
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
function sh(cmd: string, args: string[]): boolean {
  say(styleText('dim', `  $ ${[cmd, ...args].join(' ')}`))
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
  if (!findBin('brew')) later(`Missing ${pkgs.join(', ')} and Homebrew isn't installed`, `brew install ${pkgs.join(' ')}`)
  else if (await ask(`Install ${pkgs.join(' and ')} with Homebrew? Voice notes are transcribed on this Mac.`, true)) {
    sh('brew', ['install', ...pkgs])
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
if (isPaired()) done('Already linked')
else if (!INTERACTIVE) later('Needs a terminal to show the QR code', 'pnpm run setup')
else if (await ask('Show the QR code now?', true)) {
  say()
  say('  On your phone: WhatsApp → Settings → Linked devices → Link a device, and scan the code.')
  say('  Then wait while "History sync" lines appear. When they stop, press Ctrl+C to continue setup.')
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
const here = join(REPO, 'src', 'bridge.ts')
if (agent && resolve(agent) === here) done('Installed (starts at login, restarts if it crashes)')
else if (!isPaired()) skip('Waiting for a linked phone')
else {
  const question = agent
    ? `The background bridge runs another copy (${agent}). Point it at this folder?`
    : 'Keep the bridge running in the background (starts at login)?'
  if (await ask(question, !agent)) sh('sh', [join(REPO, 'scripts', 'agent.sh'), 'install'])
  else later('Skipped', 'pnpm agent:install')
}

step(6, 'Register with Claude Code')
const reg = await claudeRegistration()
const claude = claudeBin() ?? 'claude'
const addArgs = ['mcp', 'add', 'whatsapp', '--scope', 'user', '--', 'node', '--disable-warning=ExperimentalWarning', MCP_ENTRY]
if (!reg.cli) later('Claude Code CLI not found', `claude ${addArgs.join(' ')}`)
else if (reg.registered && reg.entry && resolve(reg.entry) === MCP_ENTRY) done('Registered as "whatsapp"')
else if (reg.registered) {
  if (await ask(`Claude Code runs another copy (${reg.entry ?? 'unknown'}). Point it at this folder?`, false)) {
    if (sh(claude, ['mcp', 'remove', 'whatsapp', '--scope', 'user'])) sh(claude, addArgs)
  } else later('Kept the other copy', 'claude mcp remove whatsapp --scope user, then pnpm run setup')
} else if (await ask('Add the WhatsApp tools to Claude Code (all your projects)?', true)) {
  if (sh(claude, addArgs)) done('Registered. Restart Claude Code to load it.')
} else later('Skipped', `claude ${addArgs.join(' ')}`)

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
