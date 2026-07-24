import AppKit
import CoreGraphics

struct ClaudeWindowLocator {
    private let bundleId = "com.anthropic.claudefordesktop"

    func isClaudeFrontmost() -> Bool {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId
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
        guard let cgFrame = candidates.max(by: { $0.width * $0.height < $1.width * $1.height }) else {
            return nil
        }

        // CGWindow coordinates start at the top-left; AppKit windows use a
        // bottom-left origin. This conversion covers the common horizontal
        // multi-display arrangement and the fallback still keeps the pill on
        // the screen that contains Claude's window midpoint.
        let globalTop = NSScreen.screens.map(\.frame.maxY).max() ?? NSScreen.main?.frame.maxY ?? 0
        return NSRect(
            x: cgFrame.minX,
            y: globalTop - cgFrame.maxY,
            width: cgFrame.width,
            height: cgFrame.height
        )
    }
}
