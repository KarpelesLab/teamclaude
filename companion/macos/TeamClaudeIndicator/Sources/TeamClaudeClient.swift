import Foundation

final class TeamClaudeClient {
    enum LookupError: LocalizedError {
        case invalidSession
        case notFound
        case ssh(String)
        case invalidResponse

        var errorDescription: String? {
            switch self {
            case .invalidSession: return "Invalid Claude session"
            case .notFound: return "Waiting for the first routed request"
            case .ssh(let message): return message
            case .invalidResponse: return "TeamClaude returned invalid data"
            }
        }
    }

    private let host: String
    private let decoder = JSONDecoder()
    private let uuidPattern = try! NSRegularExpression(
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        options: [.caseInsensitive]
    )

    init(host: String = "dev") {
        self.host = host
    }

    func lookup(sessionId: String, completion: @escaping (Result<SessionUsage, Error>) -> Void) {
        let range = NSRange(sessionId.startIndex..., in: sessionId)
        guard uuidPattern.firstMatch(in: sessionId, range: range) != nil else {
            completion(.failure(LookupError.invalidSession))
            return
        }

        DispatchQueue.global(qos: .utility).async { [host, decoder] in
            let process = Process()
            let stdout = Pipe()
            let stderr = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
            process.arguments = [
                "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=5",
                "-o", "PermitLocalCommand=no",
                "-o", "ControlMaster=auto",
                "-o", "ControlPersist=60",
                "-o", "ControlPath=/tmp/teamclaude-indicator-%r@%h:%p",
                host,
                "/home/ubuntu-server/.local/bin/teamclaude", "session", sessionId, "--json",
            ]
            process.standardOutput = stdout
            process.standardError = stderr

            do {
                try process.run()
                process.waitUntilExit()
                let output = stdout.fileHandleForReading.readDataToEndOfFile()
                let errorData = stderr.fileHandleForReading.readDataToEndOfFile()
                if process.terminationStatus != 0 {
                    let message = String(data: errorData, encoding: .utf8)?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let error: Error = message.localizedCaseInsensitiveContains("not found")
                        ? LookupError.notFound
                        : LookupError.ssh(message.isEmpty ? "Cannot reach TeamClaude on \(host)" : message)
                    DispatchQueue.main.async { completion(.failure(error)) }
                    return
                }
                guard let usage = try? decoder.decode(SessionUsage.self, from: output) else {
                    DispatchQueue.main.async { completion(.failure(LookupError.invalidResponse)) }
                    return
                }
                DispatchQueue.main.async { completion(.success(usage)) }
            } catch {
                DispatchQueue.main.async {
                    completion(.failure(LookupError.ssh("Cannot start ssh: \(error.localizedDescription)")))
                }
            }
        }
    }
}
