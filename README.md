<h1 align="center">wsp-mcp</h1>

<p align="center">
  <b>Your WhatsApp in Claude Code.</b><br>
  Read, search and summarize your chats, hear voice notes, and reply, from your Mac,<br>
  with every message you send approved by you.
</p>

<p align="center">
  <a href="https://github.com/le-quesne/wsp-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/le-quesne/wsp-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node 24 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2024-339933?logo=node.js&logoColor=white">
  <img alt="macOS" src="https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple">
  <a href="https://modelcontextprotocol.io"><img alt="MCP server" src="https://img.shields.io/badge/MCP-server-8A2BE2"></a>
</p>

<!-- Demo: docs/demo.gif. Record it with a test account, never with real chats. -->

> [!WARNING]
> **Not affiliated with WhatsApp or Meta.** It connects through [Baileys](https://github.com/WhiskeySockets/Baileys),
> an unofficial client of the WhatsApp Web protocol, which goes against WhatsApp's terms. Reading is
> low-risk; automated or bulk sending can get a number banned. Use it with your own account, at your own risk.

## What you can ask

- *"What did the family group decide about Saturday?"*
- *"Summarize what I missed in the work chats since yesterday."*
- *"Find the message where Ana sent the apartment address."*
- *"What does Pedro's voice note say?"*
- *"Tell Ana I'll be there at 8."* A dialog on your Mac shows the recipient and the full text, and nothing
  goes out until you click **Send**.

## Why this one

- **Your messages stay on your Mac.** They live in a local SQLite file only your user can read, and voice
  notes are transcribed on-device with whisper.cpp. Claude only sees what a tool returns to it.
- **The model can't send on its own.** Sending needs a recipient you listed by hand *and* your click in a
  macOS dialog. Both checks live in the bridge, outside Claude, so they hold even with Claude Code's
  permission prompts turned off.
- **Ready for prompt injection.** Anyone can message you, so every read tells the model that message
  text is data, not instructions.
- **Quiet.** It doesn't show you as online and doesn't send read receipts. Your phone keeps its
  notifications.
- **Your whole history, searchable.** It imports your history when you link it, keeps syncing, and
  search ignores accents and covers what was said in voice notes.

## Quick start

You need macOS, [Node 24+](https://nodejs.org), [pnpm](https://pnpm.io),
[Claude Code](https://claude.com/claude-code) and, for voice notes, [Homebrew](https://brew.sh).

```sh
git clone https://github.com/le-quesne/wsp-mcp.git
cd wsp-mcp
pnpm run setup
```

Setup installs the dependencies, offers ffmpeg, whisper.cpp and the speech model (about 870 MB), shows
the QR code to link your phone, keeps the bridge running in the background, and registers the server
with Claude Code. Each step checks first, so it's safe to run again.

Then restart Claude Code. Sending stays off until you allow recipients (see [Sending](#sending)).

When something doesn't work, `pnpm run doctor` checks every piece and tells you the command that fixes it.

## How it works

```
WhatsApp ⇄ bridge (linked device, Baileys) ──writes──▶ ~/.whatsapp-mcp/messages.db (SQLite)
                 ▲                                              │ reads
                 └──── Unix socket (send only) ──── MCP server ◀┘ ◀── Claude Code
```

- **The bridge** (`src/bridge.ts`) links as a device, like WhatsApp Web, imports your history and keeps
  syncing. It's the only part that talks to WhatsApp, and the only one that can send.
- **The MCP server** (`src/mcp.ts`) reads the database and asks the bridge to send or download.

Node 24 runs the TypeScript directly: there's no build step.

## Tools

| Tool | What it does |
| --- | --- |
| `status` | Whether the bridge is connected, how much history is stored, and who sending is allowed to |
| `list_chats` | Chats by latest activity, with a preview of the last message; direct, groups or both |
| `search_contacts` | People and groups by name or phone digits |
| `get_messages` | A conversation (or every chat) in a time window, in order |
| `search_messages` | Full-text search across chats, voice notes included |
| `get_media` | The photo, voice note, video or document behind a message: photos as images, audio and video as transcripts |
| `send_message` | Text to an allowed recipient, after your click |
| `send_file` | A video, image or document to an allowed recipient, after your click |

## Setting it up by hand

`pnpm run setup` does all of this. Here it is step by step, if you'd rather see each part.

1. **Install and link your phone**, in a terminal window:

   ```sh
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

3. **Menu bar icon** (optional, needs the Xcode command line tools): `pnpm menubar:install`.
   A speech bubble with a dot: green = connected (`↓ 141k` while history imports),
   orange = connecting, red = bridge not running. Click it for counts, last message, data folder.
   `build/whatsapp-status --check` prints the same in the terminal. Remove: `pnpm menubar:uninstall`.

4. **Register with Claude Code**, from the repo folder:

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

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Anything | `pnpm run doctor` |
| `status` says the bridge isn't running | `pnpm bridge` or `pnpm agent:install` |
| Bridge says it was logged out | `rm -rf ~/.whatsapp-mcp/auth` and link again |
| "Another bridge is already running" | Stop the terminal one or `pnpm agent:uninstall` |
| Background logs | `tail -f ~/.whatsapp-mcp/bridge.log` |
| Baileys debug output | `WA_LOG_LEVEL=debug pnpm bridge` |

## Remove completely

1. WhatsApp on your phone → Linked devices → log out the "Mac OS" device.
2. Run:

```sh
pnpm agent:uninstall
pnpm menubar:uninstall
claude mcp remove whatsapp --scope user
rm -rf ~/.whatsapp-mcp
```

## Contributing

Issues and pull requests are welcome; [CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the checks.
Please report security problems privately, as [SECURITY.md](SECURITY.md) explains.

## License

[MIT](LICENSE)
