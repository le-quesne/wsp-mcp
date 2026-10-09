// Long-running process that holds the WhatsApp connection (as a linked device),
// mirrors chats into SQLite, and is the only thing allowed to send messages.
// The MCP server talks to it over a Unix socket (owner-only permissions).
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { createServer, type IncomingMessage } from 'node:http'
import { connect as netConnect } from 'node:net'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  WAMessageStubType,
  fetchLatestWaWebVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WASocket,
} from 'baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { isAllowed } from './allow.ts'
import { findBin } from './bin.ts'
import { paceDelay } from './pace.ts'
import { forgetUnfinishedLink } from './pair.ts'
import { AUTH_DIR, CONFIG_PATH, SOCKET_PATH, ensureHome, loadConfig } from './config.ts'
import { confirmSend } from './confirm.ts'
import { openWriter } from './db.ts'
import { extract } from './extract.ts'
import { download, serial, transcribe, videoFrames } from './media.ts'
import { displayName, label, sameTextElsewhere } from './queries.ts'
import { Store, isStorableJid, type MediaRow } from './store.ts'

const MAX_TEXT = 2000
// Stops that need a human (pair, re-pair) exit 0 so launchd doesn't respawn in a loop.
const NEEDS_USER = 0

const log = (...args: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args)

const pairPhone = (() => {
  const i = process.argv.indexOf('--phone')
  return i > 0 ? process.argv[i + 1]?.replace(/\D/g, '') : undefined
})()

ensureHome()
await claimSocket()
const store = new Store(openWriter())
const logger = pino({ level: process.env.WA_LOG_LEVEL ?? 'error' })

// Baileys learns far more LID→phone pairs than it announces in events (each message
// teaches it some). It keeps them in the auth store as lid-mapping-<lid>_reverse.json.
const importedLids = new Set<string>()
function importLidMappings(): number {
  let added = 0
  const files = readdirSync(AUTH_DIR).filter(f => f.startsWith('lid-mapping-') && f.endsWith('_reverse.json'))
  store.tx(() => {
    for (const f of files) {
      const lidUser = f.slice('lid-mapping-'.length, -'_reverse.json'.length)
      if (importedLids.has(lidUser) || !/^\d+$/.test(lidUser)) continue
      importedLids.add(lidUser)
      try {
        const pnUser = JSON.parse(readFileSync(join(AUTH_DIR, f), 'utf8'))
        if (typeof pnUser === 'string' && /^\d+$/.test(pnUser)) {
          store.mapPair(`${lidUser}@lid`, `${pnUser}@s.whatsapp.net`)
          added++
        }
      } catch {}
    }
  })
  return added
}
log(`Linked ${importLidMappings()} internal ids to phone numbers.`)
setInterval(() => {
  try {
    const n = importLidMappings()
    if (n) log(`Linked ${n} more internal ids to phone numbers.`)
  } catch (err) {
    log('Could not import id mappings:', err)
  }
}, 5 * 60_000).unref()

let sock: WASocket | undefined
let connection: 'connecting' | 'open' | 'closed' = 'connecting'
let retries = 0
let historyThisSession = 0

// Event handlers must never take the bridge down; log and keep going.
const safe =
  <A extends unknown[]>(name: string, fn: (...args: A) => void) =>
  (...args: A) => {
    try {
      fn(...args)
    } catch (err) {
      log(`Error handling ${name}:`, err)
    }
  }

