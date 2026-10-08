// Who the bridge may send to. It's checked in the bridge, not in the MCP server, so it holds
// whatever the client asks for.
//
// `canon` maps a JID to the form chats are stored under (a LID becomes its phone number), so an
// entry written either way matches the same chat.
export function isAllowed(chat: string, allowed: string[], canon: (jid: string) => string | undefined): boolean {
  return allowed.some(entry => {
    const e = entry.trim()
    if (e === '*') return true
    if (e.includes('@')) return canon(e.toLowerCase()) === chat
    const digits = e.replace(/\D/g, '')
    return digits.length > 0 && chat === `${digits}@s.whatsapp.net`
  })
}
