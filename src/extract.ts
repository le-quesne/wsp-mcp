import { getContentType, normalizeMessageContent, toNumber, type proto } from 'baileys'

export type Extracted = { type: string; text: string; quoted?: string }

// Envelope/control messages that never carry something a person wrote.
const SKIP = new Set([
  'protocolMessage',
  'reactionMessage',
  'encReactionMessage',
  'pollUpdateMessage',
  'keepInChatMessage',
  'pinInChatMessage',
  'stickerSyncRmrMessage',
  'encCommentMessage',
  'albumMessage',
  'messageHistoryBundle',
])

const QUOTE_MAX = 160

export function extract(message: proto.IMessage | null | undefined, depth = 0): Extracted | undefined {
  const c = normalizeMessageContent(message)
  if (!c || depth > 2) return
  const kind = getContentType(c)
  if (!kind || SKIP.has(kind)) return
  if (kind === 'deviceSentMessage') return extract(c.deviceSentMessage?.message, depth + 1)

  const result = describe(c, kind)
  const ctx = contextInfo(c, kind)
  if (ctx?.quotedMessage) {
    const q = extract(ctx.quotedMessage, depth + 1)?.text
    if (q) result.quoted = q.length > QUOTE_MAX ? q.slice(0, QUOTE_MAX) + '…' : q
  }
  return result
}

function describe(c: proto.IMessage, kind: keyof proto.IMessage): Extracted {
  const withCaption = (label: string, caption?: string | null) => (caption ? `[${label}] ${caption}` : `[${label}]`)
  switch (kind) {
    case 'conversation':
      return { type: 'text', text: c.conversation ?? '' }
    case 'extendedTextMessage':
      return { type: 'text', text: c.extendedTextMessage?.text ?? '' }
    case 'imageMessage':
      return { type: 'image', text: withCaption('image', c.imageMessage?.caption) }
    case 'videoMessage': {
      const gif = !!c.videoMessage?.gifPlayback
      return { type: gif ? 'gif' : 'video', text: withCaption(gif ? 'gif' : 'video', c.videoMessage?.caption) }
    }
    case 'ptvMessage':
      return { type: 'video', text: '[video note]' }
    case 'audioMessage': {
      const a = c.audioMessage
      const secs = a?.seconds ?? 0
      const dur = secs ? ` ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : ''
      return a?.ptt ? { type: 'voice', text: `[voice note${dur}]` } : { type: 'audio', text: `[audio${dur}]` }
    }
    case 'documentMessage': {
      const d = c.documentMessage
      return { type: 'document', text: withCaption(`document: ${d?.fileName ?? d?.title ?? 'file'}`, d?.caption) }
    }
    case 'stickerMessage':
    case 'lottieStickerMessage':
      return { type: 'sticker', text: '[sticker]' }
    case 'locationMessage': {
      const l = c.locationMessage
      const label = [l?.name, l?.address].filter(Boolean).join(', ')
      return { type: 'location', text: `[location${label ? `: ${label}` : ''} (${l?.degreesLatitude}, ${l?.degreesLongitude})]` }
    }
    case 'liveLocationMessage':
      return { type: 'location', text: withCaption('live location', c.liveLocationMessage?.caption) }
    case 'contactMessage':
      return { type: 'contact', text: `[contact: ${c.contactMessage?.displayName ?? '?'}]` }
    case 'contactsArrayMessage': {
      const names = (c.contactsArrayMessage?.contacts ?? []).map(x => x.displayName).filter(Boolean)
      return { type: 'contact', text: `[contacts: ${names.join(', ')}]` }
    }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': {
      const p = c[kind]
      const opts = (p?.options ?? []).map(o => o.optionName).filter(Boolean)
      return { type: 'poll', text: `[poll] ${p?.name ?? ''}${opts.length ? ` — ${opts.join(' / ')}` : ''}` }
    }
    case 'eventMessage': {
      const e = c.eventMessage
      const start = e?.startTime ? ` @ ${new Date(toNumber(e.startTime) * 1000).toISOString()}` : ''
      return { type: 'event', text: `[event] ${e?.name ?? ''}${start}${e?.description ? ` — ${e.description}` : ''}` }
    }
    case 'groupInviteMessage':
      return { type: 'invite', text: `[group invite: ${c.groupInviteMessage?.groupName ?? '?'}]` }
    case 'callLogMesssage':
      return { type: 'call', text: c.callLogMesssage?.isVideo ? '[video call]' : '[call]' }
    // Business / bot messages: surface whatever readable text they carry.
    case 'buttonsMessage':
      return { type: 'text', text: c.buttonsMessage?.contentText ?? '[buttons]' }
    case 'listMessage':
      return { type: 'text', text: [c.listMessage?.title, c.listMessage?.description].filter(Boolean).join('\n') || '[list]' }
    case 'templateMessage':
      return { type: 'text', text: c.templateMessage?.hydratedTemplate?.hydratedContentText ?? '[template]' }
    case 'interactiveMessage':
      return { type: 'text', text: c.interactiveMessage?.body?.text ?? '[interactive]' }
    case 'buttonsResponseMessage':
      return { type: 'text', text: c.buttonsResponseMessage?.selectedDisplayText ?? '[button reply]' }
    case 'listResponseMessage':
      return { type: 'text', text: c.listResponseMessage?.title ?? '[list reply]' }
    case 'templateButtonReplyMessage':
      return { type: 'text', text: c.templateButtonReplyMessage?.selectedDisplayText ?? '[button reply]' }
    case 'interactiveResponseMessage':
      return { type: 'text', text: c.interactiveResponseMessage?.body?.text ?? '[interactive reply]' }
    default:
      return { type: 'other', text: `[${String(kind).replace(/Message$/, '')}]` }
  }
}

function contextInfo(c: proto.IMessage, kind: keyof proto.IMessage): proto.IContextInfo | null | undefined {
  const inner = c[kind]
  if (inner && typeof inner === 'object' && 'contextInfo' in inner) {
    return inner.contextInfo as proto.IContextInfo | null | undefined
  }
}
