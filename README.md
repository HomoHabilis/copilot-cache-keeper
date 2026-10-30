# Copilot Cache Keeper

Warns before a Copilot agent chat's prompt cache expires, and offers to keep it warm or to
write a handoff summary. Copilot keeps a chat's cache for **5 minutes with Claude models**
and **30 minutes with Sol 6.1**. After that, your next message re-sends the whole context at
full price.

## What it does

- **Status bar:** the countdown for the chat shown in the Chat view, for example `cache 3:12 +1`
  (`+1` = one more chat managed in this window). Click it to see the chats in the window (all
  warm ones plus the most recently expired, at most 10) with live countdowns,
  with its countdown, model, context, cost if it expires and spend so far. Pick one to choose
  what happens to it.
- **60 s before expiry**, one notification per chat. It says what happens if you don't click,
  and has four buttons:
  - **No click:** what `cacheKeeper.noResponseAction` says. By default (`nothing`) the cache
    expires. If letting it expire would add at least `cacheKeeper.thresholdCredits` (default 60)
    to your next message, a handoff summary is written 15 s before expiry first. Below that, it
    just expires. It can also be set to `keepWarmOnce` or `autoKeepWarm`. Either way, an
    unanswered or closed warning means no more warnings for that chat until you write in it again.
  - **Keep warm:** sends one tiny keep-alive
    (`[cache-keeper] Keep-alive … Reply with only: OK`) **5 s before expiry**, for every model.
    A keep-alive buys a full cache lifetime from when it is sent, so later is cheaper. The next
    timeout warns you again. If you don't keep it warm again, a handoff summary is written before
    that expiry (`cacheKeeper.summaryAfterKeepWarm`, on by default).
  - **Auto keep warm:** does that before each expiry, up to a cap: `cacheKeeper.autoKeepWarmCapPercent`
    (default 50%) of what letting the cache expire would add, priced when auto keep warm starts.
    The closing handoff summary counts against the cap. When the next keep-alive would not fit,
    you get a warning to choose again (Keep warm once more, Auto keep warm with a fresh cap,
    Summarize, Ignore). With no click it writes the summary and stops (or just stops, with
    `summaryAfterKeepWarm` off, or if a summary written since your last message is still
    current). While it runs, the status bar turns red and shows spent / cap, because it spends
    credits on its own.
  - **Summarize:** asks the agent to write `.copilot-handoff/<time>-<session>.md` now
    (goal, state, decisions, files, next steps). The folder is added to `.git/info/exclude`.
    Its length fits the chat: 120 words + 2 per 1k tokens of context + 30 per message of yours +
    150 per compaction + 10 per edited file, between 150 and 1500. A one-question chat gets
    about 200 words; a long session with compactions gets up to 1500. The cost estimate uses
    the same length.
  - **Ignore:** leave this chat alone. No summary, no warnings and no expiry notice until you
    write in it again.
- **Status-bar list:** also offers **Back to default**, to undo a choice (for example to cancel
  Auto keep warm).
- **At expiry:** tells you what the next message will cost, with a button to start a new chat
  from the handoff file.
- **Every new cache window** (each time you or the agent sends something) brings the warning back,
  as long as you answered the last one. After Ignore, a summary, or a warning you closed or left
  unanswered, it comes back only once you send a real message yourself.

## Which chat gets the message

- **Always the intended one,** whichever chat the Chat view shows. VS Code has no "send to chat X"
  command, and what the Chat view shows can't be read reliably. So Cache Keeper opens the
  target chat itself as an editor tab ("Open as Editor"), which focuses it, then submits the
  message into it.
- **Cache still hit:** the prompt is the same as in the Chat view. Tested live: 97% cached.
- **Tabs:** a tab opened for this is closed again once the reply is in. A chat you already had
  open as a tab is left open.
