# wsp-mcp

Read and (carefully) reply to your personal WhatsApp from Claude Code.

```
WhatsApp ⇄ bridge (linked device, Baileys) ──writes──▶ ~/.whatsapp-mcp/messages.db (SQLite)
                 ▲                                              │ reads
                 └──── Unix socket (send only) ──── MCP server ◀┘ ◀── Claude Code
```

- **bridge** (`pnpm bridge`): links as a device like WhatsApp Web, imports your history, keeps
  syncing new messages, and is the only thing that can send.
- **MCP server** (`src/mcp.ts`): tools `status`, `list_chats`, `search_contacts`,
  `get_messages`, `search_messages`, `get_media`, `send_message`, `send_file`.

Node ≥ 24 runs the TypeScript directly; there is no build step. macOS only for now: the send
confirmation dialog, the background agent (launchd) and the menu bar icon are Mac-specific.

## Setup

1. **Install and pair** (once), in a normal terminal window:

   ```sh
   git clone https://github.com/le-quesne/wsp-mcp.git
   cd wsp-mcp
   pnpm install
   pnpm bridge
   ```

   Scan the QR code: WhatsApp → Settings → Linked devices → Link a device.
   Or use a pairing code instead: `pnpm bridge --phone 5491112345678`.
   Then wait while it prints `History sync: …` lines (the full import can take a few minutes).

2. **Keep it running.** Either leave that terminal open, or run it in the background:

   ```sh
   pnpm agent:install     # launchd, starts at login, restarts on crash
   pnpm agent:status
   pnpm agent:uninstall
   ```

   Stop the terminal bridge first (Ctrl+C): only one bridge can hold the session.
   The agent is pinned to the current `node` binary; reinstall it after switching Node versions.

   **Menu bar icon** (native Swift, needs Xcode command line tools): `pnpm menubar:install`.
   A speech bubble with a dot: green = connected (`↓ 141k` while history imports),
   orange = connecting, red = bridge not running. Click it for counts, last message, data folder.
   `build/whatsapp-status --check` prints the same in the terminal. Remove: `pnpm menubar:uninstall`.

3. **Register with Claude Code**, from the repo folder:

   ```sh
   claude mcp add whatsapp --scope user -- node --disable-warning=ExperimentalWarning "$PWD/src/mcp.ts"
   ```

## Photos, audio, video and documents

Message lines show `(media id: …)`; `get_media` downloads that file into `~/.whatsapp-mcp/media`:

- **Photos** come back as images Claude can see.
- **Voice notes, audio, video** are transcribed locally with whisper.cpp
  (`brew install whisper-cpp ffmpeg`, model `~/.cache/whisper-cpp/ggml-large-v3-turbo-q8_0.bin`,
  override with `WA_WHISPER_MODEL`). Videos also return three still frames.
- **Documents** are saved and their path returned (Claude opens PDFs with its Read tool).

Incoming voice notes (≤ 10 min) are transcribed as they arrive, so `search_messages` finds what was
said in them; turn that off with `"autoTranscribe": false` in `config.json`.

The bridge keeps each message's download keys from now on. Messages imported before that have none:
`get_media` then asks your phone to resend that stretch of the chat (~15–40 s), which only works if
the phone still has the file. A message deleted "for everyone" also deletes its downloaded file.

## Sending

Disabled until you allow recipients in `~/.whatsapp-mcp/config.json`:

```json
{ "allowedRecipients": ["5491112345678", "120363000000000000@g.us"] }
```

Phone numbers with country code (any formatting), exact chat ids (groups), or `"*"` for anyone.
The file is re-read on every send.

By default **every message pops up a macOS dialog** showing the recipient and the full text; only
clicking **Send** sends (Return/Escape cancel, it gives up after 2 minutes). That check lives in the
bridge, so it holds even when Claude Code runs with permission prompts off.
`send_message` sends text (max 2000 characters). `send_file` sends a local file with an optional
caption: videos as playable videos (over 16 MB they're compressed to 720p first, which needs
ffmpeg), anything else as a document under 16 MB. Same allowlist and same dialog.

`"confirmBeforeSending": false` turns the dialog off: messages go out as soon as Claude sends them.
Then nothing but the model's judgment sits between a message you received and one sent in your name.

## Privacy and risks

- Everything stays on this Mac (`~/.whatsapp-mcp`, owner-only permissions). Only what a tool
  returns reaches the model.
- `auth/` holds your WhatsApp session keys: anyone with that folder can read and send as you.
- The bridge doesn't mark you online and reading doesn't send read receipts. Your phone keeps its
  notifications.
- Messages deleted "for everyone" are blanked in the database too.
- **Unofficial API:** Baileys speaks the WhatsApp Web protocol, which is against WhatsApp's terms.
  Reading is low-risk; automated or bulk sending can get a number banned.
- **Prompt injection:** anyone who messages you can write instructions aimed at the model. The tools
  label message text as untrusted, and sending needs your click. But in the same session Claude can
  also reach other tools (Gmail, Slack…). Be suspicious if Claude proposes something you didn't ask for
  after reading chats.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `status` says the bridge isn't running | `pnpm bridge` or `pnpm agent:install` |
| Bridge says it was logged out | `rm -rf ~/.whatsapp-mcp/auth` and pair again |
| "Another bridge is already running" | Stop the terminal one or `pnpm agent:uninstall` |
| Background logs | `tail -f ~/.whatsapp-mcp/bridge.log` |
| Baileys debug output | `WA_LOG_LEVEL=debug pnpm bridge` |

## Remove completely

1. WhatsApp on your phone → Linked devices → log out the "Mac OS" device.
2. Run:

```sh
pnpm agent:uninstall
claude mcp remove whatsapp --scope user
rm -rf ~/.whatsapp-mcp
```
