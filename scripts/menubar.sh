#!/bin/sh
# Build the menu bar status icon and run it at login with launchd.
set -eu
LABEL=com.whatsapp-mcp.menubar
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$DIR/build/whatsapp-status"
DATA="${WA_MCP_HOME:-$HOME/.whatsapp-mcp}"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  build)
    mkdir -p "$DIR/build"
    swiftc -O -o "$BIN" "$DIR/menubar/WhatsAppStatus.swift"
    echo "Built $BIN"
    ;;
  install)
    "$0" build
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>EnvironmentVariables</key><dict><key>WA_MCP_HOME</key><string>$DATA</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
PLIST
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # bootout returns before the old instance is gone; bootstrap fails (error 5) until it is.
    i=0
    while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Status icon running; it starts at login. Remove with: pnpm menubar:uninstall"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Status icon removed."
    ;;
  *)
    echo "usage: $0 build|install|uninstall" >&2
    exit 1
    ;;
esac
