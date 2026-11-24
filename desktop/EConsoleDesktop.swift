import AppKit
import WebKit

// A separate macOS application. Audio remains in LUNA's native plugin instances.
final class ConsoleAppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow?
    var webView: WKWebView?
    var resourceServer: ConsoleResourceServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenu()
        showConsole()
    }

    func showConsole() {
        if let window = window { window.makeKeyAndOrderFront(nil); return }
        let configuration = WKWebViewConfiguration()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.allowsBackForwardNavigationGestures = false
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1500, height: 960)
        let frame = NSRect(x: 0, y: 0, width: min(1560, screen.width - 40), height: min(1040, screen.height - 60))
        let host = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        host.title = "E Console · 4000 E Mixing Console"
        host.minSize = NSSize(width: 900, height: 620)
        host.isReleasedWhenClosed = false
        host.backgroundColor = NSColor(calibratedWhite: 0.13, alpha: 1)
        host.contentView = view
        host.center()
        self.window = host
        self.webView = view
        if let resources = Bundle.main.resourceURL {
            let content = resources.appendingPathComponent("console")
            let server = ConsoleResourceServer(root: content)
            self.resourceServer = server
            do {
                try server.start(ready: { [weak view] url in view?.load(URLRequest(url: url)) }, failure: { error in
                    let alert = NSAlert(); alert.messageText = "The console could not open its local window."; alert.informativeText = error.localizedDescription; alert.runModal()
                })
            } catch {
                let alert = NSAlert(); alert.messageText = "The console could not open its local window."; alert.informativeText = error.localizedDescription; alert.runModal()
            }
        }
        host.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func makeMenu() {
        let menu = NSMenu()
        let application = NSMenuItem()
        let applicationMenu = NSMenu(title: "E Console")
        applicationMenu.addItem(withTitle: "About E Console", action: #selector(showAbout), keyEquivalent: "")
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "Quit E Console", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        application.submenu = applicationMenu
        menu.addItem(application)
        let edit = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.submenu = editMenu
        menu.addItem(edit)
        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload Console", action: #selector(reloadConsole), keyEquivalent: "r")
        viewItem.submenu = viewMenu
        menu.addItem(viewItem)
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windowMenu
    }

    @objc func reloadConsole() { webView?.reload() }
    @objc func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "E Console",
            .applicationVersion: "0.2.1",
            .credits: NSAttributedString(string: "Independent console control surface. Requires LUNA and licensed Universal Audio SSL plugins. Audio is processed in LUNA.")
        ])
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showConsole(); return true }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        // Console resources are local; no third-party web content runs in this app.
        decisionHandler((url.scheme == "http" && url.host == "127.0.0.1") || url.scheme == "about" ? .allow : .cancel)
    }
}

@main
struct EConsoleApplication {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = ConsoleAppDelegate()
        application.setActivationPolicy(.regular)
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
