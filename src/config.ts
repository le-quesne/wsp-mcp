import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Everything sensitive (WhatsApp session keys, message database) lives outside the repo.
export const HOME = process.env.WA_MCP_HOME ?? join(homedir(), '.whatsapp-mcp')
export const AUTH_DIR = join(HOME, 'auth')
export const DB_PATH = join(HOME, 'messages.db')
// macOS caps Unix socket paths at ~104 bytes; a long HOME falls back to the per-user temp dir.
export const SOCKET_PATH = (() => {
  const preferred = join(HOME, 'bridge.sock')
  if (Buffer.byteLength(preferred) <= 100) return preferred
  return join(tmpdir(), `whatsapp-mcp-${createHash('sha256').update(HOME).digest('hex').slice(0, 12)}.sock`)
})()
export const CONFIG_PATH = join(HOME, 'config.json')
export const MEDIA_DIR = join(HOME, 'media')
// The speech model whisper.cpp transcribes with (`pnpm run setup` downloads it).
export const WHISPER_MODEL =
  process.env.WA_WHISPER_MODEL ?? join(homedir(), '.cache/whisper-cpp/ggml-large-v3-turbo-q8_0.bin')

export type Config = {
  // Phone numbers with country code (any formatting), full JIDs (e.g. "1203...@g.us"),
  // or "*" for anyone. Empty means sending is disabled.
  allowedRecipients: string[]
  // true = every message waits for your click in a macOS dialog.
  confirmBeforeSending: boolean
  // Transcribe incoming voice notes locally as they arrive, so search covers them.
  autoTranscribe: boolean
  // A message to someone other than the last recipient waits until this many seconds after the
  // previous send. Messaging many people in a row is what gets numbers banned; 0 turns it off.
  minSecondsBetweenRecipients: number
}

// Sending works out of the box: to anyone, without a dialog, paced so it doesn't look like a bot.
// The allowlist and the dialog are there for whoever wants them.
export const DEFAULT_CONFIG: Config = {
  allowedRecipients: ['*'],
  confirmBeforeSending: false,
  autoTranscribe: true,
  minSecondsBetweenRecipients: 15,
}

export function ensureHome(): void {
  for (const dir of [HOME, AUTH_DIR]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', { mode: 0o600 })
  }
}

// Read on every send so edits take effect without restarting the bridge.
export function loadConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    // Left out means the default; written but not a list means someone meant to restrict it, so
    // it sends to nobody rather than to everybody.
    const list =
      raw?.allowedRecipients === undefined
        ? DEFAULT_CONFIG.allowedRecipients
        : Array.isArray(raw.allowedRecipients)
          ? raw.allowedRecipients
          : []
    const pace = raw?.minSecondsBetweenRecipients
    return {
      allowedRecipients: list.filter((x: unknown): x is string => typeof x === 'string'),
      confirmBeforeSending: raw?.confirmBeforeSending === true,
      autoTranscribe: raw?.autoTranscribe !== false,
      minSecondsBetweenRecipients:
        typeof pace === 'number' && Number.isFinite(pace) && pace >= 0 ? pace : DEFAULT_CONFIG.minSecondsBetweenRecipients,
    }
  } catch {
    return DEFAULT_CONFIG
  }
}
