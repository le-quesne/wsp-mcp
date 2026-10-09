# Security

wsp-mcp reads your WhatsApp and can send messages in your name, so a bug here can do real harm.
Thanks for taking the time to report one.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/le-quesne/wsp-mcp/security/advisories/new).

Include what an attacker needs (a message they send you, access to your Mac, a malicious MCP
client…), the steps to reproduce, and what they get. You'll hear back within a week. Only the latest
version on `main` gets fixes.

## What it protects, and how

| Asset | Protection |
| --- | --- |
| Your messages and session keys (`~/.whatsapp-mcp`) | Never leave the Mac. The folder is `0700` and the database, config and downloaded media are `0600`. Anyone who can read `auth/` can act as you, so treat it like a password. |
| Sending in your name | On by default, to anyone, without asking. Locking it down is one setting away: an allowlist (`allowedRecipients`) and a macOS dialog with the recipient and the full text for every message (`confirmBeforeSending`). Both, and the pacing between different recipients, are enforced in the bridge process, outside the model and the MCP client. |
| The model's judgment | Message text is written by other people. Every read result says so, and the server instructions tell the model never to act on instructions found in messages. |
| The bridge's local API | A Unix socket with `0600` permissions: only your user can talk to it. |

## Known limits

- **Prompt injection can't be fully prevented.** A message can still try to steer the model into
  using *other* tools in the same Claude session (mail, files, the web). The send checks only cover
  WhatsApp.
- **By default nothing stands between a message Claude decides to send and its recipient.** A message
  you receive can try to talk the model into sending something. If Claude reads chats from people you
  don't trust, turn on `confirmBeforeSending` or limit `allowedRecipients`.
- **Unofficial protocol.** Baileys is not WhatsApp's official API. Using it is against WhatsApp's terms
  and can get a number banned, especially with automated or bulk sending. That's a risk of the
  approach, not a vulnerability; the README's "Avoiding a ban" section has the habits that lower it.
