#!/usr/bin/env bash
# Live test: Cache Keeper (this working tree) in a real VS Code window, one new chat per harness,
# a keep-alive sent by Cache Keeper itself into each, then checked against the chats' real logs.
# Sends real messages: costs Copilot credits (see README.md). Run from WSL, in the repository:
#   test/live/run.sh                      all four harnesses (local sdk claude codex)
#   test/live/run.sh claude codex         only some
#   test/live/run.sh --yes ...            don't ask before spending credits
#   test/live/run.sh --keep ...           keep the test folder and temp files afterwards
#   test/live/run.sh --compact ...        also compact each chat (/compact) after the keep-alive
set -euo pipefail
cd "$(dirname "$0")/../.."

YES=0; KEEP=0; COMPACT=0; HARNESSES=()
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    --keep) KEEP=1 ;;
    --compact) COMPACT=1 ;;
    local|sdk|claude|codex) HARNESSES+=("$a") ;;
    *) echo "unknown argument: $a (harnesses: local sdk claude codex; options: --yes --keep --compact)"; exit 2 ;;
  esac
done
[ ${#HARNESSES[@]} -eq 0 ] && HARNESSES=(local sdk claude codex)

command -v cmd.exe >/dev/null || { echo "run this from WSL (it drives the Windows VS Code)"; exit 2; }
command -v node >/dev/null || { echo "node is needed"; exit 2; }
DISTRO="${WSL_DISTRO_NAME:?not in WSL}"
WINTEMP_W="$(cd /mnt/c && cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')"
WINTEMP="$(wslpath "$WINTEMP_W")"
LIVE="$WINTEMP/ck-live"                         # driver + working-tree copy of Cache Keeper (Windows side)
WS="$HOME/ck-live-ws"                           # test folder, opened as a WSL folder, kept between runs
ATTACH="$HOME/.ck-live-attachment/ck-live-attachment.txt"   # attached file, outside the test folder
RUN_ID="r$(date +%H%M%S)"
RESULT="$WINTEMP/ck-live-result.txt"
CKLOG="$WINTEMP/ck-live.log"

echo "Live test, run $RUN_ID: ${HARNESSES[*]}"
echo "Each harness: one new chat with 2 short messages, then 1 keep-alive. A new chat's first message"
echo "re-sends its system prompt (20-40k tokens): about 0.5 credit on Haiku, 5-8 on Sol, 15-20 on Opus,"
echo "whatever model each harness is set to. Pick a cheap model in each harness first if you can."
[ $COMPACT -eq 1 ] && echo "--compact: then one /compact per chat (reads the small context warm, writes a short summary)."
if [ $YES -eq 0 ]; then read -r -p "Spend those credits? [y/N] " ok; [ "$ok" = "y" ] || exit 1; fi

# Working-tree copy of the extension and the driver, where Windows VS Code can load them
rm -rf "$LIVE"; mkdir -p "$LIVE/dev" "$LIVE/driver"
cp package.json extension.js core.js sqlite.js harnesses.js "$LIVE/dev/"
cp test/live/driver/package.json test/live/driver/extension.js "$LIVE/driver/"

# Test folder: Cache Keeper's log mirrored to a file, every chat counted (cheap models too)
# No expiry warnings: a chat in its warning's last 30 s goes first in Cache Keeper's "which chat?"
# list, and the driver takes the first one (the chat it just wrote in).
# Kept between runs: VS Code asks once whether you trust a new folder, and holds agent requests until then.
mkdir -p "$WS/.vscode" "$(dirname "$ATTACH")"
echo "Attached by the live test: must never go out with a keep-alive." > "$ATTACH"
cat > "$WS/.vscode/settings.json" <<EOF
{
  "cacheKeeper.debugLogFile": "$(echo "$WINTEMP_W\\ck-live.log" | sed 's/\\/\\\\/g')",
  "cacheKeeper.minCredits": 0,
  "cacheKeeper.afterSend": "restoreLastTyped",
  "cacheKeeper.warnSeconds": 0,
  "cacheKeeper.compactHarnesses": ["local", "sdk", "claude", "codex"]
}
EOF
AUTH="wsl%2B$(echo "$DISTRO" | tr '[:upper:]' '[:lower:]')"
CK_COMPACT=$COMPACT node test/live/plan.js "vscode-remote://$AUTH$WS" "vscode-remote://$AUTH$ATTACH" "$RUN_ID" "${HARNESSES[@]}" > "$WINTEMP/ck-live-plan.json"
rm -f "$RESULT" "$CKLOG"

echo "Opening a VS Code window (it closes itself when done; don't type in it)..."
(cd /mnt/c && cmd.exe /c code --new-window \
  --extensionDevelopmentPath="$(wslpath -w "$LIVE/driver")" \
  --extensionDevelopmentPath="$(wslpath -w "$LIVE/dev")" >/dev/null 2>&1)

deadline=$(( $(date +%s) + 60 + (150 + 70 * COMPACT) * ${#HARNESSES[@]} )); asked=0
until grep -q 'DONE\|ERROR' "$RESULT" 2>/dev/null; do
  if [ $asked -eq 0 ] && grep -q 'WAITING-TRUST' "$RESULT" 2>/dev/null; then
    asked=1; echo ">>> VS Code asks whether you trust the test folder: click Trust in that window (asked once)."
    deadline=$(( deadline + 600 ))
  fi
  [ "$(date +%s)" -gt "$deadline" ] && { echo "timed out; driver log so far:"; cat "$RESULT" 2>/dev/null; exit 1; }
  sleep 5
done
sleep 3
echo; echo "--- driver"; sed 's/^[^ ]* //' "$RESULT"
echo; echo "--- Cache Keeper"; grep -E 'keep-alive|compaction|unsent|moved|not sent|failed|error' "$CKLOG" || true

status=0
CK_COMPACT=$COMPACT node test/live/check.js "$CKLOG" "$RESULT" "$RUN_ID" "${HARNESSES[@]}" || status=$?
if [ $KEEP -eq 0 ]; then rm -rf "$LIVE" "$RESULT" "$CKLOG" "$WINTEMP/ck-live-plan.json"; fi   # the test folder stays (trusted)
echo "The test chats (ck-live ...) stay in VS Code's Sessions list; archive them when you like."
exit $status
