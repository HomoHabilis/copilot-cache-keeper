#!/usr/bin/env bash
# Visual check of the nudges: Cache Keeper (this working tree) in a real VS Code window, showing
# every nudge, the status bar and its tooltip on a made-up chat (cacheKeeper.previewNudges), with a
# screenshot of each. No chat is opened and nothing is sent: it costs no credits. Run from WSL:
#   test/live/preview.sh [output folder]      (default: ./preview-shots, not committed)
# The window closes itself. Keep it visible and don't cover it: the screenshots are of the screen.
set -euo pipefail
cd "$(dirname "$0")/../.."
command -v cmd.exe >/dev/null || { echo "run this from WSL (it drives the Windows VS Code)"; exit 2; }
OUT="$(mkdir -p "${1:-preview-shots}" && cd "${1:-preview-shots}" && pwd)"
WINTEMP_W="$(cd /mnt/c && cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')"
WINTEMP="$(wslpath "$WINTEMP_W")"
LIVE="$WINTEMP/ck-preview"; RESULT="$WINTEMP/ck-preview-result.txt"
rm -rf "$LIVE" "$RESULT"; mkdir -p "$LIVE/dev" "$LIVE/driver" "$LIVE/shots"
cp package.json extension.js core.js sqlite.js harnesses.js report.js nudges.js "$LIVE/dev/"
cp test/live/preview-driver/package.json test/live/preview-driver/extension.js "$LIVE/driver/"
cp test/live/shot.ps1 "$LIVE/shot.ps1"
echo "Opening a VS Code window (it closes itself in about 2 minutes; keep it visible)..."
(cd /mnt/c && cmd.exe /c code --new-window \
  --extensionDevelopmentPath="$(wslpath -w "$LIVE/driver")" \
  --extensionDevelopmentPath="$(wslpath -w "$LIVE/dev")" >/dev/null 2>&1)
seen=0; deadline=$(( $(date +%s) + 240 ))
until grep -q 'DONE\|ERROR' "$RESULT" 2>/dev/null; do
  [ "$(date +%s)" -gt "$deadline" ] && { echo "timed out; driver log:"; cat "$RESULT" 2>/dev/null; exit 1; }
  n=$(grep -c '^STAGE ' "$RESULT" 2>/dev/null || true)
  if [ "${n:-0}" -gt "$seen" ]; then
    seen=$n; stage=$(grep '^STAGE ' "$RESULT" | sed -n "${n}p" | cut -d' ' -f2)
    front=(-Front); case "$stage" in tooltip*) front=() ;; esac      # a hover closes on a key press
    (cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$LIVE/shot.ps1")" "${front[@]}" \
      -Out "$(wslpath -w "$LIVE/shots/$(printf '%02d' "$n")-$stage.png")" 2>&1 | tr -d '\r' | sed "s/^/$stage: /")
  fi
  sleep 0.4
done
cat "$RESULT" | grep -v '^STAGE' || true
cp "$LIVE"/shots/*.png "$OUT"/ 2>/dev/null || true
rm -rf "$LIVE" "$RESULT"
echo "Screenshots in $OUT:"; ls "$OUT"
