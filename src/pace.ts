// How long to hold a message so that messages to different people go out at least `minMs` apart.
// A reply in the same chat isn't held: that's a conversation, not a broadcast.
export function paceDelay(last: { chat: string; at: number } | undefined, chat: string, now: number, minMs: number): number {
  if (!last || last.chat === chat || minMs <= 0) return 0
  return Math.max(0, last.at + minMs - now)
}
