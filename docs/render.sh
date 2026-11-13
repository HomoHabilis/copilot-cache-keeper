#!/usr/bin/env bash
# Photographs the guide's charts (docs/make-figures.js) into docs/img/*.png with a headless browser.
# From WSL it uses the Windows Chrome or Edge; elsewhere, set BROWSER to a Chromium-based browser.
set -euo pipefail
cd "$(dirname "$0")/.."
node docs/make-figures.js
B="${BROWSER:-}"
for c in "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"; do
  [ -z "$B" ] && [ -x "$c" ] && B="$c"
done
[ -n "$B" ] || { echo "no browser found: set BROWSER"; exit 2; }
win() { case "$B" in /mnt/*) wslpath -w "$1" ;; *) echo "$1" ;; esac; }
TMP="$(mktemp -d)"; case "$B" in /mnt/*) TMP="$(wslpath "$(cd /mnt/c && cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')")/ck-figures"; rm -rf "$TMP"; mkdir -p "$TMP" ;; esac
cp docs/img/_html/*.html "$TMP/"
node -e 'for (const f of require("./docs/img/_html/figures.json")) console.log(f.name, f.w, f.h)' | while read -r name w h; do
  "$B" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size="$w,$h" \
    --screenshot="$(win "$TMP/$name.png")" "file:///$(win "$TMP/$name.html" | sed 's|\\|/|g')" </dev/null >/dev/null 2>&1
  cp "$TMP/$name.png" "docs/img/$name.png"; echo "docs/img/$name.png"
done
rm -rf "$TMP" docs/img/_html
