import AppKit
import ApplicationServices
import CoreGraphics

final class ClaudeWindowLocator {
    private let bundleId = "com.anthropic.claudefordesktop"
    private var cachedPID: pid_t?
    private var cachedUsageControl: AXUIElement?
    private var lastUsageSearchAt = Date.distantPast

    func requestAccessibilityPermissionIfNeeded() {
        guard !AXIsProcessTrusted() else { return }
        let options = [
            kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
        ] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    func isClaudeFrontmost() -> Bool {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId
    }

    /// Finds Claude's native "Usage: context …, plan …" control and returns
    /// its on-screen frame. Accessibility coordinates are converted to AppKit
    /// coordinates so the companion can visually dock to the actual control
    /// even when Claude is on a secondary display.
    func usageControlFrame() -> NSRect? {
        guard AXIsProcessTrusted(),
              let application = NSRunningApplication
                .runningApplications(withBundleIdentifier: bundleId)
                .first else { return nil }

        if cachedPID != application.processIdentifier {
            cachedPID = application.processIdentifier
            cachedUsageControl = nil
            lastUsageSearchAt = .distantPast
        }

        if let cachedUsageControl, let frame = frame(of: cachedUsageControl) {
            return appKitFrame(fromQuartzFrame: frame)
        }

        guard Date().timeIntervalSince(lastUsageSearchAt) >= 5 else { return nil }
        lastUsageSearchAt = Date()
        let root = AXUIElementCreateApplication(application.processIdentifier)
        cachedUsageControl = findUsageControl(from: root)
        guard let cachedUsageControl,
              let frame = frame(of: cachedUsageControl) else { return nil }
        return appKitFrame(fromQuartzFrame: frame)
    }

    func windowFrame() -> NSRect? {
        guard let info = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else { return nil }

        let candidates = info.compactMap { item -> CGRect? in
            guard (item[kCGWindowOwnerName as String] as? String) == "Claude",
                  (item[kCGWindowLayer as String] as? Int) == 0,
                  let bounds = item[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = bounds["X"], let y = bounds["Y"],
                  let width = bounds["Width"], let height = bounds["Height"],
                  width > 500, height > 350 else { return nil }
            return CGRect(x: x, y: y, width: width, height: height)
        }
        guard let frame = candidates.max(by: { $0.width * $0.height < $1.width * $1.height }) else {
            return nil
        }
        return appKitFrame(fromQuartzFrame: frame)
    }

    private func findUsageControl(from root: AXUIElement) -> AXUIElement? {
        var queue = [root]
        var index = 0
        let maximumElements = 2_500

        while index < queue.count, index < maximumElements {
            let element = queue[index]
            index += 1

            let searchable = [
                stringAttribute(kAXTitleAttribute, of: element),
                stringAttribute(kAXDescriptionAttribute, of: element),
                stringAttribute(kAXHelpAttribute, of: element),
                stringAttribute(kAXValueAttribute, of: element),
            ]
                .compactMap { $0 }
                .joined(separator: " ")

            if searchable.localizedCaseInsensitiveContains("Usage: context"),
               frame(of: element) != nil {
                return element
            }

            queue.append(contentsOf: children(of: element))
        }
        return nil
    }

    private func children(of element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
              let children = value as? [AXUIElement] else { return [] }
        return children
    }

    private func stringAttribute(_ attribute: String, of element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        if let string = value as? String { return string }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    private func frame(of element: AXUIElement) -> CGRect? {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXPositionAttribute as CFString,
            &positionValue
        ) == .success,
        AXUIElementCopyAttributeValue(
            element,
            kAXSizeAttribute as CFString,
            &sizeValue
        ) == .success,
        let positionValue,
        let sizeValue,
        CFGetTypeID(positionValue) == AXValueGetTypeID(),
        CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }

        var position = CGPoint.zero
        var size = CGSize.zero
        let positionAX = positionValue as! AXValue
        let sizeAX = sizeValue as! AXValue
        guard AXValueGetValue(positionAX, .cgPoint, &position),
              AXValueGetValue(sizeAX, .cgSize, &size),
              size.width > 0, size.height > 0 else { return nil }
        return CGRect(origin: position, size: size)
    }

    private func appKitFrame(fromQuartzFrame frame: CGRect) -> NSRect {
        // Quartz/Accessibility use a top-left origin based on the main display;
        // AppKit uses a bottom-left origin. Using the *main* display's top edge
        // (not the virtual desktop's highest edge) is what preserves placement
        // across arbitrary multi-monitor arrangements.
        let mainDisplayTop = NSScreen.main?.frame.maxY ?? 0
        return NSRect(
            x: frame.minX,
            y: mainDisplayTop - frame.maxY,
            width: frame.width,
            height: frame.height
        )
    }
}
