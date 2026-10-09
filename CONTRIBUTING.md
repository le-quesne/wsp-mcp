# Contributing

Thanks for helping. Issues and pull requests are both welcome.

## Before you start

- **Use a test number.** Link a second WhatsApp account (a spare SIM, or WhatsApp Business on another
  number) while developing, especially anything that sends.
- **Never commit anything from `~/.whatsapp-mcp`**: session keys, the database, media or logs. Screenshots
  and logs in issues should show test chats only.
- For anything bigger than a fix, open an issue first so we can agree on the approach.

## Setup

```sh
pnpm install
pnpm run doctor   # what's set up and what isn't
```

To run your checkout without touching your real data, point it at a scratch folder:
`WA_MCP_HOME=/tmp/wsp-dev pnpm bridge`.

## Checks

```sh
pnpm typecheck
pnpm test
```

CI runs both on every push and pull request, and builds the menu bar app on macOS.

Tests use Node's built-in runner (`node --test`), with no extra dependencies. They live in `test/` and
cover the pure parts: the send allowlist, the config defaults, message parsing and chat lookup. If you
change one of those, add the case that would have caught the bug.

## Style

- TypeScript that Node runs directly: only erasable syntax (no enums, no namespaces, no parameter
  properties), and imports with the `.ts` extension.
- Comments explain *why*, not what.
- Anything that sends must go through the bridge, so the allowlist, the optional dialog and the pacing
  apply. Pull requests that add a way around them, or that make bulk sending easier, won't be merged.
- User-facing text in English, short and concrete.