- **The chat in the Chat view:** "Open as Editor" moves a chat out of the Chat view if it was
  shown there. VS Code doesn't tell extensions which chat the Chat view shows (tested: its saved
  state lags or never updates, and its "opened at" times are overwritten by Cache Keeper's own
  opens). Only where you last typed is known. `cacheKeeper.afterSend` decides what happens
  once the reply is in:
  - `restoreLastTyped` (default): the chat where you last typed goes back into the Chat view
    ("Move Chat into Side Bar"), and other tabs are closed. This is right as long as you type
    in the chat you are looking at. If you switched to another chat just to read it, the Chat
    view jumps back to the one you typed in.
  - `closeTab`: just close the tab. If the chat was in the Chat view, the view falls back to the
    sessions list.
  - `keepTab`: leave the tab open.
  In every case the message itself goes to the right chat.
- **Focus:** this takes focus for a second or two. If you're typing in an editor at that exact
  moment, focus jumps to the chat tab and comes back when it closes.
- **Verification:** after sending, it checks the debug logs to confirm the message landed in the
  intended chat. If not, it stops acting on that chat.
- **One chat at a time:** opening a chat, sending and moving it back are done one after the
  other, never interleaved. When several chats expire within seconds of each other, the one
  expiring first goes earlier (8 s per chat expiring within the next 10 s), so every round trip
  finishes before the next chat's turn.

## Costs and other safeguards

