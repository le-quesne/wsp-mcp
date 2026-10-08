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
  // false = send immediately, without the macOS dialog.
  confirmBeforeSending: boolean
  // Transcribe incoming voice notes locally as they arrive, so search covers them.
  autoTranscribe: boolean
}

const DEFAULT_CONFIG: Config = { allowedRecipients: [], confirmBeforeSending: true, autoTranscribe: true }

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
    const list = Array.isArray(raw?.allowedRecipients) ? raw.allowedRecipients : []
    return {
      allowedRecipients: list.filter((x: unknown): x is string => typeof x === 'string'),
      confirmBeforeSending: raw?.confirmBeforeSending !== false,
      autoTranscribe: raw?.autoTranscribe !== false,
    }
  } catch {
    return DEFAULT_CONFIG
  }
}