async function connect(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  // `account` is only written when a phone accepts the link (QR or code). `me` isn't proof:
  // asking for a pairing code fills it in before anyone types the code.
  const paired = !!state.creds.account
  if (forgetUnfinishedLink(state.creds)) {
    await saveCreds()
    log('Dropped an unfinished pairing attempt; asking for a new link.')
  }
  if (!paired && !process.stdout.isTTY && !pairPhone) {
    log('Not paired yet. Run `pnpm bridge` in a terminal and scan the QR code.')
    shutdown(NEEDS_USER)
  }
  const { version } = await fetchLatestWaWebVersion({}).catch(() => ({ version: undefined }))
  connection = 'connecting'
  const s = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    ...(version ? { version } : {}),
    logger,
    // Not 'Desktop': as of 2026-10 WhatsApp drops that identity with 428 before showing a QR.
    browser: Browsers.macOS('Chrome'),
    // Ask the phone for the full history; it decides how much to actually send.
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
    // Stay invisible: no "online" presence, so your phone keeps getting notifications.
    markOnlineOnConnect: false,
  })
  sock = s
  let pairingRequested = false

  s.ev.on('creds.update', saveCreds)

  s.ev.on('connection.update', async update => {
    if (update.qr) {
      if (pairPhone) {
        if (!pairingRequested) {
          pairingRequested = true
          const code = await s.requestPairingCode(pairPhone)
          log(`Pairing code: ${code}`)
          log('On your phone: WhatsApp → Linked devices → Link a device → "Link with phone number instead".')
        }
      } else {
        qrcode.generate(update.qr, { small: true })
        log('Scan with your phone: WhatsApp → Settings → Linked devices → Link a device.')
      }
    }
    if (update.connection === 'open') {
      connection = 'open'
      retries = 0
      const me = s.user
      const who = me?.id ? label(me.name ?? me.notify ?? null, jidNormalizedUser(me.id)) : 'unknown account'
      if (me?.id) {
        store.mapPair(me.id, me.lid)
        store.setMeta('me', who)
      }
      store.setMeta('connected_at', new Date().toISOString())
      log(`Connected as ${who}. Keep this running to stay in sync.`)
      s.groupFetchAllParticipating()
        .then(groups => store.tx(() => Object.values(groups).forEach(g => store.upsertGroup(g))))
        .catch(err => log('Could not fetch group names:', err?.message ?? err))
    }
    if (update.connection === 'close') {
      connection = 'closed'
      const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        log(`WhatsApp logged this device out. Delete ${AUTH_DIR} and run \`pnpm bridge\` again to re-pair.`)
        store.setMeta('status', 'logged_out')
        shutdown(NEEDS_USER)
      }
      if (code === DisconnectReason.connectionReplaced) {
        log('Another client took over this session. Stopping.')
        shutdown(NEEDS_USER)
      }
      const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 2_000 * 2 ** retries++)
      log(`Connection closed (${code ?? 'unknown'}). Reconnecting in ${delay / 1000}s.`)
      setTimeout(() => connect().catch(fatal), delay)
    }
  })

  s.ev.on(
    'messaging-history.set',
    safe('history', ({ chats, contacts, messages, lidPnMappings, progress }) => {
      let stored = 0
      store.tx(() => {
        for (const m of lidPnMappings ?? []) store.mapPair(m.lid, m.pn)
        for (const c of contacts) store.upsertContact(c)
        for (const c of chats) store.upsertWAChat(c)
        for (const m of messages) if (store.storeMessage(m, false)) stored++
      })
      historyThisSession += stored
      const pct = typeof progress === 'number' ? `, ${progress}%` : ''
      store.setMeta('history_sync', `${historyThisSession} messages imported${pct} (${new Date().toISOString()})`)
      log(`History sync: +${stored} messages (${historyThisSession} this session${pct}).`)
    }),
  )

  s.ev.on(
    'messages.upsert',
    safe('messages.upsert', ({ messages, type }) => {
      store.tx(() => messages.forEach(m => store.storeMessage(m, type === 'notify')))
      if (type !== 'notify' || !loadConfig().autoTranscribe) return
      for (const m of messages) {
        const audio = normalizeMessageContent(m.message)?.audioMessage
        const chat = store.canon(m.key?.remoteJid)
        if (audio && chat && m.key?.id && (audio.seconds ?? 0) <= 600) {
          fetchMedia(chat, m.key.id).catch(err => log('Could not transcribe a voice note:', err?.message ?? err))
        }
      }
    }),
  )

  s.ev.on(
    'messages.update',
    safe('messages.update', updates => {
      store.tx(() => {
        for (const { key, update } of updates) {
          if (update.message === null && update.messageStubType === WAMessageStubType.REVOKE) {
            store.deleteMessage(key)
          } else if (update.message?.editedMessage) {
            const ex = extract(update.message)
            if (ex) store.editMessage(key, ex)
          }
        }
      })
    }),
  )

  s.ev.on('chats.upsert', safe('chats.upsert', chats => store.tx(() => chats.forEach(c => store.upsertWAChat(c)))))
  s.ev.on('chats.update', safe('chats.update', chats => store.tx(() => chats.forEach(c => store.upsertWAChat(c)))))
  s.ev.on('contacts.upsert', safe('contacts.upsert', cs => store.tx(() => cs.forEach(c => store.upsertContact(c)))))
  s.ev.on('contacts.update', safe('contacts.update', cs => store.tx(() => cs.forEach(c => store.upsertContact(c)))))
  s.ev.on('groups.upsert', safe('groups.upsert', gs => store.tx(() => gs.forEach(g => store.upsertGroup(g)))))
  s.ev.on('groups.update', safe('groups.update', gs => store.tx(() => gs.forEach(g => store.upsertGroup(g)))))
  s.ev.on('lid-mapping.update', safe('lid-mapping.update', ({ lid, pn }) => store.mapPair(lid, pn)))
}

