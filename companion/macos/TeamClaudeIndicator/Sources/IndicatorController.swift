import AppKit
import Combine
import SwiftUI

@MainActor
final class IndicatorController {
    private let model = IndicatorViewModel()
    private let panel: NSPanel
    private let locator = ClaudeSessionLocator()
    private let client = TeamClaudeClient(host: "dev")
    private let windowLocator = ClaudeWindowLocator()
    private var timer: Timer?
    private var currentLocalSessionId: String?
    private var lastLookupAt = Date.distantPast
    private var lookupInFlight = false

    init() {
        let content = IndicatorView(model: model)
        let hosting = NSHostingView(rootView: content)
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 356, height: 42),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.contentView = hosting
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false

        model.$expanded
            .dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.resizeAndPosition() }
            .store(in: &cancellables)
    }

    private var cancellables = Set<AnyCancellable>()

    func start() {
        windowLocator.requestAccessibilityPermissionIfNeeded()
        tick(forceLookup: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.85, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    func refresh() {
        tick(forceLookup: true)
    }

    private func tick(forceLookup: Bool = false) {
        guard windowLocator.isClaudeFrontmost(),
              let frame = windowLocator.windowFrame() else {
            panel.orderOut(nil)
            return
        }
        guard let task = locator.focusedTask(),
              task.sshConfig?.sshHost == "dev" || task.sshConfig?.name == "dev" else {
            panel.orderOut(nil)
            return
        }

        position(claudeFrame: frame)
        panel.orderFrontRegardless()

        let changed = task.sessionId != currentLocalSessionId
        if changed {
            currentLocalSessionId = task.sessionId
            model.expanded = false
            model.state = .loading(task: task)
        }

        let refreshDue = Date().timeIntervalSince(lastLookupAt) >= 30
        guard (changed || refreshDue || forceLookup), !lookupInFlight else { return }
        guard let cliSessionId = task.cliSessionId, !cliSessionId.isEmpty else {
            model.state = .unassigned(task: task)
            return
        }

        lookupInFlight = true
        lastLookupAt = Date()
        client.lookup(sessionId: cliSessionId) { [weak self] result in
            guard let self else { return }
            self.lookupInFlight = false
            guard self.currentLocalSessionId == task.sessionId else { return }
            switch result {
            case .success(let usage):
                self.model.state = .ready(task: task, usage: usage)
            case .failure(let error as TeamClaudeClient.LookupError):
                if case .notFound = error {
                    self.model.state = .unassigned(task: task)
                } else {
                    self.model.state = .unavailable(task: task, message: error.localizedDescription)
                }
            case .failure(let error):
                self.model.state = .unavailable(task: task, message: error.localizedDescription)
            }
            self.resizeAndPosition()
        }
    }

    private func resizeAndPosition() {
        guard let frame = windowLocator.windowFrame() else { return }
        position(claudeFrame: frame)
    }

    private func position(claudeFrame: NSRect) {
        let size = NSSize(width: 356, height: model.expanded ? 220 : 42)
        let origin: NSPoint
        if let usageFrame = windowLocator.usageControlFrame() {
            // Visually dock to Claude's real usage control. The expanded card
            // grows upward from the same anchor instead of drifting around the
            // virtual desktop.
            origin = NSPoint(
                x: usageFrame.maxX - size.width,
                y: usageFrame.maxY + 8
            )
        } else {
            // Permission-free fallback, now using correctly converted Claude
            // window coordinates on multi-monitor setups.
            origin = NSPoint(
                x: claudeFrame.maxX - size.width - 22,
                y: claudeFrame.minY + 78
            )
        }
        let nextFrame = NSRect(origin: origin, size: size)
        guard !NSEqualRects(panel.frame, nextFrame) else { return }
        let isResize = panel.frame.size != nextFrame.size
        panel.setFrame(nextFrame, display: true, animate: panel.isVisible && isResize)
    }
}
