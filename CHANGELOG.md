# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org).

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

[0.1.0]: https://github.com/le-quesne/wsp-mcp/releases/tag/v0.1.0
