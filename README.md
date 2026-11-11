# Copilot Cache Keeper

Warns before a Copilot agent chat's prompt cache expires, and offers to keep it warm or to
write a handoff summary. Copilot keeps a chat's prompt cache only for a while after the last
call, and how long depends on the model: for example, **Opus 5.5 has a 5-minute timeout**
while **Sol 6.1 has 30 minutes**. After that, your next message re-sends the whole context at
full price.

It works with the chat harnesses in VS Code that spend Copilot credits, also when you mix them in
one window: **Local** (VS Code's own agent), **Copilot** (the Copilot SDK harness), **Claude**
(Claude Agent SDK) and **Codex**, the last three run by VS Code's Agent Host.
See [Supported chat harnesses](#supported-chat-harnesses).

## What it does

- **Status bar:** the countdown for the chat where you last typed, kept short, for example
  `🔥 3:12 +1` (`+1` = one more chat managed in this window); the tooltip has the details. With
  Keep warm once chosen it reads `🔥 3:12 · armed`; with Auto keep warm `⚡ 3:12 · 1.2/10 cr`
  (spent / cap) and the bar is red, since that spends credits on its own (`· ⚡×2` = auto keep warm
  on in two other chats). Click it to see the chats in the window (all
  warm ones plus the most recently expired, `cacheKeeper.expiredChats`, default 5), each marked
  Local or Copilot SDK, with its live countdown, model,
  context, cost if it expires and spend so far. Pick one to choose what happens to it.
  - **While the agent works** (including subagents and long terminal commands), it shows
    `working · 2:41` and never sends anything into that chat: a message would be
    queued and could run after the cache expired. Once the agent has worked past the cache
    lifetime it says `working · possibly expired`: the countdown runs from the last model call's
    start, and a long answer can still leave the cache warm.
  - **Expired and large:** when that chat's cache has expired and its context is at least
    `cacheKeeper.thresholdTokens` (default 100k tokens), the status bar turns orange:
    `⚠ expired · +72 cr`. Coming back to an old chat, this tells you before you type
    that your next message re-sends all of it. The threshold is in tokens because a cold send
    costs about context × the model's input price, so one value fits Haiku and Opus alike; the
    label still shows credits. If a handoff summary was written, the tooltip says what a new chat
    from it would cost instead.
  - **While Cache Keeper sends** a keep-alive or summary, it shows
    `sending… don't type`: for those seconds the target chat is focused, so
    something you type would land there.
  - **Last chance:** a warning still unanswered in the last 30 s before expiry (it may have slid
    into the notification center unseen) turns the bar into `🔔 Refactor the parser 0:22 · click
    to choose`, for whichever chat it is. That chat is first in the list; a choice there counts
    as answering the warning.
- **60 s before expiry**, one short notification per chat: `Cache for "Refactor the parser"
  expires in 59s. Expiry adds ~20 cr to your next message. No click: …`. The buttons carry their
  cost (`Keep warm (~1.1 cr)`, `Auto keep warm`, `Summarize (~2.5 cr)`, `Ignore`):
  - **No click:** nothing is kept warm, the cache expires. Keeping warm (once or auto) always
    takes a click. If the chat's context is at least `cacheKeeper.thresholdTokens` (default 100k
    tokens, about 40 credits with Opus 5.5), a handoff summary is written 15 s before expiry
    first. Below that, or when the model's price is unknown, it just expires. An
    unanswered warning means no more warnings for that chat until you write in it again.
  - **Closing the warning (X):** same as Ignore below: nothing automatic, nothing spent.
  - **Keep warm:** sends one tiny keep-alive **5 s before expiry**, for every model. Its wording
    is picked at random from a short list of plain messages (for example "Stepping away for a few
    minutes. Just reply OK, no tools needed."), never the same twice in a row and with no tag. It is written in
    the language you use in that chat (English, Italian, French, Spanish or German, guessed
    from common words in Copilot's recent answers and your last messages; English when
    unsure). Cache Keeper recognises them by that list, and its output log shows each one it sent.
    A keep-alive buys a full cache lifetime from when it is sent, so later is cheaper. To avoid a
    fixed, bot-like beat, each keep-alive goes out a random bit earlier: up to 10% of
    the cache lifetime ahead of that, so
    5 to 35 s before expiry for a 5 min cache. Never later than the 5 s lead. The next
    timeout warns you again (and says the summary is coming). If you don't keep it warm again, a handoff summary is written before
    that expiry (`cacheKeeper.summaryAfterKeepWarm`, on by default). Back to default, Ignore,
    Summarize or *Stop keeping warm* cancel that summary.
    Keeping warm needs a warm cache: clicked on a warning whose cache has already expired (it can
    sit in the notification center), Keep warm asks first, with the cost, like *Keep warm now*,
    and Auto keep warm does nothing. Neither is ever left armed for the cache window after your
    next message; a keep-warm choice that could not send (agent working, too late) ends at expiry.
  - **Auto keep warm:** does that before each expiry, up to a cap: `cacheKeeper.autoKeepWarmCapPercent`
    (default 50%) of what letting the cache expire would add, priced when auto keep warm starts.
    It also stops at a time limit: no keep-alive goes out that would keep the chat warm past 2 h
    of keep-warm time. 2 h is a hard cap; `cacheKeeper.autoKeepWarmMaxMinutes` can only lower it. Keep-warm
    time counts Keep warm once and Auto keep warm together, from your first keep-warm choice,
    until the cache expires, you pick Back to default, Ignore, Summarize or Stop keeping warm, or
    close the warning. Writing in the chat yourself starts it again from then. The chat list and
    the status-bar tooltip show it ("kept warm 1 h 10 min of 2 h").
    The closing handoff summary counts against the cap. When the next keep-alive would not fit
    the cap or the time limit, you get a warning to choose again (Keep warm once more, Auto keep
    warm with a fresh cap, and a fresh 2 h if the time limit was reached, Summarize, Ignore). With no click it writes the summary and stops (or just stops, with
    `summaryAfterKeepWarm` off, or if a summary written since your last message is still
    current). While it runs, the status bar turns red and shows spent / cap, because it spends
    credits on its own.
  - **Automatic summaries only when they pay off:** all three cases above (no click, after Keep
    warm once, at the auto cap) write a summary only if the summary plus the first message of a new
    chat built from it cost at most 75% of continuing this chat cold. On a small context, a new
    chat's own setup (system prompt, tools) costs about as much as continuing, so the cache just
    expires instead. **Summarize** (clicked) always writes one.
  - **Summarize:** on a chat whose cache has already expired, asks first, with the cost (the
    request re-sends the whole context), like *Keep warm now*; declined, the chat is back to the
    default. On a warm chat it is written right away; while the agent works, once it's done. It asks the agent, in the chat's language and starting with `[summary]` (or
    `[riepilogo]`, `[résumé]`, `[resumen]`, `[Zusammenfassung]`), to write
    `.copilot-handoff/<time>-<session>.md` now
    (goal, state, decisions, files, next steps). The folder is added to `.git/info/exclude` of
    every workspace folder's repository (worktrees and submodules included). Once the agent is
    done, Cache Keeper checks the file is there; written elsewhere in the workspace, it is used
    from there; not written at all, you are told. Old summaries are cleaned up: in each
    `.copilot-handoff/`, the newest 5 always stay (`cacheKeeper.handoffKeep`) and older ones past
    7 days go to the trash (`cacheKeeper.handoffMaxAgeDays`, 0 = never).
    Its length fits the chat: 120 words + 2 per 1k tokens of context + 30 per message of yours +
    150 per compaction + 10 per edited file, between 150 and 1500. A one-question chat gets
    about 200 words; a long session with compactions gets up to 1500. Since the summary is
    output (the priciest tokens) and is then read back uncached, the length is also capped so
    the summary costs at most a third of what an expiry would add (it matters only for a small
    context with a long history, for example after several compactions). The cost estimate uses
    the same length.
  - **Ignore:** leave this chat alone. No summary, no warnings and no expiry notice until you
    write in it again.
- **Status-bar list order:** the chat where you last typed first (marked "where you last
  typed"), then the other warm or working chats by soonest expiry, then the latest expired chats
  (`cacheKeeper.expiredChats`, default 5) and any with a handoff summary ready. Only chats active
  within `cacheKeeper.lookbackHours` (default 48) are read at all, so older ones are never listed.
- **Status-bar list:** also offers **Back to default**, to undo a choice (for example to cancel
  Auto keep warm), and **New chat from handoff** on a chat with a handoff summary. On an expired
  chat it offers **Keep warm now** (asks first, with the cost) instead of Keep warm and Auto keep
  warm. Auto keep warm is only offered when the model's price is known, since its cap is in credits.
  Each choice shows what it does and costs for that chat right now, and the current one is marked.
- **New chat from handoff** opens the new chat in the same harness as the old one (Claude, Codex,
  Copilot SDK) when VS Code has a "new session" command for it; otherwise in a Local chat, and it
  tells you so.
- **At expiry:** tells you what the next message will cost, with a button to start a new chat
  from the handoff file. That notice can slide into the notification center while you are away;
  the same action stays in the status-bar list.
- **Keep warm now** and **Write handoff summary now** (commands) ask which chat when there are
  several, and name the chat in what they report. On a chat whose cache already expired they ask
  first, with the cost, since that message re-sends the whole context.
- **Diagnostics:** *Cache Keeper: Show which chats are tracked (diagnostics)* lists every chat log
  it found, for every harness (last 7 days), and why each one is or isn't in the list. For an Agent
  Host chat it also shows the URI it would be opened by, and for Claude and Codex where the log is
  and where the prices come from. Start there when a chat gets no warning. It also counts how
  many of Cache Keeper's own messages landed on a warm cache.
- **Cache hits:** for every message (yours or Cache Keeper's), the Output panel logs how much of
  the call that answered it was cached, and how long after the previous call (from its start and
  from its end): `cache hit for Cache Keeper's message in 1a2b3c4d: 98% cached (148k of 151k),
  287 s after the previous call started (12 s after it ended)`.
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
- **What you typed or attached, not sent yet:** stays in the chat's input box, and is not sent
  with Cache Keeper's message. A plain submit would send the input box's attachments and implicit
  context (the active file) along with the message, then empty the box. Cache Keeper sends with
  VS Code's `preserveInput` option instead (what VS Code itself uses for `/compact`): only its own
  text goes out, and your text and attachments are left as they were. Should a VS Code version
  ignore that option, Cache Keeper notices the emptied box and puts your text back once the reply
  is in (attachments can't be restored that way). Tested live on all four harnesses.
- **"Do you trust the authors of the files in this folder?"** (VS Code 1.145, WSL/remote windows):
  VS Code checks the folder of an existing Agent Host chat (Copilot SDK, Claude, Codex) against the
  trust list as if it were a Windows path (`\home\you\project`), so the second message into such a
  chat asks for trust, whoever sends it (you or Cache Keeper). That is a VS Code bug, not Cache
  Keeper. Answer *Trust Folder & Continue* once per folder. Until it's answered, Cache Keeper's
  message waits (it warns "probably queued") and may arrive after the cache expired.
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
  compaction. The cache write rate is then corrected from what Copilot actually billed for that
  chat's recent uncached calls, so the expiry cost matches the bill rather than the list price.
  Nothing in the code is model-specific. Copilot SDK chats log the exact per-token prices they
  were billed, which are used instead. Claude and Codex logs carry no prices: they use Copilot's
  price sheet from the newest Local chat log on the window's side (this workspace's first, else the
  most recently used workspaces), with Claude's model names mapped to Copilot's
  (`claude-haiku-5-5` is `claude-haiku-5.5`).
- **Credits spent so far:** all four harnesses are billed by the same Copilot backend at the same
  prices. Shown as billed per call for Local and Copilot SDK chats, as billed per turn for Claude
  chats (VS Code's `session.db`). Codex logs don't record the billed amount, so its credits are
  computed from its token counts at Copilot's prices.
- **Unknown prices:** if a model isn't in the sheet, Cache Keeper shows no costs and never acts on
  its own.
- **Cache lifetimes** vary by model and aren't in the price sheet. In order:
  1. `cacheKeeper.ttlSeconds`, per model id, if you set it.
  2. **Copilot SDK and Claude chats:** the chat's own log. Copilot SDK logs state each call's cache
     expiry exactly; Claude logs say which cache tier each call wrote (5 minutes or 1 hour).
  3. **Copilot CLI and Copilot SDK logs:** `cacheTtlSeconds` in `~/.copilot/session-state/*/events.jsonl`
     (logged on every model call and at each idle checkpoint), on Windows and on the window's remote
     side (newest 30 sessions, rechecked every 30 min). These are exact values from Copilot's
     backend, the same one Local chats use, so they apply to Local chats too: using a model in a
     Copilot SDK chat or Copilot CLI teaches its lifetime to all chats. The newest value per model
     wins (by the event's own time), even when it is shorter. Values older than
     60 days are dropped, since Copilot can change a lifetime
     server side.
  4. **Measured in your Local and Codex chats:** their logs don't state lifetimes, but a call that still
     hit the cache after a pause of N seconds proves it lasts at least N. Only proofs where the
     cache covered the chat's own conversation count (not just the shared system prompt, which
     another chat may keep warm), timed from the previous call of that model of any kind (title and
     summary calls also refresh it). The longest proof per model is kept across windows for
     60 days.
     It only ever lengthens the default (rounded down to the minute, and only when more than 60 s
     longer): a cache miss can have other causes, so it never shortens it. On real logs this gives
     for example `kimi-k2.7-code` 1080 s, while Claude models stay at 300 s.
  5. Defaults: 300 s for Claude models, 1800 s for Sol 6.1, 300 s for anything else.

  The most precise source wins: exact values (1-3) before the measured minimum (4) before the
  defaults (5). The Output panel logs the learned values, with their age, when they change, and the status-bar tooltip and
  diagnostics show each chat's lifetime and where it came from. The countdown starts when the last
  model call started, since that is when the cache was refreshed. (Your message comes earlier, but
  every call of an agent turn refreshes the cache, so counting from the message would send
  keep-alives far too early on long turns.)
- **Clocks:** log times come from the machine where Copilot runs (WSL, SSH host, container), but
  the countdown runs on the Windows clock. On every message it sends, Cache Keeper measures the
  offset between its decision and the time the remote log recorded the message. That offset
  covers clock difference, opening the tab, submitting and the network. The countdown is shifted
  earlier by the largest recent value, and never later. Until the first measurement it adds
  3 s of margin. With less than 1.5 s left, a keep-alive is not sent at all (it would arrive
  cold and cost the full re-send).
- **Late or queued sends:** right before submitting, after the tab is open, Cache Keeper checks
  again that the agent isn't working and enough time is left. If its message still isn't in the
  log 8 s later, it was queued, and you get a warning.
- **Log folder:** Copilot's logs are in the window's `workspaceStorage/<id>` folder, but VS Code
  sometimes moves to a sibling `<id>-1`, `<id>-2`… Cache Keeper reads whichever has the newest
  activity and looks again every minute.
- **"Active since this window started"** is decided without clocks: the chat's log changed after
  Cache Keeper's first read.
- **After a reload or update:** no automatic action for chats last active before Cache Keeper
  started in this window. It only warns.
- **Ignored chats:** chats with only Cache Keeper messages, and chats where an expiry would add
  less than `cacheKeeper.minCredits` (default 5). Nothing at all happens for them: no listing,
  warning, automatic action or orange status.
- **The "expensive" threshold is in tokens** (`cacheKeeper.thresholdTokens`): an expiry costs
  about context × the model's input price, so one value fits cheap and expensive models alike.
  It applies only to chats that already pass `minCredits`. Costs are still shown in credits.
- **No settings changes:** it never changes mode or model, since either would invalidate the
  cache.

## Supported chat harnesses

VS Code offers several harnesses in the Chat view. Cache Keeper handles the four that can spend
Copilot credits:

- **Local**: VS Code's own agent. Its chats are logged per workspace in the Agent Debug Log
  (`workspaceStorage/<id>/GitHub.copilot-chat/debug-logs/<chat>/`).
- **Copilot** (Copilot SDK): `~/.copilot/session-state/<id>/` (`events.jsonl`, `workspace.yaml`
  with `client_name: vscode-agent-host`). Copilot CLI sessions share that folder and are left out.
- **Claude** (Claude Agent SDK, "uses your existing Copilot subscription"):
  `~/.claude/projects/<folder>/<id>.jsonl`.
- **Codex** (routed through Copilot, or your own OpenAI account): `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`.

The last three run in VS Code's Agent Host, on the machine the window runs on: the WSL distro, SSH
host or container for a remote window, Windows for a local one.

| Feature | Local | Copilot SDK | Claude | Codex |
|---|---|---|---|---|
| Found and listed | Agent Debug Log of this workspace | `~/.copilot/session-state` | VS Code's chat list (`agent-host.db`), then its log | same |
| Countdown starts | last call's start | exact expiry in the log | when the request was sent | when the request's last input arrived |
| Cache lifetime | setting, Copilot logs, measured, default | setting, the chat's log | setting, the chat's log (cache tier) | setting, Copilot logs, measured, default |
| Prices | price sheet, calibrated | billed per token, exact | Copilot price sheet | Copilot price sheet |
| Credits spent | as billed | as billed | as billed, per turn | from token counts at Copilot's prices |
| "Agent working" (never sends then) | open turns | open turns, waiting message, the ms between steps | turn not ended (`end_turn`), queued message | task started, not complete |
| Warnings, Keep warm, Auto keep warm, Summarize, Ignore, handoff | yes | yes | yes | yes |
| Opened by | `vscode-chat-session://local/<id>` | `agent-host-copilotcli:/<VS Code id>` | `agent-host-claude:/<VS Code id>` | `agent-host-codex:/<VS Code id>` |
| Your unsent text and attachments kept | yes | yes | yes | yes |
| Language of our messages | yes | yes | yes | yes |

**How it is built.** Each harness has a small translator (`harnesses.js`) that turns its log into
one shared list of events: your messages, model calls (tokens, cache read and write, cost and cache
lifetime when the log says), turns starting and ending, tools running, replies, edited files,
compactions. Everything else (countdown, costs, busy detection, warnings, keep-alives, summaries)
works on that list, identically for every harness. A log format that changes makes that
harness's chats disappear from the list; it never sends into a chat it can't read.

**Which chats are read.** Claude and Codex chats are found through VS Code's own databases, the
same way for both: `agent-host.db` lists the chats, and each chat's
`agentSessionData/<VS Code id>/session.db` says where its log is (Claude `sdkSessionId`, Codex
`codex.threadId`), its folder, how it is billed (`@provider=copilot:` or `vscode-proxy:` = through
Copilot) and, for Claude, the credits Copilot billed per turn. Left alone:

- **Your own Claude Code sessions.** The Claude harness also lists the Claude Code sessions it
  finds in `~/.claude` (registered as "discovered"), and their transcripts sit in the same folders.
  They are billed by Anthropic, not Copilot: only chats VS Code created are read.
- **Chats billed to your own Anthropic or OpenAI account.**
- **Chats of another folder** (see below).

The diagnostics command lists each of them with the reason.

**Which window acts on an Agent Host chat.** Local chats are stored per workspace, so only their
window sees them. Agent Host chats are stored per machine, so every window on that machine reads all
of them:

- A chat started in a folder belongs to the window that has that folder open (its working folder
  or git root is the folder or inside it). Other windows leave it alone.
- A chat started without a folder can be opened from any window on that machine. The first window
  to see it takes it, with a small claim file in Cache Keeper's global storage that it refreshes
  every 5 s. If that window closes, another takes over 20 s later.

**How an Agent Host chat is opened.** Its log id is not the id VS Code opens it by. For Copilot SDK
chats the link is in `agent-host.db` (`chats_v2`: `owner_session_uri` `copilotcli:/<VS Code id>`,
`provider_data.sdkSessionId` = the log folder id); for Claude and Codex VS Code's chat list gives the
id directly. Both databases sit next to the window's side `globalStorage`
(`%APPDATA%\Code\User\globalStorage` locally, `~/.vscode-server/data/User/globalStorage` in WSL or
SSH) and are read with a small built-in SQLite reader (read-only, including the `-wal` file).

**Tested live** with VS Code 1.142 in a WSL window, one new chat per harness, keep-alives sent by
Cache Keeper itself: every message landed in the intended chat, with the cache hit (Local 21,654 of
22,150 tokens, Copilot SDK 23,410 of 23,503, Claude 21,219 of 21,295, Codex 34,253 of 35,229). One
harness quirk: right after a chat's very first message, Claude and Codex rebuild part of their
prompt, so a keep-alive sent as the chat's second turn gets a partial hit (Claude 74%) or none
(Codex). From the third turn on, keep-alives hit like any other message.

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
code --install-extension .\copilot-cache-keeper-<version>.vsix
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
cmd.exe /c code --install-extension "$(wslpath -w copilot-cache-keeper-<version>.vsix)"
```

If an older copy was installed inside WSL or a container, remove it there (from a terminal on that
side) with `code --uninstall-extension local.copilot-cache-keeper`.

## Settings

| Setting | Default | |
|---|---|---|
| `cacheKeeper.warnSeconds` | 60 | Warn this long before expiry |
| `cacheKeeper.thresholdTokens` | 100000 | From this context size a chat is expensive to let expire: write the summary if you don't answer, and show it in orange once expired |
| `cacheKeeper.autoSummary` | true | Turn the automatic summary off |
| `cacheKeeper.autoKeepWarmCapPercent` | 50 | Auto keep warm stops at this share (25/50/75/100%) of the expiry cost at its start, summary included |
| `cacheKeeper.autoKeepWarmMaxMinutes` | 120 | Auto keep warm stops after this much keep-warm time (Keep warm once included); 1 to 120, never more |
| `cacheKeeper.summaryAfterKeepWarm` | true | Write a handoff summary when keeping warm ends (after Keep warm once, or at the auto cap) |
| `cacheKeeper.minCredits` | 5 | Ignore chats where an expiry would add less than this, for everything |
| `cacheKeeper.afterSend` | restoreLastTyped | What happens to the chat tab after a keep-alive or summary (see above) |
| `cacheKeeper.ttlSeconds` | {} | Cache lifetime per model id, if you need to override it |
| `cacheKeeper.expiredChats` | 5 | How many expired chats the status-bar list keeps (most recent first) |
| `cacheKeeper.lookbackHours` | 48 | Read chats whose log changed within this many hours; older ones are never listed |
| `cacheKeeper.handoffMaxAgeDays` | 7 | Delete handoff summaries older than this (to the trash where possible), except the newest `handoffKeep`; 0 = never |
| `cacheKeeper.handoffKeep` | 5 | How many of the newest handoff summaries per folder always stay |

Fixed values, not shown in the Settings UI: 5 s keep-alive lead, 5% keep-alive jitter, 60-day
maximum age for learned cache lifetimes. They can still be overridden in `settings.json`
(`cacheKeeper.keepAliveLeadSeconds`, `keepAliveJitterPercent`, `lifetimeMaxAgeDays`), mainly for testing.

## Build from source

Requires Python 3 (no Node build step and no dependencies):

```bash
python3 build.py
```

This writes `copilot-cache-keeper-<version>.vsix` next to the sources. The version is never
hardcoded (`package.json` says `0.0.0-dev`). With `VERSION` set (`VERSION=v0.9.0 python3 build.py`,
as the release workflow does with its tag) it is that. Otherwise it is a dev build: next patch
after the latest tag, a build number, the short commit, e.g. `0.8.2-dev.14.9cfc211` after tag
`v0.8.1`. That sorts above the `0.8.1` release and below `0.8.2`, and each later build sorts
above the previous one, so it installs over it. (VS Code needs semver, so no 4-part
`0.8.1.14` version.) The build number is CI's run number, or locally the commits since the tag.


## Tests and releases

- **Smoke test** (`.github/workflows/ci.yml`, on pull requests and pushes to `main`): syntax
  check, `node test/smoke.js`, and a check of the built `.vsix`. The `.vsix` is uploaded as the
  run's `copilot-cache-keeper-vsix` artifact, versioned as a dev build (see *Build from
  source*), to try a pull request's build. `test/smoke.js` tests, for each of the four harnesses,
  the same features on a synthetic log in that harness's format (countdown, lifetime and its
  source, prices, credits, keep-alive cost, busy detection, language, summary sizing, measured
  lifetimes), and the extension itself with a stand-in for the VS Code API and VS Code's databases
  (`test/fixtures`): keep-alives, summaries, status bar, expiry notice, which window acts, your
  unsent text, diagnostics. Run it locally with `node test/smoke.js`, or only some checks with
  `ONLY="<part of a check name>" node test/smoke.js`.
- **Live test** (manual, costs credits, not on GitHub): `test/live/run.sh` runs this working tree
  in a real VS Code window, with one new chat per harness and a keep-alive sent by Cache Keeper
  itself. It then checks each chat's real log: the keep-alive landed, hit the cache, didn't carry
  the attachment, and the draft stayed. See [test/live/README.md](test/live/README.md).
- **Release** (`.github/workflows/release.yml`): GitHub → *Actions* → **Release** →
  **Run workflow**. It runs the smoke test first, then:
  - **Existing tag:** pick it in *Use workflow from*, and leave "tag" empty.
  - **New tag:** stay on a branch (e.g. `main`) and type the tag, e.g. `v0.7.6`. It's
    created on that branch's latest commit.
  - **Both empty:** it stops and asks for a tag.

  The `.vsix` is built with the tag's version and attached to a GitHub release with generated
  notes.
