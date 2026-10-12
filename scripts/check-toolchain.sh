#!/usr/bin/env bash
# Environment check only; no application project is built.
set -euo pipefail

require_macos=false
case "${1:-}" in
  '') ;;
  --require-macos) require_macos=true ;;
  *) printf 'Usage: bash %s [--require-macos]\n' "$0" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  printf 'Expected at most one argument.\n' >&2
  exit 2
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'ERROR: required tool missing: %s\n' "$1" >&2
    exit 1
  }
}

need git
need uname
printf 'OS: %s (%s)\n' "$(uname -s)" "$(uname -m)"
printf 'Bash: %s\n' "$BASH_VERSION"
git --version

if [ "$(uname -s)" != Darwin ]; then
  if [ "$require_macos" = true ]; then
    printf 'ERROR: macOS required; Linux cannot validate the macOS SDK/AppKit toolchain.\n' >&2
    exit 1
  fi
  printf 'PASS: base tools available. SKIP: macOS compilation requires a macOS runner or Mac.\n'
  exit 0
fi

need xcode-select
need xcodebuild
need xcrun
need mktemp
printf 'Runner image: %s (%s)\n' "${ImageOS:-local}" "${ImageVersion:-unreported}"
printf 'DEVELOPER_DIR: %s\n' "${DEVELOPER_DIR:-not overridden}"
xcode-select --print-path
xcodebuild -version
xcrun --sdk macosx swiftc --version
xcrun --sdk macosx --show-sdk-version
sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
printf 'SDK path: %s\n' "$sdk_path"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/agent-nexus-toolchain.XXXXXX")"
trap 'rm -rf -- "$tmp_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$tmp_dir/main.swift" <<'SWIFT'
import Foundation
import AppKit

let point = NSPoint(x: 1, y: 2)
precondition(point.x + point.y == 3)
precondition(NSStringFromClass(NSApplication.self) == "NSApplication")
print("PASS: temporary Swift/Foundation/AppKit program compiled, linked and ran.")
SWIFT
xcrun --sdk macosx swiftc -sdk "$sdk_path" \
  -module-cache-path "$tmp_dir/module-cache" \
  "$tmp_dir/main.swift" -o "$tmp_dir/toolchain-smoke"
"$tmp_dir/toolchain-smoke"
printf 'Toolchain smoke check only: no application build, UI test, signing or release was performed.\n'
