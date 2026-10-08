import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

// launchd starts us with a bare PATH, so look in Homebrew's locations too.
export function findBin(name: string): string | undefined {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin']
  for (const d of dirs) {
    const p = join(d, name)
    if (d && existsSync(p)) return p
  }
}
