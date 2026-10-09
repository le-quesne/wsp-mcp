import { chmodSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { DB_PATH } from './config.ts'

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- WhatsApp is moving 1:1 chats to LID addressing. Everything is stored under the
-- phone-number JID once the mapping is known, so one person = one chat.
CREATE TABLE IF NOT EXISTS lid_map (lid TEXT PRIMARY KEY, pn TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  name TEXT,           -- name in your address book
  notify TEXT,         -- the name they set on their own profile
  verified_name TEXT   -- business accounts
);

CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,           -- group subject, or the name WhatsApp gives the chat
  is_group INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  chat_jid TEXT NOT NULL,
  id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  sender_jid TEXT,
  push_name TEXT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  text_norm TEXT NOT NULL,  -- lowercased, accents stripped, for search
  quoted_text TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (chat_jid, ts);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
CREATE INDEX IF NOT EXISTS messages_sender ON messages (sender_jid);

-- What the bridge sent for Claude, so the writing profile (voice.ts) only learns from what the
-- user typed themselves.
CREATE TABLE IF NOT EXISTS sent_by_bridge (chat_jid TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (chat_jid, id));

-- What it takes to download a message's file later (WhatsApp only sends the keys once).
CREATE TABLE IF NOT EXISTS media (
  chat_jid TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,        -- image | video | audio | document
  mimetype TEXT,
  file_name TEXT,
  raw BLOB NOT NULL,         -- the encoded WebMessageInfo
  local_path TEXT,           -- set once downloaded
  transcript TEXT,           -- voice notes, audio and video
  transcript_norm TEXT,
  PRIMARY KEY (chat_jid, id)
);
`

export function openWriter(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  // Masked-number placeholders stored by earlier versions (see cleanName in store.ts).
  db.exec("UPDATE contacts SET name = NULL WHERE name LIKE '%∙%'; UPDATE chats SET name = NULL WHERE name LIKE '%∙%';")
  chmodSync(DB_PATH, 0o600)
  return db
}

export function openReader(): DatabaseSync | undefined {
  if (!existsSync(DB_PATH)) return
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

export const norm = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
