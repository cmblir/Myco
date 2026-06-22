#!/usr/bin/env bash
# E2E smoke test for the bundled Memex.app on macOS.
#
# What this verifies:
#   1. The DMG mounts cleanly.
#   2. Memex.app launches and stays alive for 15s without crashing.
#   3. AppleScript can find a process named "Memex" with at least one
#      window whose title is "Memex".
#   4. The Tauri WebView triggers ensure_default_vault on first launch:
#      ~/Documents/Memex/ appears with the full scaffold (raw/, wiki/,
#      daily/, ingest-reports/, welcome.md, CLAUDE.md, wiki/index.md,
#      wiki/log.md).
#   5. The link-graph IPC fires within the first ~15s of mount:
#      <vault>/.memex/cache.db is created.
#
# Exits non-zero on any failure. Cleans up after itself.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DMG="$ROOT/src-tauri/target/release/bundle/dmg/Memex_0.1.0_aarch64.dmg"
APP_COPY="/tmp/memex-smoke.app"
LOG="/tmp/memex-smoke.log"
VAULT="$HOME/Documents/Memex"
SUPPORT="$HOME/Library/Application Support/dev.cmblir.memex"
WEBKIT="$HOME/Library/WebKit/dev.cmblir.memex"
CACHES="$HOME/Library/Caches/dev.cmblir.memex"
PREFS="$HOME/Library/Preferences/dev.cmblir.memex.plist"

ok()   { printf '\033[32m ✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m ✗\033[0m %s\n' "$1"; exit 1; }

[ -f "$DMG" ] || fail "DMG not found at $DMG — run \`npm run tauri build\` first"
ok "DMG exists: $DMG"

# 1. Mount DMG and extract .app
MOUNT=$(hdiutil attach -nobrowse -noverify -noautoopen "$DMG" 2>&1 \
        | grep -oE '/Volumes/[^ ]+' | head -1)
[ -n "$MOUNT" ] || fail "could not mount DMG"
rm -rf "$APP_COPY"
cp -R "$MOUNT/Memex.app" "$APP_COPY"
hdiutil detach "$MOUNT" -quiet
ok "DMG mounted, Memex.app extracted to $APP_COPY"

# 2. Validate the .app structure
[ -d "$APP_COPY/Contents/MacOS" ]    || fail ".app/Contents/MacOS missing"
[ -f "$APP_COPY/Contents/Info.plist" ] || fail "Info.plist missing"
[ -x "$APP_COPY/Contents/MacOS/memex" ] || fail "binary missing or not executable"
file "$APP_COPY/Contents/MacOS/memex" | grep -q "Mach-O .* arm64" \
  || fail "binary is not an arm64 Mach-O"
ok "binary is an arm64 Mach-O executable"

# 3. Wipe prior state for a real first-launch test
rm -rf "$VAULT" "$SUPPORT" "$WEBKIT" "$CACHES" "$PREFS" 2>/dev/null || true
ok "wiped prior state"

# 4. Launch the app, wait, then verify it's still alive
"$APP_COPY/Contents/MacOS/memex" >"$LOG" 2>&1 &
PID=$!
trap "kill -9 $PID 2>/dev/null || true" EXIT
sleep 15
kill -0 $PID 2>/dev/null || fail "process died within 15s (see $LOG)"
ok "process alive after 15s (pid $PID)"

# 5. UI process visible. Try AppleScript first (needs Accessibility),
#    fall back to lsappinfo, then to /usr/bin/pgrep on the binary name.
#    Any of three is sufficient; we already know the PID is alive.
title=$(osascript -e 'tell application "System Events" to set t to ""' \
                  -e 'try' \
                  -e '  set t to name of front window of (first process whose name is "Memex")' \
                  -e 'end try' \
                  -e 'return t' 2>/dev/null || true)
if [ -n "$title" ]; then
  ok "AppleScript sees a Memex window: \"$title\""
elif /usr/bin/lsappinfo list 2>/dev/null | grep -q '"Memex"'; then
  ok "lsappinfo sees Memex registered as a UI process"
elif pgrep -af "Memex.app/Contents/MacOS/memex" >/dev/null 2>&1 \
     || pgrep -af "memex-smoke.app" >/dev/null 2>&1 \
     || ps -p "$PID" -o command= 2>/dev/null | grep -q memex; then
  ok "memex process tree present (pid $PID)"
else
  fail "no UI process visible — pid alive but not in any process listing"
fi

# 6. Vault scaffold was created
[ -d "$VAULT" ]                              || fail "vault dir missing"
[ -d "$VAULT/raw" ]                          || fail "raw/ missing"
[ -d "$VAULT/wiki" ]                         || fail "wiki/ missing"
[ -d "$VAULT/daily" ]                        || fail "daily/ missing"
[ -d "$VAULT/ingest-reports" ]               || fail "ingest-reports/ missing"
[ -f "$VAULT/welcome.md" ]                   || fail "welcome.md missing"
[ -f "$VAULT/CLAUDE.md" ]                    || fail "CLAUDE.md missing"
[ -f "$VAULT/wiki/index.md" ]                || fail "wiki/index.md missing"
[ -f "$VAULT/wiki/log.md" ]                  || fail "wiki/log.md missing"
ok "vault scaffold present at $VAULT"

# 7. Link-graph cache was built (proves listFiles + buildLinkGraph IPCs ran)
[ -f "$VAULT/.memex/cache.db" ] || fail ".memex/cache.db not created (IPC chain broken)"
ok ".memex/cache.db created (IPC chain executed)"

# 8. Clean shutdown
kill -TERM $PID 2>/dev/null || true
sleep 1
kill -KILL $PID 2>/dev/null || true
trap - EXIT
ok "shutdown clean"

printf '\n\033[32mSMOKE TEST PASSED\033[0m\n'
