// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "TeamClaudeIndicator",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "TeamClaudeIndicator", targets: ["TeamClaudeIndicator"]),
    ],
    targets: [
        .executableTarget(
            name: "TeamClaudeIndicator",
            path: "Sources"
        ),
    ]
)
