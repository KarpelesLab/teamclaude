import Foundation

struct ClaudeSSHConfig: Decodable {
    let sshHost: String?
    let name: String?
}

struct ClaudeTask: Decodable {
    let sessionId: String
    let cliSessionId: String?
    let title: String?
    let lastFocusedAt: Double?
    let sshConfig: ClaudeSSHConfig?
}

struct UsageLimit: Decodable, Equatable {
    let utilization: Double?
    let resetsAt: String?
}

struct SessionAccount: Decodable, Equatable {
    let name: String
    let status: String
}

struct SessionLimits: Decodable, Equatable {
    let fiveHour: UsageLimit
    let weekly: UsageLimit
    let sonnet: UsageLimit
    let fable: UsageLimit
}

struct SessionUsage: Decodable, Equatable {
    let sessionId: String
    let active: Bool
    let account: SessionAccount
    let limits: SessionLimits

    var accountLabel: String {
        let prefix = account.name.split(separator: "@", maxSplits: 1).first.map(String.init)
        return prefix?.isEmpty == false ? prefix! : account.name
    }
}

enum IndicatorState {
    case loading(task: ClaudeTask)
    case ready(task: ClaudeTask, usage: SessionUsage)
    case unassigned(task: ClaudeTask)
    case unavailable(task: ClaudeTask?, message: String)
}