// ---- local API for the MCP server ----

type Reply = [status: number, body: Record<string, unknown>]

// One send at a time: the dialog, the pacing and the typing all assume it.
let sendQueue: Promise<unknown> = Promise.resolve()

// The last message that went out, for pacing messages to different people (pace.ts).
let lastSend: { chat: string; at: number } | undefined

// Holds a send until it's far enough from the previous one to a different person. Returns the
// seconds it waited, so the model knows why a batch is slow.
async function pace(chat: string, who: string, minSeconds: number): Promise<number> {
  const wait = paceDelay(lastSend, chat, Date.now(), minSeconds * 1000)
  if (!wait) return 0
  log(`Waiting ${Math.ceil(wait / 1000)} s before messaging ${who} (messages to different people go out ${minSeconds} s apart).`)
  await sleep(wait)
  return Math.ceil(wait / 1000)
}

const MAX_TYPING_MS = 90_000

// Shows "typing…" in the chat for `ms` before a message goes out. The recipient's app drops
// the indicator after ~10 s, so it is refreshed every 8 s. Composing only shows while we're
// "available"; the caller goes back to unavailable afterwards so the phone keeps notifying.
async function showTyping(s: WASocket, chat: string, ms: number): Promise<void> {
  await s.presenceSubscribe(chat).catch(() => {})
  await s.sendPresenceUpdate('available')
  const end = Date.now() + ms
  while (Date.now() < end) {
    await s.sendPresenceUpdate('composing', chat)
    await sleep(Math.min(8_000, end - Date.now()))
  }
  await s.sendPresenceUpdate('paused', chat)
}

