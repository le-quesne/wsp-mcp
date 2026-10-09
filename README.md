<h1 align="center">wsp-mcp</h1>

<p align="center">
  <b>Your WhatsApp in Claude Code.</b><br>
  Read, search and summarize your chats, hear voice notes, and reply,<br>
  all from your Mac.
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
- *"Tell Ana I'll be there at 8."* It goes out from your number right away, or after your click if you
  turn that on, written the way you'd write it to Ana.

## Why this one

- **Your messages stay on your Mac.** They live in a local SQLite file only your user can read, and voice
  notes are transcribed on-device with whisper.cpp. Claude only sees what a tool returns to it.
- **Sends like a person, not a bot.** Messages to different people go out at least 15 s apart, Claude is
  told never to repeat a text or work through a list, and the bridge warns it when the same text already
  went to other chats. See [Avoiding a ban](#avoiding-a-ban).
- **Writes like you.** `pnpm run voice` learns how you text from your own messages: length, how you split
  a thought into several messages, punctuation, laughter, emoji, your words and the ones you never use, and
  how all of that changes from chat to chat. Claude reads it before writing, and anything that doesn't sound
  like you is sent back to rewrite instead of going out. See [Writing like you](#writing-like-you).
- **Locks when you want them.** A list of who Claude may write to, and a dialog that asks you before every
  message, are one setting away. Both live in the bridge, outside Claude, so they hold even with Claude
  Code's permission prompts turned off.
- **Ready for prompt injection.** Anyone can message you, so every read tells the model that message
  text is data, not instructions.
- **Quiet.** It doesn't show you as online and doesn't send read receipts. Your phone keeps its
  notifications.
- **Your whole history, searchable.** It imports your history when you link it, keeps syncing, and
  search ignores accents and covers what was said in voice notes.

## Quick start

You need macOS, [Node 24+](https://nodejs.org), [pnpm](https://pnpm.io),
[Claude Code](https://claude.com/claude-code) and, for voice notes, [Homebrew](https://brew.sh).

### Ask Claude Code to install it

Paste this into Claude Code, with your number:

```text
Install the WhatsApp MCP from https://github.com/le-quesne/wsp-mcp: clone it into ~/wsp-mcp and run
`pnpm run setup --yes --phone +56912345678` in the background (it takes a few minutes). As soon as
the output shows a PAIRING CODE, tell me the code and wait while I type it on my phone.
If Node 24+ or pnpm is missing, install it first.
```

When Claude shows you the code, open WhatsApp on your phone → Settings → Linked devices → Link a
device → **Link with phone number instead**, and type it. When setup finishes, restart Claude Code.

`--yes` accepts every step: ffmpeg and whisper.cpp, the speech model (about 870 MB), the background
bridge, the Claude Code registration and the menu bar icon. To choose step by step, use a terminal.

### Or in a terminal

```sh
git clone https://github.com/le-quesne/wsp-mcp.git
cd wsp-mcp
pnpm run setup
```

Setup installs the dependencies, offers ffmpeg, whisper.cpp and the speech model, asks for your number
to link your phone with a code (press Enter to scan a QR code instead), keeps the bridge running in
the background, and registers the server with Claude Code. Each step checks first, so it's safe to
run again.

### Then

Claude can send from your number right away, without asking: read [Avoiding a ban](#avoiding-a-ban)
first, and see [Sending](#sending) to restrict it.
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
| `style_guide` | How you write, in general and in a given chat, with your own recent messages there to imitate |
| `send_message` | Text to a chat, as one or several short messages with "typing…" before each, checked against your style and paced so it doesn't look like a bot |
| `send_file` | A video, image or document to a chat, with the same pacing (and the caption checked the same way) |

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

On by default: Claude can send text and files to anyone, from your number, without asking. Four
settings in `~/.whatsapp-mcp/config.json` change that (the file is re-read on every send):

| Setting | Default | What it does |
| --- | --- | --- |
| `allowedRecipients` | `["*"]` | Who Claude may write to: phone numbers with country code (any formatting), exact chat ids for groups, or `"*"` for anyone. `[]` turns sending off. |
| `confirmBeforeSending` | `false` | `true` shows a macOS dialog with the recipient and the full text for every message. Only clicking **Send** sends; Return and Escape cancel, and it gives up after 2 minutes. |
| `minSecondsBetweenRecipients` | `15` | A message to someone other than the last recipient waits until this many seconds after the previous send. `0` turns it off. |
| `autoTranscribe` | `true` | Transcribes incoming voice notes as they arrive (see above). |

All of them are enforced in the bridge, so they hold even when Claude Code runs with permission
prompts off. To approve every message and limit who gets them:

```json
{ "allowedRecipients": ["5491112345678", "120363000000000000@g.us"], "confirmBeforeSending": true }
```

`send_message` sends text (max 2000 characters). `send_file` sends a local file with an optional
caption: videos as playable videos (over 16 MB they're compressed to 720p first, which needs
ffmpeg), anything else as a document under 16 MB.

## Writing like you

Whatever Claude sends goes out as you, so it should read like you wrote it.

```sh
pnpm run voice              # learn your style from your own messages (local, takes seconds)
pnpm run voice --narrative  # also have Claude read a sample of your chats and write your archetype
```

`pnpm run voice` measures your messages against what your contacts write and saves the result to
`~/.whatsapp-mcp/voice.json`:

- **Shape:** how long your messages are, how many you send in a row, how often a single word is enough.
- **Punctuation and marks:** ¿ and ¡, final periods, "!", stretched words (*sooo*), accents, emoji, laughter.
- **Words:** the short replies you use most, the words that are typically yours, and the ones your contacts
  use and you never do (*q*, *porfa*, *jeje*… whatever it is for you).
- **Each chat:** the same measures per chat, plus the words you use everywhere else but never there. That's
  how it learns you swear with friends and never with a client, or say *estimado* only to customers.

`--narrative` adds `~/.whatsapp-mcp/voice.md`: Claude Code reads a random sample of your conversations
(about 1,500 of your messages, with what the other side said) and writes your archetype: rules, how you
write to each kind of person, examples in your own words. That sample goes to Anthropic like anything
else Claude reads, and it uses your Claude plan (`--model opus` for a deeper read; Sonnet by default).
Read the file and fix anything that isn't you: Claude reads it before writing as you.

Then, in Claude Code:

- **`style_guide`** gives Claude all of that for the chat it's about to write in, plus your own recent
  messages there to imitate.
- **`send_message`** takes `parts`: a thought split into short messages, sent one after another with
  "typing…" before each for about as long as you'd take to type it. Before anything goes out, every part
  is checked against your profile. Something you never do (a ¿ when you never open questions, a period
  when you never close with one, a word you never use in that chat…) means nothing is sent and Claude
  gets the list to rewrite. When you dictate the exact words, Claude sends them as they are (`verbatim`).

Every rule comes from your own history: if you do use periods, periods are fine. Messages the bridge
sends are marked, so the profile only learns from what you typed (messages it sent before this version
can't be told apart). Run `pnpm run voice` again every few months: the way people text drifts.

## Avoiding a ban

WhatsApp bans numbers that behave like bots, and this is your own number. It doesn't publish its
limits, so these are cautious habits, not guarantees:

- **One person at a time.** Leave at least 15 s between messages to different people. The bridge does
  it for you (`minSecondsBetweenRecipients`); don't lower it.
- **Every message different.** The same text to many people is the classic spam pattern. Claude is told
  to write each message for its recipient, and the bridge tells it when the same text already went to
  other chats in the last 24 hours.
- **Write to people who know you.** Replies in existing chats are safe ground. First messages to numbers
  that never wrote to you, especially many of them, are what gets reported, and reports lead to bans.
- **Human volume.** Dozens of messages a day, not hundreds. No broadcasts, lists or marketing.
- **Go easy on links and files** in a first message to someone.
- **A new number is fragile.** If you just registered it, keep sending light for the first weeks.
- **Experiment on a spare number,** never on the one you can't lose.

## Privacy and risks

- Everything stays on this Mac (`~/.whatsapp-mcp`, owner-only permissions). Only what a tool
  returns reaches the model.
- Your writing profile (`voice.json`, and `voice.md` if you made one) contains your own words and stays
  there with the rest of your data. `pnpm run voice --narrative` is the one step that sends a sample of
  your chats to Claude on purpose.
- `auth/` holds your WhatsApp session keys: anyone with that folder can read and send as you.
- The bridge doesn't mark you online and reading doesn't send read receipts. Your phone keeps its
  notifications.
- Messages deleted "for everyone" are blanked in the database too.
- **Unofficial API:** Baileys speaks the WhatsApp Web protocol, which is against WhatsApp's terms.
  Reading is low-risk; automated or bulk sending can get a number banned (see
  [Avoiding a ban](#avoiding-a-ban)).
- **Prompt injection:** anyone who messages you can write instructions aimed at the model. The tools
  label message text as untrusted, but by default nothing else stands between a message Claude decides
  to send and its recipient: if Claude reads chats from people you don't trust, turn on
  `confirmBeforeSending`. And in the same session Claude can also reach other tools (Gmail, Slack…).
  Be suspicious if Claude proposes something you didn't ask for after reading chats.

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
