import Foundation
import Network

// Serve only this app's seven bundled UI files, bound to IPv4 loopback.
// A localhost origin gives WKWebView the same connection path as browser testing.
final class ConsoleResourceServer {
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.econsole.local-resources")
    private let root: URL
    private let files: Set<String> = ["console.html", "console.css", "console.js", "logic.js", "companion.js", "demo.js", "vendor/luna.global.js"]

    init(root: URL) { self.root = root }
    func start(ready: @escaping (URL) -> Void, failure: @escaping (Error) -> Void) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let server = try NWListener(using: parameters)
        listener = server
        server.stateUpdateHandler = { state in
            switch state {
            case .ready:
                if let port = server.port, let url = URL(string: "http://127.0.0.1:\(port.rawValue)/console.html") { DispatchQueue.main.async { ready(url) } }
            case .failed(let error): DispatchQueue.main.async { failure(error) }
            default: break
            }
        }
        server.newConnectionHandler = { [weak self] connection in
            guard let self = self else { connection.cancel(); return }
            connection.start(queue: self.queue)
            self.receive(connection, buffer: Data())
        }
        server.start(queue: queue)
    }
    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, done, error in
            guard let self = self else { connection.cancel(); return }
            var bytes = buffer; if let data = data { bytes.append(data) }
            if bytes.count > 16384 || error != nil { connection.cancel(); return }
            if let text = String(data: bytes, encoding: .utf8), text.contains("\r\n\r\n") { self.respond(connection, request: text); return }
            if done { connection.cancel() } else { self.receive(connection, buffer: bytes) }
        }
    }
    private func respond(_ connection: NWConnection, request: String) {
        let line = request.components(separatedBy: "\r\n")[0].split(separator: " ")
        guard line.count >= 2, line[0] == "GET" else { send(connection, status: "405 Method Not Allowed", type: "text/plain", body: Data()); return }
        let path = String(line[1]).components(separatedBy: "?")[0].removingPercentEncoding ?? ""
        let name = path == "/" ? "console.html" : String(path.dropFirst())
        guard path.hasPrefix("/"), files.contains(name), let body = try? Data(contentsOf: root.appendingPathComponent(name)) else { send(connection, status: "404 Not Found", type: "text/plain", body: Data()); return }
        let ext = root.appendingPathComponent(name).pathExtension
        let mime = ext == "html" ? "text/html; charset=utf-8" : ext == "css" ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8"
        send(connection, status: "200 OK", type: mime, body: body)
    }
    private func send(_ connection: NWConnection, status: String, type: String, body: Data) {
        let header = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        var response = Data(header.utf8); response.append(body)
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }
    deinit { listener?.cancel() }
}
