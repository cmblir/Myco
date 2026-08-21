#!/usr/bin/env bash
#
# Verify a built macOS release BEFORE publishing it.
#
#   scripts/verify-macos-release.sh [bundle-dir | file.dmg | file.app] [--dry-run]
#
# Defaults to the target dir the signed local build writes to (docs/SIGNING.md
# step 15); pass a path to check a .dmg downloaded from a draft release instead.
# --dry-run prints the checks it would run and exits 0, so the script is
# exercisable without a build.
#
# Exit status: 0 when every REQUIRED check passed, 1 otherwise. Checks marked
# INFO never fail the run — they report state the release flow needs a human to
# judge (which updater artifacts exist, who signed).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="$ROOT/app/src-tauri/target/aarch64-apple-darwin/release/bundle"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h|--help) sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) BUNDLE_DIR="$arg" ;;
  esac
done

failures=0

say()  { printf '%s\n' "$*"; }
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; failures=$((failures + 1)); }
info() { printf '  INFO  %s\n' "$*"; }

# check <required|info> <label> <expected-substring|-> <command...>
check() {
  local kind="$1" label="$2" expect="$3"; shift 3
  if [ "$DRY_RUN" = true ]; then
    printf '  [%s] %s\n        $ %s\n' "$kind" "$label" "$*"
    return 0
  fi
  local out status
  out="$("$@" 2>&1)"; status=$?
  if [ $status -ne 0 ] || { [ "$expect" != "-" ] && ! printf '%s' "$out" | grep -q "$expect"; }; then
    if [ "$kind" = info ]; then
      info "$label — $(printf '%s' "$out" | head -1)"
    else
      fail "$label"
      printf '%s\n' "$out" | sed 's/^/        /' | head -8
    fi
    return 1
  fi
  if [ "$kind" = info ]; then
    info "$label — $(printf '%s' "$out" | grep "$expect" | head -1 | sed 's/^ *//')"
  else
    pass "$label"
  fi
}

APP=""
DMG=""
if [ -f "$BUNDLE_DIR" ]; then
  # A single downloaded artifact — how you check a draft release's .dmg.
  say "artifact: $BUNDLE_DIR"
  case "$BUNDLE_DIR" in
    *.dmg) DMG="$BUNDLE_DIR" ;;
    *.app) APP="$BUNDLE_DIR" ;;
    *) say "  FAIL  expected a .dmg, a .app, or a bundle directory"; exit 1 ;;
  esac
  BUNDLE_DIR="$(dirname "$BUNDLE_DIR")"
else
  say "bundle: $BUNDLE_DIR"
  if [ "$DRY_RUN" = false ] && [ ! -d "$BUNDLE_DIR" ]; then
    say "  FAIL  no such bundle directory — build first (docs/SIGNING.md step 15)"
    exit 1
  fi
  APP="$(ls -d "$BUNDLE_DIR"/macos/*.app 2>/dev/null | head -1)"
  DMG="$(ls "$BUNDLE_DIR"/dmg/*.dmg 2>/dev/null | head -1)"
  [ "$DRY_RUN" = true ] && APP="${APP:-$BUNDLE_DIR/macos/myco.app}" && DMG="${DMG:-$BUNDLE_DIR/dmg/myco_x.y.z_aarch64.dmg}"
fi

# bundle.targets is ["dmg", "nsis"], so a plain local build leaves no .app
# behind — the shipped copy is the one inside the .dmg. Mount it and check that,
# otherwise this script would verify nothing on the documented local flow.
MOUNT=""
cleanup() { [ -n "$MOUNT" ] && hdiutil detach "$MOUNT" -quiet 2>/dev/null; return 0; }
trap cleanup EXIT

if [ -z "$APP" ] && [ -n "$DMG" ] && [ "$DRY_RUN" = false ]; then
  MOUNT="$(mktemp -d)"
  if hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" -quiet; then
    APP="$(ls -d "$MOUNT"/*.app 2>/dev/null | head -1)"
    [ -n "$APP" ] && info "verifying the .app inside the .dmg (that is the copy users run)"
  else
    MOUNT=""
    fail "could not mount $(basename "$DMG")"
  fi
fi

# --- the .app ---------------------------------------------------------------
if [ -n "$APP" ]; then
  say ".app  $(basename "$APP")"
  # --deep is deprecated for SIGNING but is still the documented way to VERIFY
  # every nested binary; the bundled model loader and resources are nested.
  check required "code signature intact (codesign --verify --deep --strict)" - \
    codesign --verify --deep --strict --verbose=2 "$APP"
  check info "signing authority" "Authority=" \
    codesign -dv --verbose=4 "$APP"
  # The real user experience. Notarized + stapled prints
  # "source=Notarized Developer ID"; signed-but-not-notarized prints
  # "source=Unnotarized Developer ID" and Gatekeeper still blocks first launch.
  check required "Gatekeeper accepts it as notarized (spctl --assess)" "source=Notarized Developer ID" \
    spctl --assess --type execute --verbose=4 "$APP"
  check required "notarization ticket stapled to the .app" - \
    xcrun stapler validate "$APP"
else
  fail "no .app found — neither in macos/ nor inside a .dmg"
fi

# --- the .dmg ---------------------------------------------------------------
if [ -n "$DMG" ]; then
  say ".dmg  $(basename "$DMG")"
  check required "code signature intact (codesign --verify --strict)" - \
    codesign --verify --strict --verbose=2 "$DMG"
  # Tauri notarizes and staples the .app, then wraps it: the disk image is
  # SIGNED but carries no ticket of its own unless you submit it separately.
  # So both of these are INFO — the .app checks above are the ones that decide
  # whether a user's first launch works. A disk image is assessed under the
  # "open" policy, not "execute".
  check info "Gatekeeper assessment of the disk image" "source=" \
    spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"
  check info "notarization ticket stapled to the .dmg (optional)" - \
    xcrun stapler validate "$DMG"
else
  info "no .dmg in $BUNDLE_DIR/dmg"
fi

# --- updater artifacts ------------------------------------------------------
say "updater"
TARBALL="$(ls "$BUNDLE_DIR"/macos/*.app.tar.gz 2>/dev/null | head -1)"
if [ "$DRY_RUN" = true ]; then
  printf '  [info] updater artifacts present (%s/macos/*.app.tar.gz + .sig)\n' "$BUNDLE_DIR"
elif [ -z "$TARBALL" ]; then
  info "no updater artifact — this build did not set createUpdaterArtifacts (CI does, with the key)"
elif [ -f "$TARBALL.sig" ]; then
  pass "updater signature present ($(basename "$TARBALL").sig)"
else
  fail "updater artifact $(basename "$TARBALL") has NO .sig — the app will reject this update"
fi

say ""
if [ "$DRY_RUN" = true ]; then
  say "dry run — nothing executed."
  exit 0
fi
if [ "$failures" -eq 0 ]; then
  say "OK — safe to publish."
  exit 0
fi
say "$failures required check(s) failed — do NOT publish."
exit 1
