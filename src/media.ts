// Downloading files and turning audio into text, all on this Mac.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { downloadMediaMessage, proto, type WAMessage, type WASocket } from 'baileys'
import type { Logger } from 'pino'
import { MEDIA_DIR } from './config.ts'
import type { MediaRow } from './store.ts'

const run = promisify(execFile)

const WHISPER_MODEL =
  process.env.WA_WHISPER_MODEL ?? join(homedir(), '.cache/whisper-cpp/ggml-large-v3-turbo-q8_0.bin')

// launchd starts us with a bare PATH, so look in Homebrew's locations too.
function bin(name: string): string {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin']
  for (const d of dirs) {
    const p = join(d, name)
    if (d && existsSync(p)) return p
  }
  throw new Error(`${name} not found (brew install ${name === 'whisper-cli' ? 'whisper-cpp' : 'ffmpeg'})`)
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
}

function fileNameFor(row: MediaRow): string {
  const id = row.id.replace(/[^A-Za-z0-9]/g, '')
  if (row.fileName) return `${id}-${row.fileName.replace(/[/\\:\0]/g, '_').slice(-120)}`
  const mime = (row.mimetype ?? '').split(';')[0].trim()
  return `${id}.${EXT[mime] ?? mime.split('/')[1] ?? 'bin'}`
}

export async function download(sock: WASocket, row: MediaRow, logger: Logger): Promise<string> {
  if (row.localPath && existsSync(row.localPath)) return row.localPath
  const msg = proto.WebMessageInfo.decode(row.raw) as unknown as WAMessage
  // reuploadRequest asks the phone to upload the file again if WhatsApp's copy expired.
  const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
  mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 })
  const path = join(MEDIA_DIR, fileNameFor(row))
  writeFileSync(path, buf, { mode: 0o600 })
  return path
}

export async function transcribe(path: string): Promise<string> {
  const wav = `${path}.16k.wav`
  try {
    await run(bin('ffmpeg'), ['-nostdin', '-loglevel', 'error', '-y', '-i', path, '-vn', '-ar', '16000', '-ac', '1', wav], {
      timeout: 120_000,
    })
    const { stdout } = await run(bin('whisper-cli'), ['-m', WHISPER_MODEL, '-l', 'auto', '-nt', '-np', '-f', wav], {
      timeout: 900_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    const text = stdout.replace(/\s+/g, ' ').trim()
    return !text || /^\[[^\]]*\]$/.test(text) ? '(no speech)' : text
  } finally {
    try {
      unlinkSync(wav)
    } catch {}
  }
}

// Three stills (start, middle, end) so a video can be "seen".
export async function videoFrames(path: string): Promise<string[]> {
  const { stdout } = await run(bin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path])
  const duration = Number.parseFloat(stdout) || 0
  const frames: string[] = []
  for (const [i, at] of [0.1, 0.5, 0.9].entries()) {
    const out = `${path}.frame${i + 1}.jpg`
    if (!existsSync(out)) {
      await run(bin('ffmpeg'), ['-nostdin', '-loglevel', 'error', '-y', '-ss', String(duration * at), '-i', path,
        '-frames:v', '1', '-vf', 'scale=768:-2', out], { timeout: 60_000 })
    }
    if (existsSync(out) && statSync(out).size > 0) frames.push(out)
  }
  return frames
}

// whisper.cpp saturates the CPU; one job at a time.
let queue: Promise<unknown> = Promise.resolve()
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn)
  queue = next.catch(() => {})
  return next
}