async function handleSend(body: unknown): Promise<Reply> {
  const { jid, text, typingMs } = (body ?? {}) as { jid?: unknown; text?: unknown; typingMs?: unknown }
  if (typeof jid !== 'string' || typeof text !== 'string' || !text.trim()) {
    return [400, { error: 'jid and text are required' }]
  }
  const typing = typeof typingMs === 'number' && typingMs > 0 ? Math.min(typingMs, MAX_TYPING_MS) : 0
  if (text.length > MAX_TEXT) return [400, { error: `Message too long (${text.length} chars, max ${MAX_TEXT}).` }]
  const chat = store.canon(jid)
  if (!chat || !isStorableJid(chat)) return [400, { error: `Not a person or group: ${jid}` }]
  const who = label(displayName(store.db, chat), chat)
  const config = loadConfig()
  if (!isAllowed(chat, config.allowedRecipients, j => store.canon(j))) {
    return [403, { error: `${who} is not in allowedRecipients. Only the user may add it, in ${CONFIG_PATH}.` }]
  }
  if (!sock || connection !== 'open') return [503, { error: 'The bridge is not connected to WhatsApp right now.' }]

  const run = sendQueue.then(async (): Promise<Reply> => {
    if (config.confirmBeforeSending && !(await confirmSend(who, text))) {
      return [200, { status: 'cancelled', to: who }]
    }
    const waited = await pace(chat, who, config.minSecondsBetweenRecipients)
    if (!sock || connection !== 'open') return [503, { error: 'Lost the WhatsApp connection before sending.' }]
    const s = sock
    // Counted before sending, so this message isn't one of them.
    const copies = sameTextElsewhere(store.db, chat, text, Math.floor(Date.now() / 1000) - 86_400)
    let sent
    try {
      if (typing) await showTyping(s, chat, typing)
      sent = await s.sendMessage(chat, { text })
    } finally {
      if (typing) await s.sendPresenceUpdate('unavailable').catch(() => {})
    }
    lastSend = { chat, at: Date.now() }
    if (sent) store.storeMessage(sent, true)
    log(`Sent a message to ${who}.`)
    return [200, { status: 'sent', to: who, id: sent?.key.id ?? null, waited, copies, pace: config.minSecondsBetweenRecipients }]
  })
  sendQueue = run.catch(() => {})
  return run
}

// Which phone numbers have WhatsApp, and under which jid (e.g. Argentina adds a 9 to mobiles).
async function handleExists(body: unknown): Promise<Reply> {
  const { phones } = (body ?? {}) as { phones?: unknown }
  if (!Array.isArray(phones) || !phones.every(p => typeof p === 'string') || phones.length > 50) {
    return [400, { error: 'phones must be an array of up to 50 strings' }]
  }
  if (!sock || connection !== 'open') return [503, { error: 'The bridge is not connected to WhatsApp right now.' }]
  const found = (await sock.onWhatsApp(...phones.map(p => p.replace(/\D/g, '')))) ?? []
  return [200, { results: found }]
}

// A contact's profile photo URL (short-lived CDN link). Null when they hide it from non-contacts.
async function handleAvatar(body: unknown): Promise<Reply> {
  const { jid } = (body ?? {}) as { jid?: unknown }
  if (typeof jid !== 'string') return [400, { error: 'jid is required' }]
  if (!sock || connection !== 'open') return [503, { error: 'The bridge is not connected to WhatsApp right now.' }]
  const url = await sock.profilePictureUrl(jid, 'image').catch(() => undefined)
  return [200, { url: url ?? null }]
}

// Baileys hangs encrypting large files (tested: 26–69 MB hang, 4–6 MB go out in 1 s).
// Videos over MAX_FILE are recompressed to 720p before sending; other files over the limit are refused.
const MAX_FILE = 16 * 1024 * 1024
const FFMPEG = findBin('ffmpeg') ?? 'ffmpeg'
const run = promisify(execFile)

async function shrinkVideo(path: string): Promise<string> {
  for (const [width, crf] of [[720, 26], [540, 30]] as const) {
    const out = join(tmpdir(), `wa-send-${process.pid}-${Date.now()}.mp4`)
    await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', path, '-vf', `scale='min(${width},iw)':-2`,
      '-c:v', 'libx264', '-crf', String(crf), '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], { timeout: 600_000 })
    if (statSync(out).size <= MAX_FILE) return out
    unlinkSync(out)
  }
  throw new Error('The video is still over 16 MB after compressing it to 540p. Trim it before sending.')
}

