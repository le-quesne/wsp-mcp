// Linking with an 8-character code instead of a QR. It's what lets setup run where there's no
// terminal to draw a QR in, like inside Claude Code: the bridge asks WhatsApp for a code, and the
// person types it on their phone (Linked devices → Link a device → Link with phone number instead).
//
// The bridge that asks for the code is the background one (`scripts/agent.sh pair`), and setup
// only reads its log. There's no handover after linking: Baileys confirms each history chunk to
// WhatsApp before downloading it and doesn't remember pending downloads, so stopping a freshly
// linked bridge mid-import would lose those messages for good.
import { closeSync, openSync, readSync, statSync } from 'node:fs'

// A pairing code that was requested but never typed leaves `me` in the session, and with `me`
// Baileys tries to log in instead of asking for a new link: no new code, no QR, just a rejection.
// Until a phone confirms the link (`account`), there's nothing worth keeping in `me`.
export function forgetUnfinishedLink(creds: { account?: unknown; me?: unknown; pairingCode?: unknown }): boolean {
  if (creds.account || !creds.me) return false
  creds.me = undefined
  creds.pairingCode = undefined
  return true
}

// WhatsApp wants the full international number, digits only.
export function phoneDigits(input: string): string | undefined {
  const digits = input.replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 15 ? digits : undefined
}

// The bridge logs "Pairing code: ABCD-EFGH" (Baileys formats it with the dash).
export const pairingCodeIn = (line: string): string | undefined =>
  /Pairing code:\s*([A-Z0-9]{4}-?[A-Z0-9]{4})\b/i.exec(line)?.[1]

export type WatchOptions = {
  // What was appended to the bridge log since the last call.
  readNew: () => string
  isPaired: () => boolean
  onCode: (code: string, replacesEarlier: boolean) => void
  onLine?: (line: string) => void
  // How long the person has to type the code.
  timeoutMs?: number
  pollMs?: number
}

export type WatchResult = 'paired' | 'timeout' | 'failed'

// Lines that mean the bridge can't link, however long we wait.
const HOPELESS = /Another bridge is already running|Fatal:|logged this device out/

export function watchPairing(o: WatchOptions): Promise<WatchResult> {
  const { timeoutMs = 5 * 60_000, pollMs = 500 } = o
  const started = Date.now()
  let partial = ''
  // A reconnect while the person is typing makes the bridge ask for a new code, and only the
  // newest one works: pass each one on.
  let lastCode: string | undefined
  return new Promise(resolve => {
    const tick = () => {
      const lines = (partial + o.readNew()).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        o.onLine?.(line)
        const code = pairingCodeIn(line)
        if (code && code !== lastCode) {
          o.onCode(code, lastCode !== undefined)
          lastCode = code
        }
        if (HOPELESS.test(line)) return resolve('failed')
      }
      // The bridge saves the session the moment the phone accepts the code.
      if (o.isPaired()) return resolve('paired')
      if (Date.now() - started > timeoutMs) return resolve('timeout')
      setTimeout(tick, pollMs)
    }
    tick()
  })
}

// Reads a log from where it ends now: only what the bridge writes from here on.
export function logFollower(path: string): () => string {
  let offset = (() => {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  })()
  return () => {
    let fd: number
    try {
      fd = openSync(path, 'r')
    } catch {
      return ''
    }
    try {
      const size = statSync(path).size
      if (size < offset) offset = 0
      const buf = Buffer.alloc(size - offset)
      const n = buf.length ? readSync(fd, buf, 0, buf.length, offset) : 0
      offset += n
      return buf.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  }
}
