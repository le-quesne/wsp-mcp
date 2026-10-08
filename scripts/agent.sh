#!/bin/sh
# Run the bridge in the background with launchd, so it stays in sync without a terminal open.
# Pair first with `pnpm bridge` in a terminal; the agent can't show a QR code.
set -eu
LABEL=com.whatsapp-mcp.bridge
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${WA_MCP_HOME:-$HOME/.whatsapp-mcp}"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    if [ ! -f "$DATA/auth/creds.json" ]; then
      echo "Not paired yet. Run \`pnpm bridge\` in a terminal first and scan the QR code." >&2
      exit 1
    fi
    # Pinned to the current node binary (nvm): re-run install after switching Node versions.
    NODE="$(command -v node)"
    mkdir -p "$HOME/Library/LaunchAgents"
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
    <string>$DIR/src/bridge.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DATA/bridge.log</string>
  <key>StandardErrorPath</key><string>$DATA/bridge.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # bootout returns before the old instance is gone; bootstrap fails (error 5) until it is.
    i=0
    while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Bridge running in the background. Logs: $DATA/bridge.log"
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
    echo "usage: $0 install|uninstall|status" >&2
    exit 1
    ;;
esac
