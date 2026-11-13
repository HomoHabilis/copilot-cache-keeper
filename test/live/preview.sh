#!/usr/bin/env bash
# Visual check of the nudges: Cache Keeper (this working tree) in a real VS Code window, showing
# every nudge, the status bar and its tooltip on a made-up chat (cacheKeeper.previewNudges), with a
# screenshot of each. No chat is opened and nothing is sent: it costs no credits. Run from WSL:
#   test/live/preview.sh [output folder]      (default: ./preview-shots, not committed)
#   test/live/preview.sh --show quiet-split   one stage, left on screen for you to look at and hover
# The window closes itself. Keep it visible and don't cover it: the screenshots are of the screen.
set -euo pipefail
cd "$(dirname "$0")/../.."
command -v cmd.exe >/dev/null || { echo "run this from WSL (it drives the Windows VS Code)"; exit 2; }
SHOW=""; if [ "${1:-}" = "--show" ]; then SHOW="${2:?which stage? split keepWarm waiting tip digest commit warning expired, or quiet-<stage>}"; shift 2; fi
OUT="$(mkdir -p "${1:-preview-shots}" && cd "${1:-preview-shots}" && pwd)"
WINTEMP_W="$(cd /mnt/c && cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')"
WINTEMP="$(wslpath "$WINTEMP_W")"
LIVE="$WINTEMP/ck-preview"; RESULT="$WINTEMP/ck-preview-result.txt"
rm -rf "$LIVE" "$RESULT"; mkdir -p "$LIVE/dev" "$LIVE/driver" "$LIVE/shots"
rm -f "$WINTEMP/ck-preview-show.txt"; [ -n "$SHOW" ] && printf '%s' "$SHOW" > "$WINTEMP/ck-preview-show.txt"
cp package.json extension.js core.js sqlite.js harnesses.js report.js nudges.js "$LIVE/dev/"
# --show readme: the README as it is packaged (its pictures inside it), in a throwaway extension of its own
# (another name, nothing but the README), so its page shows this working tree's README and not the installed one
if [ "$SHOW" = readme ]; then
  mkdir -p "$LIVE/readme"
  python3 - "$LIVE/readme" <<'PY'
import json, pathlib, sys
src = pathlib.Path("build.py").read_text(encoding="utf-8")
ns = {}
exec(src[src.index("def readme_with_pictures"):src.index("out = here")], ns)
out = pathlib.Path(sys.argv[1])
(out / "README.md").write_text(ns["readme_with_pictures"](pathlib.Path(".")), encoding="utf-8")
(out / "package.json").write_text(json.dumps({"name": "copilot-cache-keeper-readme", "publisher": "local", "version": "0.0.1",
    "displayName": "Copilot Cache Keeper (README check)", "description": "Only the README, to see how VS Code shows it.",
    "engines": {"vscode": "^1.100.0"}}), encoding="utf-8")
PY
fi
cp test/live/preview-driver/package.json test/live/preview-driver/extension.js "$LIVE/driver/"
cp test/live/shot.ps1 "$LIVE/shot.ps1"
if [ -n "$SHOW" ]; then echo "Opening a VS Code window showing \"$SHOW\" for 2 minutes: look, hover the status bar, close it when done."
else echo "Opening a VS Code window (it closes itself in about 2 minutes; keep it visible, hands off the keyboard)..."; fi
(cd /mnt/c && cmd.exe /c code --new-window \
  --extensionDevelopmentPath="$(wslpath -w "$LIVE/driver")" \
  --extensionDevelopmentPath="$(wslpath -w "$LIVE/dev")" \
  ${SHOW:+$([ "$SHOW" = readme ] && echo "--extensionDevelopmentPath=$(wslpath -w "$LIVE/readme")")} >/dev/null 2>&1)
seen=0; deadline=$(( $(date +%s) + 360 ))
until grep -q 'DONE\|ERROR' "$RESULT" 2>/dev/null; do
  [ "$(date +%s)" -gt "$deadline" ] && { echo "timed out; driver log:"; cat "$RESULT" 2>/dev/null; exit 1; }
  n=$(grep -c '^STAGE ' "$RESULT" 2>/dev/null || true)
  if [ "${n:-0}" -gt "$seen" ]; then
    seen=$n; stage=$(grep '^STAGE ' "$RESULT" | sed -n "${n}p" | cut -d' ' -f2)
    front=(-Front); case "$stage" in tooltip*) front=(-Hover) ;; readme-1) front=(-Front) ;; readme-*) front=(-PageDown) ;; esac      # the tooltip: the mouse over the entry (a key press would close it)
    (cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$LIVE/shot.ps1")" "${front[@]}" \
      -Out "$(wslpath -w "$LIVE/shots/$(printf '%02d' "$n")-$stage.png")" 2>&1 | tr -d '\r' | sed "s/^/$stage: /")
  fi
  sleep 0.4
done
if [ -n "$SHOW" ] && [ "$SHOW" != readme ]; then rm -f "$WINTEMP/ck-preview-show.txt"; exit 0; fi     # (the window loads from $LIVE: left in place)
cat "$RESULT" | grep -v '^STAGE' || true
cp "$LIVE"/shots/*.png "$OUT"/ 2>/dev/null || true
rm -rf "$LIVE" "$RESULT" "$WINTEMP/ck-preview-show.txt"
echo "Screenshots in $OUT:"; ls "$OUT"
