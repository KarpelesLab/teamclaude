import SwiftUI

@MainActor
final class IndicatorViewModel: ObservableObject {
    @Published var state: IndicatorState = .unavailable(task: nil, message: "Finding Claude task…")
    @Published var expanded = false

    var taskTitle: String {
        switch state {
        case .loading(let task), .unassigned(let task), .ready(let task, _):
            return task.title ?? "Claude task"
        case .unavailable(let task, _):
            return task?.title ?? "Claude task"
        }
    }

    var usage: SessionUsage? {
        if case .ready(_, let usage) = state { return usage }
        return nil
    }

    var accountLabel: String {
        switch state {
        case .ready(_, let usage): return usage.accountLabel
        case .loading: return "routing…"
        case .unassigned: return "unassigned"
        case .unavailable: return "offline"
        }
    }

    var message: String? {
        switch state {
        case .unavailable(_, let message): return message
        case .unassigned: return "Send one message to assign this task"
        case .loading: return "Reading TeamClaude session"
        case .ready: return nil
        }
    }
}

struct IndicatorView: View {
    @ObservedObject var model: IndicatorViewModel

    var body: some View {
        VStack(spacing: 0) {
            collapsed
            if model.expanded {
                Divider()
                    .overlay(Color.white.opacity(0.10))
                    .padding(.horizontal, 14)
                expanded
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(width: 356)
        .background(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .fill(Color(nsColor: .windowBackgroundColor).opacity(0.96))
                .overlay(
                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                        .stroke(Color.white.opacity(0.14), lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.28), radius: 14, y: 5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
        .animation(.easeOut(duration: 0.16), value: model.expanded)
    }

    private var collapsed: some View {
        Button {
            model.expanded.toggle()
        } label: {
            HStack(spacing: 10) {
                Circle()
                    .fill(accountColor)
                    .frame(width: 9, height: 9)
                    .shadow(color: accountColor.opacity(0.7), radius: 4)

                Text(model.accountLabel)
                    .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer(minLength: 6)

                if let usage = model.usage {
                    metric("5h", usage.limits.fiveHour.utilization)
                    metric("7d", usage.limits.weekly.utilization)
                    metric("Fable", usage.limits.fable.utilization, warn: true)
                } else {
                    Text(model.message ?? "No usage")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Image(systemName: model.expanded ? "chevron.down" : "chevron.up")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .frame(height: 42)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(model.taskTitle)
    }

    private var expanded: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("TEAMCLAUDE ACCOUNT")
                        .font(.system(size: 9, weight: .bold))
                        .tracking(1.1)
                        .foregroundStyle(.tertiary)
                    Text(model.taskTitle)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                if let usage = model.usage {
                    Text(usage.active ? "ACTIVE" : "PINNED")
                        .font(.system(size: 9, weight: .bold))
                        .tracking(0.7)
                        .foregroundStyle(usage.active ? Color.green : Color.secondary)
                }
            }

            if let usage = model.usage {
                limitRow("5-hour limit", usage.limits.fiveHour, color: .blue)
                limitRow("Weekly · all models", usage.limits.weekly, color: .blue)
                limitRow("Weekly · Fable", usage.limits.fable, color: fableColor(usage.limits.fable.utilization))
            } else {
                Text(model.message ?? "No TeamClaude data for this task yet.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 14)
    }

    private func metric(_ name: String, _ value: Double?, warn: Bool = false) -> some View {
        HStack(spacing: 3) {
            Text(name)
                .foregroundStyle(.secondary)
            Text(percent(value))
                .foregroundStyle(warn && (value ?? 0) >= 0.9 ? Color.red : Color.primary)
        }
        .font(.system(size: 11, weight: .medium, design: .monospaced))
    }

    private func limitRow(_ title: String, _ limit: UsageLimit, color: Color) -> some View {
        VStack(spacing: 5) {
            HStack {
                Text(title)
                Spacer()
                Text(resetText(limit.resetsAt))
                    .foregroundStyle(.tertiary)
                Text(percent(limit.utilization))
                    .fontWeight(.semibold)
            }
            .font(.system(size: 11))

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.09))
                    Capsule()
                        .fill(color)
                        .frame(width: geometry.size.width * min(max(limit.utilization ?? 0, 0), 1))
                }
            }
            .frame(height: 5)
        }
    }

    private var accountColor: Color {
        guard let usage = model.usage else { return .gray }
        let hash = usage.account.name.unicodeScalars.reduce(0) { ($0 &* 31) &+ Int($1.value) }
        let hue = Double(abs(hash % 360)) / 360.0
        return Color(hue: hue, saturation: 0.68, brightness: 0.95)
    }

    private func fableColor(_ value: Double?) -> Color {
        (value ?? 0) >= 0.9 ? .red : .blue
    }

    private func percent(_ value: Double?) -> String {
        guard let value else { return "—" }
        return "\(Int((value * 100).rounded()))%"
    }

    private func resetText(_ iso: String?) -> String {
        guard let iso,
              let date = ISO8601DateFormatter().date(from: iso) else { return "" }
        let seconds = date.timeIntervalSinceNow
        if seconds <= 0 { return "resetting" }
        if seconds < 3600 { return "in \(max(1, Int(seconds / 60)))m" }
        if seconds < 86400 {
            let hours = Int(seconds / 3600)
            let minutes = Int(seconds.truncatingRemainder(dividingBy: 3600) / 60)
            return "in \(hours)h \(minutes)m"
        }
        return date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }
}
