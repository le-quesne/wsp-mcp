// Menu bar indicator for the WhatsApp bridge.
// Polls the bridge's /status over its Unix socket and reads counts from the SQLite mirror.
//   green dot        connected (with ↓ count while history is importing)
//   orange dot       connecting / reconnecting
//   red dot          bridge not running
import AppKit
import SQLite3

let home = ProcessInfo.processInfo.environment["WA_MCP_HOME"] ?? (NSHomeDirectory() + "/.whatsapp-mcp")
let socketPath = home + "/bridge.sock"
let dbPath = home + "/messages.db"
let logPath = home + "/bridge.log"

// Minimal HTTP/1.0 GET over the bridge's Unix socket.
func fetchBridgeStatus() -> [String: Any]? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8)
    guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
    withUnsafeMutableBytes(of: &addr.sun_path) { buf in
        buf.copyBytes(from: pathBytes)
        buf[pathBytes.count] = 0
    }
    let connected = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connected == 0 else { return nil }

    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

    let request = Array("GET /status HTTP/1.0\r\nHost: bridge\r\n\r\n".utf8)
    guard write(fd, request, request.count) == request.count else { return nil }

    var data = Data()
    var buf = [UInt8](repeating: 0, count: 4096)
    while true {
        let n = read(fd, &buf, buf.count)
        if n <= 0 { break }
        data.append(buf, count: n)
    }
    guard let text = String(data: data, encoding: .utf8),
          let split = text.range(of: "\r\n\r\n") else { return nil }
    let body = Data(text[split.upperBound...].utf8)
    return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
}

struct DbInfo {
    var messages = 0
    var lastMessage: Date?
    var me: String?
}

func readDb() -> DbInfo? {
    var db: OpaquePointer?
    guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
        sqlite3_close(db)
        return nil
    }
    defer { sqlite3_close(db) }
    sqlite3_busy_timeout(db, 1000)

    func each(_ sql: String, _ row: (OpaquePointer) -> Void) {
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt {
            while sqlite3_step(stmt) == SQLITE_ROW { row(stmt) }
        }
        sqlite3_finalize(stmt)
    }

    var info = DbInfo()
    each("SELECT COUNT(*), MAX(ts) FROM messages") { st in
        info.messages = Int(sqlite3_column_int64(st, 0))
        if sqlite3_column_type(st, 1) != SQLITE_NULL {
            info.lastMessage = Date(timeIntervalSince1970: Double(sqlite3_column_int64(st, 1)))
        }
    }
    each("SELECT value FROM meta WHERE key = 'me'") { st in
        if let c = sqlite3_column_text(st, 0) { info.me = String(cString: c) }
    }
    return info
}

func short(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
    if n >= 10_000 { return "\(n / 1000)k" }
    return n.formatted()
}

@MainActor
final class Controller: NSObject, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var connection = "down"
    var history: Int?
    var lastHistoryChange = Date.distantPast
    var db: DbInfo?
    var ticks = 0

    var importing: Bool { connection == "open" && Date().timeIntervalSince(lastHistoryChange) < 45 }

    override init() {
        super.init()
        let image = NSImage(systemSymbolName: "message.fill", accessibilityDescription: "WhatsApp bridge")
        image?.isTemplate = true
        item.button?.image = image
        item.button?.imagePosition = .imageLeft
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        refresh()
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
            MainActor.assumeIsolated { self.refresh() }
        }
    }

    func refresh() {
        let status = fetchBridgeStatus()
        connection = status?["connection"] as? String ?? "down"
        let h = status?["history_this_session"] as? Int ?? 0
        // Only a change between polls counts as importing (not the first value we see).
        if let prev = history, h != prev { lastHistoryChange = Date() }
        history = status == nil ? nil : h
        if db == nil || importing || ticks % 4 == 0 { db = readDb() }
        ticks += 1
        render()
    }

    func render() {
        let color: NSColor = switch connection {
        case "open": .systemGreen
        case "down": .systemRed
        default: .systemOrange
        }
        let title = NSMutableAttributedString(string: " ●", attributes: [.foregroundColor: color])
        if importing, let db {
            title.append(NSAttributedString(string: " ↓\(short(db.messages))"))
        }
        item.button?.attributedTitle = title
        item.button?.toolTip = headline
    }

    var headline: String {
        switch connection {
        case "open": "WhatsApp connected" + (db?.me.map { " as \($0)" } ?? "")
        case "down": "WhatsApp bridge not running"
        default: "Connecting to WhatsApp…"
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        func info(_ text: String) {
            let i = NSMenuItem(title: text, action: nil, keyEquivalent: "")
            i.isEnabled = false
            menu.addItem(i)
        }
        info(headline)
        if importing, let history {
            info("Importing history… \(history.formatted()) messages this session")
        }
        if let db {
            var line = "\(db.messages.formatted()) messages stored"
            if let last = db.lastMessage {
                line += " · last \(last.formatted(date: .abbreviated, time: .shortened))"
            }
            info(line)
        }
        if connection == "down" {
            info("Start it with `pnpm bridge` or `pnpm agent:install`")
        }
        menu.addItem(.separator())
        addAction(menu, "Open data folder", #selector(openData))
        if FileManager.default.fileExists(atPath: logPath) {
            addAction(menu, "Open bridge log", #selector(openLog))
        }
        menu.addItem(.separator())
        addAction(menu, "Quit status icon", #selector(quit))
    }

    func addAction(_ menu: NSMenu, _ title: String, _ action: Selector) {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
        i.target = self
        menu.addItem(i)
    }

    @objc func openData() { NSWorkspace.shared.open(URL(fileURLWithPath: home)) }
    @objc func openLog() { NSWorkspace.shared.open(URL(fileURLWithPath: logPath)) }
    @objc func quit() { NSApp.terminate(nil) }
}

// `whatsapp-status --check` prints what the icon would show, for troubleshooting.
if CommandLine.arguments.contains("--check") {
    let status = fetchBridgeStatus()
    let db = readDb()
    print("bridge:", status.map { "\($0)" } ?? "not running")
    print("db:", db.map { "\($0.messages) messages, last \($0.lastMessage.map { "\($0)" } ?? "-"), me \($0.me ?? "-")" } ?? "unreadable")
    exit(0)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let controller = Controller()
    withExtendedLifetime(controller) { app.run() }
}
