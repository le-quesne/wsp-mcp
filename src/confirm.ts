import { execFile } from 'node:child_process'

// A native macOS dialog: the approval comes from you, not from the model or Claude Code's
// permission mode. Text is passed as an argv item, never interpolated into AppleScript.
// Return/Escape both mean Cancel; only clicking "Send" sends.
const SCRIPT = [
  'on run argv',
  'set r to display dialog (item 1 of argv) with title "WhatsApp MCP" buttons {"Cancel", "Send"} ' +
    'default button "Cancel" cancel button "Cancel" with icon caution giving up after 120',
  'if gave up of r then return "timeout"',
  'return button returned of r',
  'end run',
]

export function confirmSend(recipient: string, text: string): Promise<boolean> {
  const prompt = `Send this WhatsApp message?\n\nTo: ${recipient}\n\n${text}`
  const args = SCRIPT.flatMap(line => ['-e', line]).concat(prompt)
  return new Promise(resolve => {
    execFile('osascript', args, { timeout: 130_000 }, (err, stdout) => {
      resolve(!err && stdout.trim() === 'Send')
    })
  })
}