- **Prices** come from the price sheet Copilot sends VS Code for each chat (`models.json` in that
  chat's debug-log folder), at the tier for the chat's current context size (for example Sol's
  higher rate above 272k). They're applied to the last call's actual context, after any
  compaction. Nothing in the code is model-specific.
- **Unknown prices:** if a model isn't in the sheet, Cache Keeper shows no costs and never acts on
  its own.
- **Cache lifetimes** aren't in the price sheet. They're learned from Copilot CLI logs
  (`cacheTtlSeconds`). Otherwise the defaults are Claude 300 s, Sol 6.1 1800 s and 300 s for
  anything else, and `cacheKeeper.ttlSeconds` overrides them. The countdown starts when the last
  model call started, since that is when the cache was refreshed. (Your message comes earlier, but
  every call of an agent turn refreshes the cache, so counting from the message would send
  keep-alives far too early on long turns.)
- **Clocks:** log times come from the machine where Copilot runs (WSL, SSH host, container), but
  the countdown runs on the Windows clock. On every message it sends, Cache Keeper measures the
  offset between its decision and the time the remote log recorded the message. That offset
  covers clock difference, opening the tab, submitting and the network. The countdown is shifted
  earlier by the largest recent value, and never later. Until the first measurement it adds
  3 s of margin. A keep-alive sent with less than 1.5 s left is logged as a warning.
- **"Active since this window started"** is decided without clocks: the chat's log changed after
  Cache Keeper's first read.
- **After a reload or update:** no automatic action for chats last active before Cache Keeper
  started in this window. It only warns.
- **Ignored chats:** chats with only Cache Keeper messages, and chats where an expired cache
  costs less than `cacheKeeper.minCredits`.
- **No settings changes:** it never changes mode or model, since either would invalidate the
  cache.

## Install

Download the `.vsix` from the [latest release](https://github.com/HomoHabilis/copilot-cache-keeper/releases/latest).
It contains the whole extension, so it's the only file anyone needs.

**Install it once, on Windows, and it covers every window.** Cache Keeper is a UI extension
(`"extensionKind": ["ui"]`): it always runs on the machine that shows the VS Code window, never
on the remote side. It reads Copilot's debug logs wherever Copilot runs (WSL, SSH host,
container) through VS Code's own remote file access. So nothing needs installing in WSL, on an
SSH host or inside a container.

From **PowerShell** (or cmd) on Windows, in the folder where you saved the file:

```powershell
code --install-extension .\copilot-cache-keeper-0.7.5.vsix
```

Then reload any open VS Code windows (*Developer: Reload Window*).

Or in VS Code: *Extensions* view → **…** menu → **Install from VSIX…**, from a local (non-WSL,
non-remote) window. On Linux or macOS, run the same `code --install-extension` command in a
local shell.

### What one install covers

| Window | Where Copilot and its logs are | Install needed there? |
|---|---|---|
| Local Windows folder | Windows | No, the Windows install covers it |
| WSL (`WSL: …` in the status bar) | WSL distro | No |
| Dev container (local Docker or in WSL) | Container | No |
| Remote SSH | SSH host | No |
| SSH + dev container | Container on the SSH host | No |

In every case the extension runs on Windows and reads the logs on the remote side.

### Running it from a WSL terminal

A `code` command typed in a WSL terminal (including VS Code's terminal in a WSL window) talks to
the WSL side, so `code --install-extension` there installs into WSL, not Windows. A UI extension
installed there is not the one the window uses. Either use a Windows terminal, or call the
Windows `code` from WSL with a Windows path to the file:

```bash
cmd.exe /c code --install-extension "$(wslpath -w copilot-cache-keeper-0.7.5.vsix)"
```

If an older copy was installed inside WSL or a container, remove it there (from a terminal on that
side) with `code --uninstall-extension local.copilot-cache-keeper`.

## Settings

| Setting | Default | |
|---|---|---|
| `cacheKeeper.warnSeconds` | 60 | Warn this long before expiry |
| `cacheKeeper.noResponseAction` | nothing | When a warning gets no answer: `nothing`, `keepWarmOnce` or `autoKeepWarm` |
| `cacheKeeper.thresholdCredits` | 60 | Above this expiry cost, write the summary automatically if you don't answer |
| `cacheKeeper.autoSummary` | true | Turn the automatic summary off |
| `cacheKeeper.autoKeepWarmCapPercent` | 50 | Auto keep warm stops at this share (25/50/75/100%) of the expiry cost at its start, summary included |
| `cacheKeeper.summaryAfterKeepWarm` | true | Write a handoff summary when keeping warm ends (after Keep warm once, or at the auto cap) |
| `cacheKeeper.minCredits` | 5 | Ignore chats where an expired cache costs less than this |
| `cacheKeeper.keepAliveLeadSeconds` | 5 | Send keep-alives this long before expiry |
| `cacheKeeper.afterSend` | restoreLastTyped | What happens to the chat tab after a keep-alive or summary (see above) |
| `cacheKeeper.ttlSeconds` | {} | Cache lifetime per model id, if you need to override it |

## Build from source

Requires Python 3 (no Node build step and no dependencies):

```bash
python3 build.py
```

This writes `copilot-cache-keeper-<version>.vsix` next to the sources. The version is never
hardcoded (`package.json` says `0.0.0-dev`): it is the latest git tag plus the short commit,
e.g. `0.8.1-9cfc211`, or `VERSION` if set (`VERSION=v0.9.0 python3 build.py`).


## Tests and releases

- **Smoke test** (`.github/workflows/ci.yml`, on pull requests and pushes to `main`): syntax
  check, `node test/smoke.js`, and a check of the built `.vsix`. The `.vsix` is uploaded as the
  run's `copilot-cache-keeper-vsix` artifact (latest tag + short commit, e.g. `0.8.1-9cfc211`)
  to try a pull request's build. It counts as older than the tag's release, so installing it
  over that release may need `code --install-extension <file> --force`. `test/smoke.js` tests the cost and
  timing logic on a synthetic Copilot log, and the extension itself with a stand-in for the
  VS Code API, sending a keep-alive before the cache expires. Run it locally with
  `node test/smoke.js`.
- **Release** (`.github/workflows/release.yml`): GitHub → *Actions* → **Release** →
  **Run workflow**. It runs the smoke test first, then:
  - **Existing tag:** pick it in *Use workflow from*, and leave "tag" empty.
  - **New tag:** stay on a branch (e.g. `main`) and type the tag, e.g. `v0.7.6`. It's
    created on that branch's latest commit.
  - **Both empty:** it stops and asks for a tag.

  The `.vsix` is built with the tag's version and attached to a GitHub release with generated
  notes.
