#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$project_dir"

swift build -c release

app_dir="$project_dir/.build/TeamClaude Indicator.app"
contents_dir="$app_dir/Contents"
macos_dir="$contents_dir/MacOS"

mkdir -p "$macos_dir"
cp "$project_dir/.build/release/TeamClaudeIndicator" "$macos_dir/TeamClaudeIndicator"
cp "$project_dir/Info.plist" "$contents_dir/Info.plist"
chmod 0755 "$macos_dir/TeamClaudeIndicator"

echo "$app_dir"
