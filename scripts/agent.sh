#!/bin/sh
# Run the bridge in the background with launchd, so it stays in sync without a terminal open.
#
#   install           once a phone is linked (pnpm run setup, or pnpm bridge in a terminal)
#   pair <number>     start it before linking, asking WhatsApp for a pairing code; the code shows
#                     up in the log, and once the phone accepts it the same bridge keeps running
#   forget-phone      rewrite the plist without the number, WITHOUT restarting: a fresh link is in
#                     the middle of its first history import, and a restart would cut it short
#   uninstall | status
set -eu
LABEL=com.whatsapp-mcp.bridge
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${WA_MCP_HOME:-$HOME/.whatsapp-mcp}"
DOMAIN="gui/$(id -u)"

# $1: extra ProgramArguments entries for the bridge (XML, may be empty).
write_plist() {
  # Pinned to the current node binary (nvm): re-run install after switching Node versions.
  NODE="$(command -v node)"
  mkdir -p "$HOME/Library/LaunchAgents" "$DATA"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>$DIR/src/bridge.ts</string>$1
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>WA_MCP_HOME</key><string>$DATA</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DATA/bridge.log</string>
  <key>StandardErrorPath</key><string>$DATA/bridge.log</string>
</dict>
</plist>
PLIST
}

load() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  # bootout returns before the old instance is gone; bootstrap fails (error 5) until it is.
  i=0
  while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
  launchctl bootstrap "$DOMAIN" "$PLIST"
}

case "${1:-}" in
  install)
    # creds.json exists from the first QR code on, and asking for a pairing code fills in "me";
    # "account" is only written once a phone really linked it.
    if ! grep -q '"account":' "$DATA/auth/creds.json" 2>/dev/null; then
      echo "Not linked yet. Run \`pnpm run setup\`, or \`pnpm bridge\` in a terminal and scan the QR code." >&2
      exit 1
    fi
    write_plist ""
    load
    echo "Bridge running in the background. Logs: $DATA/bridge.log"
    ;;
  pair)
    PHONE="$(printf %s "${2:-}" | tr -cd 0-9)"
    if [ -z "$PHONE" ]; then
      echo "usage: $0 pair <phone number with country code>" >&2
      exit 1
    fi
    write_plist "
    <string>--phone</string>
    <string>$PHONE</string>"
    load
    echo "Bridge started, asking for a pairing code. It appears in $DATA/bridge.log"
    ;;
  forget-phone)
    if [ -f "$PLIST" ]; then
      write_plist ""
      echo "The background bridge will start without the number from now on (it keeps running)."
    fi
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Background bridge removed."
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|last exit code) =' || echo "Not installed."
    ;;
  *)
    echo "usage: $0 install|pair <number>|forget-phone|uninstall|status" >&2
    exit 1
    ;;
esac
