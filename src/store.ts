import { unlinkSync } from 'node:fs'
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import {
  isJidGroup,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  toNumber,
  type Chat,
  type Contact,
  type GroupMetadata,
  type WAMessage,
  type WAMessageKey,
} from 'baileys'
import { norm } from './db.ts'
import { extract, type Extracted } from './extract.ts'

// Only people and groups. Status updates, channels and broadcast lists are left out.
export const isStorableJid = (jid: string): boolean =>
  jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid') || jid.endsWith('@g.us')

type Params = Record<string, SQLInputValue>

// For people not in the phone's address book WhatsApp sends a masked number ("+56∙∙∙∙∙∙∙44")
// as their name. It's a placeholder, not a name: drop it so their profile name shows instead.
export const cleanName = (name: string | null | undefined): string | null =>
  name && !name.includes('∙') ? name : null

export type MediaKind = 'image' | 'video' | 'audio' | 'document'

const MEDIA_KIND: Record<string, MediaKind> = {
  image: 'image',
  video: 'video',
  gif: 'video',
  voice: 'audio',
  audio: 'audio',
  document: 'document',
}

export type MediaRow = {
  chat: string
  id: string
  kind: MediaKind
  mimetype: string | null
  fileName: string | null
  raw: Uint8Array
  localPath: string | null
  transcript: string | null
}

function mediaInfo(m: WAMessage): { mimetype: string | null; fileName: string | null } {
  const c = normalizeMessageContent(m.message)
  const inner = c?.imageMessage ?? c?.videoMessage ?? c?.ptvMessage ?? c?.audioMessage ?? c?.documentMessage
  const fileName = inner && 'fileName' in inner ? (inner.fileName ?? null) : null
  return { mimetype: inner?.mimetype ?? null, fileName }
}

export class Store {
  readonly db: DatabaseSync
  private lidToPn = new Map<string, string>()
  private txDepth = 0
  private s: Record<string, StatementSync>

