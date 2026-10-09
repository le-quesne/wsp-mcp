// Linking with an 8-character code instead of a QR. It's what lets setup run where there's no
// terminal to draw a QR in, like inside Claude Code: the bridge asks WhatsApp for a code, and the
// person types it on their phone (Linked devices → Link a device → Link with phone number instead).
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

// WhatsApp wants the full international number, digits only.
export function phoneDigits(input: string): string | undefined {
  const digits = input.replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 15 ? digits : undefined
}

// The bridge logs "Pairing code: ABCD-EFGH" (Baileys formats it with the dash).
export const pairingCodeIn = (line: string): string | undefined =>
  /Pairing code:\s*([A-Z0-9]{4}-?[A-Z0-9]{4})\b/i.exec(line)?.[1]

export type PairOptions = {
  command: string
  args: string[]
  cwd: string
  isPaired: () => boolean
  onCode: (code: string) => void
  onLine?: (line: string) => void
  // How long the person has to type the code.
  pairTimeoutMs?: number
  // Once linked, the first history import counts as done after this long without a new
  // "History sync" line, or after syncCapMs in total, whichever comes first. Stopping earlier
  // isn't fatal (the background bridge picks up what's left), but it's a calmer handover.
  quietMs?: number
  syncCapMs?: number
}

export type PairResult = 'paired' | 'timeout' | 'exited'

export function pairWithCode(o: PairOptions): Promise<PairResult> {
  const { pairTimeoutMs = 5 * 60_000, quietMs = 30_000, syncCapMs = 5 * 60_000 } = o
  return new Promise(resolve => {
    const child = spawn(o.command, o.args, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let result: PairResult | undefined
    let linked = false
    const timers: NodeJS.Timeout[] = []
    let quiet: NodeJS.Timeout | undefined

    // Stop the bridge and report once it has really exited: the background agent can't take the
    // session while this one still holds it.
    const finish = (r: PairResult) => {
      if (result) return
      result = r
      timers.forEach(clearTimeout)
      clearTimeout(quiet)
      child.kill('SIGTERM')
      timers.push(setTimeout(() => child.kill('SIGKILL'), 10_000))
    }
    const settleLater = () => {
      clearTimeout(quiet)
      quiet = setTimeout(() => finish('paired'), quietMs)
    }
    const onLinked = () => {
      if (linked || result) return
      linked = true
      timers.push(setTimeout(() => finish('paired'), syncCapMs))
      settleLater()
    }

    let codeShown = false
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', line => {
        o.onLine?.(line)
        const code = pairingCodeIn(line)
        if (code && !codeShown) {
          codeShown = true
          o.onCode(code)
        }
        if (linked && /History sync/.test(line)) settleLater()
      })
    }

    // The bridge saves the session the moment the phone accepts the code.
    const poll = setInterval(() => o.isPaired() && onLinked(), 1000)
    timers.push(setTimeout(() => !linked && finish('timeout'), pairTimeoutMs))

    child.on('exit', () => {
      clearInterval(poll)
      timers.forEach(clearTimeout)
      clearTimeout(quiet)
      resolve(result ?? (o.isPaired() ? 'paired' : 'exited'))
    })
  })
}
