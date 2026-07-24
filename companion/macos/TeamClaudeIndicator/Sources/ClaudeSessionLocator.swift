import Foundation

final class ClaudeSessionLocator {
    private struct Cached {
        let modifiedAt: Date
        let task: ClaudeTask
    }

    private let fileManager = FileManager.default
    private let decoder = JSONDecoder()
    private let root: URL
    private var cached: [URL: Cached] = [:]

    init() {
        root = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Claude/claude-code-sessions", isDirectory: true)
    }

    func focusedTask() -> ClaudeTask? {
        refreshCache()
        return cached.values
            .map(\.task)
            .filter { $0.lastFocusedAt != nil }
            .max { ($0.lastFocusedAt ?? 0) < ($1.lastFocusedAt ?? 0) }
    }

    private func refreshCache() {
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .contentModificationDateKey]
        guard let enumerator = fileManager.enumerator(
            at: root,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return }

        var seen = Set<URL>()
        for case let url as URL in enumerator {
            guard url.lastPathComponent.hasPrefix("local_"), url.pathExtension == "json" else { continue }
            seen.insert(url)
            guard let values = try? url.resourceValues(forKeys: keys),
                  values.isRegularFile == true,
                  let modified = values.contentModificationDate else { continue }
            if cached[url]?.modifiedAt == modified { continue }
            guard let data = try? Data(contentsOf: url),
                  let task = try? decoder.decode(ClaudeTask.self, from: data) else { continue }
            cached[url] = Cached(modifiedAt: modified, task: task)
        }

        for url in cached.keys where !seen.contains(url) {
            cached.removeValue(forKey: url)
        }
    }
}