  constructor(db: DatabaseSync) {
    this.db = db
    for (const r of db.prepare('SELECT lid, pn FROM lid_map').all()) {
      this.lidToPn.set(String(r.lid), String(r.pn))
    }
    this.s = {
      upsertMessage: db.prepare(`
        INSERT INTO messages (chat_jid, id, from_me, sender_jid, push_name, ts, type, text, text_norm, quoted_text)
        VALUES ($chat, $id, $fromMe, $sender, $pushName, $ts, $type, $text, $textNorm, $quoted)
        ON CONFLICT (chat_jid, id) DO UPDATE SET
          sender_jid = COALESCE(excluded.sender_jid, messages.sender_jid),
          push_name = COALESCE(excluded.push_name, messages.push_name),
          type = excluded.type,
          text = excluded.text,
          text_norm = excluded.text_norm,
          quoted_text = COALESCE(excluded.quoted_text, messages.quoted_text)
        WHERE messages.edited = 0 AND messages.deleted = 0`),
      editMessage: db.prepare(`
        UPDATE messages SET type = $type, text = $text, text_norm = $textNorm, edited = 1
        WHERE chat_jid = $chat AND id = $id AND deleted = 0`),
      // Respect "delete for everyone": drop the content, keep the trace.
      deleteMessage: db.prepare(`
        UPDATE messages SET text = '[deleted]', text_norm = '', quoted_text = NULL, deleted = 1
        WHERE chat_jid = $chat AND id = $id`),
      upsertChat: db.prepare(`
        INSERT INTO chats (jid, name, is_group, archived, last_message_at)
        VALUES ($jid, $name, $isGroup, COALESCE($archived, 0), $ts)
        ON CONFLICT (jid) DO UPDATE SET
          name = COALESCE($name, chats.name),
          archived = COALESCE($archived, chats.archived),
          last_message_at = NULLIF(MAX(COALESCE($ts, 0), COALESCE(chats.last_message_at, 0)), 0)`),
      upsertContact: db.prepare(`
        INSERT INTO contacts (jid, name, notify, verified_name) VALUES ($jid, $name, $notify, $verified)
        ON CONFLICT (jid) DO UPDATE SET
          name = COALESCE($name, contacts.name),
          notify = COALESCE($notify, contacts.notify),
          verified_name = COALESCE($verified, contacts.verified_name)`),
      // History carries old push names, so it only fills gaps; live messages overwrite.
      fillNotify: db.prepare(`
        INSERT INTO contacts (jid, notify) VALUES ($jid, $notify)
        ON CONFLICT (jid) DO UPDATE SET notify = COALESCE(contacts.notify, $notify)`),
      // Merging a LID row into its phone-number row: existing phone-number data wins.
      mergeContact: db.prepare(`
        INSERT INTO contacts (jid, name, notify, verified_name) VALUES ($jid, $name, $notify, $verified)
        ON CONFLICT (jid) DO UPDATE SET
          name = COALESCE(contacts.name, $name),
          notify = COALESCE(contacts.notify, $notify),
          verified_name = COALESCE(contacts.verified_name, $verified)`),
      insertMapping: db.prepare('INSERT OR REPLACE INTO lid_map (lid, pn) VALUES (?, ?)'),
      moveMessages: db.prepare('UPDATE OR IGNORE messages SET chat_jid = $pn WHERE chat_jid = $lid'),
      dropMessages: db.prepare('DELETE FROM messages WHERE chat_jid = $lid'),
      moveSenders: db.prepare('UPDATE messages SET sender_jid = $pn WHERE sender_jid = $lid'),
      getChat: db.prepare('SELECT name, archived, last_message_at FROM chats WHERE jid = ?'),
      fillChatName: db.prepare('UPDATE chats SET name = COALESCE(name, ?) WHERE jid = ?'),
      deleteChat: db.prepare('DELETE FROM chats WHERE jid = ?'),
      getContact: db.prepare('SELECT name, notify, verified_name FROM contacts WHERE jid = ?'),
      deleteContact: db.prepare('DELETE FROM contacts WHERE jid = ?'),
      setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
      // A newer copy of the message (e.g. re-sent history) carries fresher download info.
      upsertMedia: db.prepare(`
        INSERT INTO media (chat_jid, id, kind, mimetype, file_name, raw)
        VALUES ($chat, $id, $kind, $mimetype, $fileName, $raw)
        ON CONFLICT (chat_jid, id) DO UPDATE SET
          raw = excluded.raw,
          mimetype = COALESCE(excluded.mimetype, media.mimetype),
          file_name = COALESCE(excluded.file_name, media.file_name)`),
      getMedia: db.prepare(
        'SELECT kind, mimetype, file_name, raw, local_path, transcript FROM media WHERE chat_jid = ? AND id = ?',
      ),
      setMediaPath: db.prepare('UPDATE media SET local_path = ? WHERE chat_jid = ? AND id = ?'),
      setTranscript: db.prepare('UPDATE media SET transcript = ?, transcript_norm = ? WHERE chat_jid = ? AND id = ?'),
      deleteMedia: db.prepare('DELETE FROM media WHERE chat_jid = ? AND id = ? RETURNING local_path'),
      moveMedia: db.prepare('UPDATE OR IGNORE media SET chat_jid = $pn WHERE chat_jid = $lid'),
      dropMedia: db.prepare('DELETE FROM media WHERE chat_jid = $lid'),
      nextMessage: db.prepare(
        'SELECT id, from_me, ts FROM messages WHERE chat_jid = ? AND ts > ? ORDER BY ts, rowid LIMIT 1',
      ),
      messageTs: db.prepare('SELECT ts FROM messages WHERE chat_jid = ? AND id = ?'),
      messageType: db.prepare('SELECT type FROM messages WHERE chat_jid = ? AND id = ?'),
    }
  }

  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn()
    this.db.exec('BEGIN')
    this.txDepth++
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    } finally {
      this.txDepth--
    }
  }

  canon(jid: string | null | undefined): string | undefined {
    if (!jid) return
    const n = jidNormalizedUser(jid)
    if (!n) return
    return isLidUser(n) ? (this.lidToPn.get(n) ?? n) : n
  }

  // Accepts the two JIDs in either order; ignores anything that isn't a LID/PN pair.
  mapPair(a: string | null | undefined, b: string | null | undefined): void {
    if (!a || !b) return
    const x = jidNormalizedUser(a)
    const y = jidNormalizedUser(b)
    if (isLidUser(x) && isPnUser(y)) this.addMapping(x, y)
    else if (isPnUser(x) && isLidUser(y)) this.addMapping(y, x)
  }

  private addMapping(lid: string, pn: string): void {
    if (this.lidToPn.get(lid) === pn) return
    this.lidToPn.set(lid, pn)
    const s = this.s
    this.tx(() => {
      s.insertMapping.run(lid, pn)
      s.moveMessages.run({ pn, lid })
      s.dropMessages.run({ lid })
      s.moveSenders.run({ pn, lid })
      s.moveMedia.run({ pn, lid })
      s.dropMedia.run({ lid })
      const chat = s.getChat.get(lid)
      if (chat) {
        s.upsertChat.run({
          jid: pn,
          name: null,
          isGroup: 0,
          archived: chat.archived as number,
          ts: (chat.last_message_at as number | null) ?? null,
        })
        if (chat.name) s.fillChatName.run(chat.name, pn)
        s.deleteChat.run(lid)
      }
      const contact = s.getContact.get(lid)
      if (contact) {
        s.mergeContact.run({
          jid: pn,
          name: contact.name ?? null,
          notify: contact.notify ?? null,
          verified: contact.verified_name ?? null,
        } as Params)
        s.deleteContact.run(lid)
      }
    })
  }

  storeMessage(m: WAMessage, live: boolean): boolean {
    const key = m.key
    if (!key?.remoteJid || !key.id) return false
    this.mapPair(key.remoteJid, key.remoteJidAlt)
    this.mapPair(key.participant, key.participantAlt)
    const chat = this.canon(key.remoteJid)
    if (!chat || !isStorableJid(chat)) return false
    const ex = extract(m.message)
    if (!ex) return false

    const ts = toNumber(m.messageTimestamp) || Math.floor(Date.now() / 1000)
    const group = !!isJidGroup(chat)
    const sender = key.fromMe ? null : (this.canon(group ? key.participant : key.remoteJid) ?? null)
    this.s.upsertMessage.run({
      chat,
      id: key.id,
      fromMe: key.fromMe ? 1 : 0,
      sender,
      pushName: key.fromMe ? null : (m.pushName ?? null),
      ts,
      type: ex.type,
      text: ex.text,
      textNorm: norm(ex.text),
      quoted: ex.quoted ?? null,
    })
    this.upsertChat({ jid: chat, isGroup: group, lastMessageAt: ts })
    const kind = MEDIA_KIND[ex.type]
    if (kind) {
      this.s.upsertMedia.run({
        chat,
        id: key.id,
        kind,
        ...mediaInfo(m),
        raw: proto.WebMessageInfo.encode(m).finish(),
      })
    }
    if (sender && m.pushName) {
      ;(live ? this.s.upsertContact : this.s.fillNotify).run(
        live ? { jid: sender, name: null, notify: m.pushName, verified: null } : { jid: sender, notify: m.pushName },
      )
    }
    return true
  }

  editMessage(key: WAMessageKey, ex: Extracted): void {
    const chat = this.canon(key.remoteJid)
    if (!chat || !key.id) return
    this.s.editMessage.run({ chat, id: key.id, type: ex.type, text: ex.text, textNorm: norm(ex.text) })
  }

  deleteMessage(key: WAMessageKey): void {
    const chat = this.canon(key.remoteJid)
    if (!chat || !key.id) return
    this.s.deleteMessage.run({ chat, id: key.id })
    // Deleted for everyone: the file goes too.
    const gone = this.s.deleteMedia.get(chat, key.id)
    if (gone?.local_path) {
      try {
        unlinkSync(String(gone.local_path))
      } catch {}
    }
  }

  getMedia(chat: string, id: string): MediaRow | undefined {
    const r = this.s.getMedia.get(chat, id)
    if (!r) return
    return {
      chat,
      id,
      kind: r.kind as MediaKind,
      mimetype: (r.mimetype as string | null) ?? null,
      fileName: (r.file_name as string | null) ?? null,
      raw: r.raw as Uint8Array,
      localPath: (r.local_path as string | null) ?? null,
      transcript: (r.transcript as string | null) ?? null,
    }
  }

  messageType(chat: string, id: string): string | undefined {
    const r = this.s.messageType.get(chat, id)
    return r ? String(r.type) : undefined
  }

  setMediaPath(chat: string, id: string, path: string): void {
    this.s.setMediaPath.run(path, chat, id)
  }

  setTranscript(chat: string, id: string, text: string): void {
    this.s.setTranscript.run(text, norm(text), chat, id)
  }

  // The message right after (chat, id): history on demand returns messages older than an anchor.
  anchorAfter(chat: string, id: string): { id: string; fromMe: boolean; ts: number } | undefined {
    const at = this.s.messageTs.get(chat, id)
    if (!at) return
    const r = this.s.nextMessage.get(chat, at.ts as number)
    return r ? { id: String(r.id), fromMe: r.from_me === 1, ts: Number(r.ts) } : undefined
  }

  // Phone-number chats may still be keyed by LID on the phone.
  lidFor(pn: string): string | undefined {
    for (const [lid, p] of this.lidToPn) if (p === pn) return lid
  }

  upsertChat(c: { jid: string; name?: string | null; isGroup: boolean; archived?: boolean; lastMessageAt?: number | null }): void {
    this.s.upsertChat.run({
      jid: c.jid,
      name: c.name || null,
      isGroup: c.isGroup ? 1 : 0,
      archived: c.archived === undefined ? null : c.archived ? 1 : 0,
      ts: c.lastMessageAt || null,
    })
  }

  upsertWAChat(chat: Partial<Chat>): void {
    if (!chat.id) return
    this.mapPair(chat.id, chat.pnJid)
    this.mapPair(chat.id, chat.lidJid)
    this.mapPair(chat.lidJid, chat.pnJid)
    const jid = this.canon(chat.id)
    if (!jid || !isStorableJid(jid)) return
    const ts = chat.conversationTimestamp ? toNumber(chat.conversationTimestamp) : chat.lastMessageRecvTimestamp
    this.upsertChat({
      jid,
      name: cleanName(chat.name) ?? cleanName(chat.displayName),
      isGroup: !!isJidGroup(jid),
      archived: typeof chat.archived === 'boolean' ? chat.archived : undefined,
      lastMessageAt: ts || null,
    })
  }

  upsertContact(c: Partial<Contact>): void {
    this.mapPair(c.id, c.lid)
    this.mapPair(c.id, c.phoneNumber)
    const jid = this.canon(c.id)
    if (!jid || isJidGroup(jid) || !isStorableJid(jid)) return
    this.s.upsertContact.run({
      jid,
      name: cleanName(c.name),
      notify: cleanName(c.notify),
      verified: cleanName(c.verifiedName),
    })
  }

  upsertGroup(g: Partial<GroupMetadata>): void {
    if (g.id && g.subject) this.upsertChat({ jid: g.id, name: g.subject, isGroup: true })
  }

  setMeta(key: string, value: string): void {
    this.s.setMeta.run(key, value)
  }
}
