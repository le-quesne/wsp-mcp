# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- Writing like you. `pnpm run voice` learns how you text from your own messages, compared with what your
  contacts write: length, messages per turn, punctuation, laughter, emoji, your words and the ones you never
  use, and the same per chat (including words you use elsewhere but never in that chat). `--narrative` also
  has Claude Code read a sample of your chats and write your archetype to `voice.md`.
- `style_guide` tool: how you write, in general and in a given chat, with your own recent messages there.
- `send_message` takes `parts`: several short messages in a row, each with "typing…" first. Every part is
  checked against your profile before anything goes out, and what doesn't sound like you comes back to
  rewrite (`verbatim` sends dictated text as is). `send_file` checks captions the same way.
- The bridge marks the messages it sends (`sent_by_bridge`), so the profile only learns from what you typed.

## [0.2.0] - 2026-10-08

### Changed

- Sending is on by default: to anyone (`"allowedRecipients": ["*"]`) and without the confirmation
  dialog (`"confirmBeforeSending": false`). Config files that already exist keep their values.

### Added

- Pacing: a message to someone other than the last recipient waits until 15 s after the previous send
  (`minSecondsBetweenRecipients`). Replies in the same chat aren't held.
- The bridge tells Claude when the same text already went to other chats in the last 24 hours, and the
  tool descriptions tell it how to protect the number: no repeated texts, no lists, no cold messages.
- "Avoiding a ban" in the README.

- Install with one prompt: paste the prompt from the README into Claude Code and type an 8-character
  code on your phone. `pnpm run setup --phone <number>` links with a code instead of a QR, so setup
  runs without a terminal.
- The background bridge does the linking itself (`scripts/agent.sh pair <number>`) and keeps running
  afterwards, so nothing restarts it in the middle of the first history import, which would lose
  messages: WhatsApp's history chunks are confirmed before they're downloaded.
- In a terminal, setup asks for your number and links by code; pressing Enter falls back to the QR.

### Fixed

- A pairing code that was requested but never typed counted as a linked phone: asking for the code
  already fills in the session's `me`. The bridge, the background agent, setup and doctor now wait
  for `account`, which only a confirmed link writes.
- After a pairing code that was never typed, the next attempt tried to log in with it instead of
  asking for a new link. The bridge now drops the unfinished attempt and starts over.
- A custom data folder (`WA_MCP_HOME`) only reached the terminal bridge. The background bridge, the menu
  bar app and the Claude Code registration now use it too.

## [0.1.0] - 2026-10-08

First public release.

### Added

- Bridge that links as a WhatsApp device (Baileys), imports your history and keeps a local SQLite copy.
- MCP server with `status`, `list_chats`, `search_contacts`, `get_messages`, `search_messages`,
  `get_media`, `send_message` and `send_file`.
- Local transcription of voice notes and videos with whisper.cpp; incoming voice notes are
  transcribed as they arrive and become searchable.
- Sending gated by a recipient allowlist and a macOS confirmation dialog, both enforced in the bridge.
- `pnpm run setup`: from a fresh clone to a working install, skipping what's already done.
- `pnpm run doctor`: checks every piece and prints the fix for each problem.
- Background agent (launchd) and menu bar status icon.
- Tests for the send allowlist, config defaults, message parsing and chat lookup; CI on every push.

[0.2.0]: https://github.com/le-quesne/wsp-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/le-quesne/wsp-mcp/releases/tag/v0.1.0