// Sends a local file (a video as a video, anything else as a document). Same permissions and queue as /send.
async function handleSendFile(body: unknown): Promise<Reply> {
  const { jid, path, caption } = (body ?? {}) as { jid?: unknown; path?: unknown; caption?: unknown }
  if (typeof jid !== 'string' || typeof path !== 'string') return [400, { error: 'jid and path are required' }]
  if (!existsSync(path)) return [400, { error: `File not found: ${path}` }]
  const text = typeof caption === 'string' ? caption.slice(0, MAX_TEXT) : undefined
  const chat = store.canon(jid)
  if (!chat || !isStorableJid(chat)) return [400, { error: `Not a person or group: ${jid}` }]
  const who = label(displayName(store.db, chat), chat)
  const config = loadConfig()
  if (!isAllowed(chat, config.allowedRecipients, j => store.canon(j))) {
    return [403, { error: `${who} is not in allowedRecipients. Only the user may add it, in ${CONFIG_PATH}.` }]
  }
  if (!sock || connection !== 'open') return [503, { error: 'The bridge is not connected to WhatsApp right now.' }]

  const run = sendQueue.then(async (): Promise<Reply> => {
    if (config.confirmBeforeSending && !(await confirmSend(who, `[file] ${basename(path)}`))) {
      return [200, { status: 'cancelled', to: who }]
    }
    const waited = await pace(chat, who, config.minSecondsBetweenRecipients)
    if (!sock || connection !== 'open') return [503, { error: 'Lost the WhatsApp connection before sending.' }]
    const isVideo = /\.(mp4|mov|m4v)$/i.test(path)
    let file = path
    if (statSync(path).size > MAX_FILE) {
      if (!isVideo) return [413, { error: `File is over 16 MB; this bridge can only send larger files if they are videos.` }]
      log(`Compressing ${basename(path)} for WhatsApp…`)
      file = await shrinkVideo(path)
    }
    // Pass the file already read: with { url: path } the library hangs encrypting large files.
    const data = readFileSync(file)
    if (file !== path) unlinkSync(file)
    const content = isVideo
      ? { video: data, caption: text, mimetype: 'video/mp4' }
      : { document: data, fileName: basename(path), caption: text, mimetype: 'application/octet-stream' }
    // A stuck file can't block the /send queue: it's cut off after 5 min.
    const prev = logger.level
    logger.level = 'debug'
    log(`Sending a file to ${who}: ${basename(path)}…`)
    let sent
    try {
      sent = await Promise.race([
        sock.sendMessage(chat, content),
        sleep(300_000).then(() => { throw new Error('File send timed out after 5 min') }),
      ])
    } finally {
      logger.level = prev
    }
    lastSend = { chat, at: Date.now() }
    if (sent) store.storeMessage(sent, true)
    log(`Sent a file to ${who}: ${basename(path)}`)
    return [200, { status: 'sent', to: who, id: sent?.key.id ?? null, waited, pace: config.minSecondsBetweenRecipients }]
  })
  sendQueue = run.catch(() => {})
  return run
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type MediaResult = {
  kind: string
  mimetype: string | null
  fileName: string | null
  path: string
  transcript: string | null
  frames: string[]
}

// Messages imported before we kept download keys: ask the phone to resend the 50
// messages before the next one, which brings the keys back if it still has the file.
async function recoverMedia(chat: string, id: string): Promise<MediaRow | undefined> {
  if (!sock || connection !== 'open') return
  const anchor = store.anchorAfter(chat, id)
  if (!anchor) return
  const lid = store.lidFor(chat)
  for (const remoteJid of lid ? [chat, lid] : [chat]) {
    await sock.fetchMessageHistory(50, { remoteJid, id: anchor.id, fromMe: anchor.fromMe }, anchor.ts * 1000)
    for (let i = 0; i < 15; i++) {
      await sleep(1000)
      const row = store.getMedia(chat, id)
      if (row) return row
    }
  }
}

const inflight = new Map<string, Promise<MediaResult>>()

function fetchMedia(chat: string, id: string): Promise<MediaResult> {
  const key = `${chat}/${id}`
  let job = inflight.get(key)
  if (!job) {
    job = fetchMediaNow(chat, id).finally(() => inflight.delete(key))
    inflight.set(key, job)
  }
  return job
}

async function fetchMediaNow(chat: string, id: string): Promise<MediaResult> {
  const type = store.messageType(chat, id)
  if (!type) throw new HttpError(404, 'No message with that id in that chat.')
  if (!['image', 'video', 'gif', 'voice', 'audio', 'document'].includes(type)) {
    throw new HttpError(400, `That message is a ${type}, not a photo, video, audio or document.`)
  }
  const row = store.getMedia(chat, id) ?? (await recoverMedia(chat, id))
  if (!row) {
    throw new HttpError(
      404,
      sock && connection === 'open'
        ? "Couldn't recover the file: it arrived before the bridge kept download keys and the phone didn't resend it."
        : 'The bridge is not connected to WhatsApp right now.',
    )
  }
  let path = row.localPath && existsSync(row.localPath) ? row.localPath : undefined
  if (!path) {
    if (!sock || connection !== 'open') throw new HttpError(503, 'The bridge is not connected to WhatsApp right now.')
    path = await download(sock, row, logger)
    store.setMediaPath(chat, id, path)
  }
  let transcript = row.transcript
  if (!transcript && (row.kind === 'audio' || row.kind === 'video')) {
    const file = path
    transcript = await serial(() => transcribe(file))
    store.setTranscript(chat, id, transcript)
  }
  const frames = row.kind === 'video' ? await videoFrames(path).catch(() => []) : []
  return { kind: row.kind, mimetype: row.mimetype, fileName: row.fileName, path, transcript, frames }
}

async function handleMedia(body: unknown): Promise<Reply> {
  const { jid, id } = (body ?? {}) as { jid?: unknown; id?: unknown }
  if (typeof jid !== 'string' || typeof id !== 'string') return [400, { error: 'jid and id are required' }]
  const chat = store.canon(jid)
  if (!chat) return [400, { error: `Not a chat: ${jid}` }]
  try {
    return [200, await fetchMedia(chat, id)]
  } catch (err) {
    if (err instanceof HttpError) return [err.status, { error: err.message }]
    throw err
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 64 * 1024) reject(new Error('body too large'))
      else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

const server = createServer((req, res) => {
  const route = async (): Promise<Reply> => {
    if (req.method === 'GET' && req.url === '/status') {
      return [200, { connection, me: sock?.user?.id ?? null, history_this_session: historyThisSession, pid: process.pid }]
    }
    if (req.method === 'POST' && req.url === '/send') return handleSend(await readJson(req))
    if (req.method === 'POST' && req.url === '/exists') return handleExists(await readJson(req))
    if (req.method === 'POST' && req.url === '/avatar') return handleAvatar(await readJson(req))
    if (req.method === 'POST' && req.url === '/send-file') return handleSendFile(await readJson(req))
    if (req.method === 'POST' && req.url === '/media') return handleMedia(await readJson(req))
    return [404, { error: 'not found' }]
  }
  route()
    .catch((err): Reply => [500, { error: String(err?.message ?? err) }])
    .then(([status, body]) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
})

// The socket doubles as a lock: only one bridge may hold the WhatsApp session.
async function claimSocket(): Promise<void> {
  if (!existsSync(SOCKET_PATH)) return
  const alive = await new Promise<boolean>(resolve => {
    const c = netConnect(SOCKET_PATH)
    c.once('connect', () => (c.end(), resolve(true)))
    c.once('error', () => resolve(false))
  })
  if (alive) {
    console.error(`Another bridge is already running (${SOCKET_PATH}).`)
    process.exit(1)
  }
  unlinkSync(SOCKET_PATH)
}

function shutdown(code: number): never {
  sock?.end(undefined).catch(() => {})
  server.close()
  try {
    unlinkSync(SOCKET_PATH)
  } catch {}
  try {
    store.db.close()
  } catch {}
  process.exit(code)
}

function fatal(err: unknown): void {
  log('Fatal:', err)
  shutdown(1)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('unhandledRejection', err => log('Unhandled rejection:', err))

server.listen(SOCKET_PATH, () => chmodSync(SOCKET_PATH, 0o600))
connect().catch(fatal)
