# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org).

## [0.2.0] - 2026-10-08

### Added

- Install with one prompt: paste the prompt from the README into Claude Code and type an 8-character
  code on your phone. `pnpm run setup --phone <number>` links with a code instead of a QR, so setup
  runs without a terminal.
- After linking, setup waits for the first history import to settle before handing the session to
  the background bridge.

### Fixed

- A pairing code that was requested but never typed counted as a linked phone: asking for the code
  already fills in the session's `me`. The bridge, the background agent, setup and doctor now wait
  for `account`, which only a confirmed link writes.

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
