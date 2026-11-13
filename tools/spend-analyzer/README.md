# Copilot spend analyzer

A helper next to Copilot Cache Keeper, not part of the extension (it isn't packaged by `build.py`).
It looks back over weeks of logs where the extension looks at the chats open now.

Finds the AI coding-agent logs on a machine and shows **what drives your Copilot spend**, ranked
by credits you could have avoided: expired caches after pauses, large contexts, the long-context
price tier, max reasoning effort, MCP tool definitions, compactions, subagents.

One Python file, standard library only.

```bash
python3 analyze_spend.py
```

```bash
python3 analyze_spend.py --days 90 --out my-report.md
```

It prints the ranked factors and writes a Markdown report (`spend-report-<date>.md`).

## What it reads

It finds these by itself, wherever they are on the machine:

| Source | Where | Detail |
|---|---|---|
| VS Code Copilot Agent Debug Logs | `…/workspaceStorage/<id>/GitHub.copilot-chat/debug-logs/` (VS Code server in WSL/SSH/containers, local VS Code on Windows/macOS/Linux, Windows from WSL) | every model call: context, cached tokens, output, effort, **exact credits** |
| VS Code chat session files | `…/workspaceStorage/<id>/chatSessions/*.jsonl`, and `…/globalStorage/emptyWindowChatSessions/` for windows with no folder open | every message: credits, context-size setting, effort, share of the prompt taken by tool definitions. Used for older chats that no longer have debug logs |
| Copilot CLI, and VS Code "Copilot" harness chats (Copilot SDK, shown separately) | `~/.copilot/session-state/*/events.jsonl` | every call: prompt, cache read/write, reasoning tokens, cache expiry time; credits as billed per call; what the session's billed total has beyond its calls (a compaction, or a session that logs only its total) counts as one more line; older logs without per-call credits are scaled to the session total |
| VS Code Claude harness chats | listed in VS Code's `agent-host.db`; log in `~/.claude/projects/*/<id>.jsonl` | every call: prompt, cache read/write; scaled to the credits Copilot billed for the chat (`agentSessionData/<id>/session.db`). Only chats VS Code created: your own Claude Code sessions, billed by Anthropic, are left out |
| VS Code Codex harness chats | listed in VS Code's `agent-host.db`; log in `~/.codex/sessions/Y/M/D/rollout-*.jsonl` | every call: prompt, cached tokens, reasoning; credits from Copilot's prices |
| OpenCode | `~/.local/share/opencode/opencode.db` | every call: tokens and cost |

Logs from another machine (for example extracted from `collect_agent_logs.sh --raw`) can be added
with `--input <folder>`.

## What the report contains

1. **Spending factors**, ranked by estimated avoidable credits, each with what to do about it.
2. **What Cache Keeper and shorter chats would have saved:** your 30 costliest chats priced again
   call by call: what expired caches cost (after pauses, and while the agent waited), and what
   keeping warm, splitting into at most 3 chats with a handoff summary, both, or a 200k context
   window would have saved. Then **what Cache Keeper did so far:** its keep-alives, their cost and
   the expiries they avoided.
3. **By tool and model:** calls, credits, median context, cached share.
4. **Cache misses:** the most expensive ones, with the pause before them and the cause
   (expired after a pause, expired while the agent waited, or compaction/changed prompt).
5. **Reasoning effort:** per model and effort level, output tokens and the extra cost of
   xhigh/max over the lowest level you used.
6. **Context size:** credits by context size, the VS Code context-size setting you used, and
   cost per 100k context after a pause vs within the cache lifetime.
7. **Most expensive sessions,** with their models, effort, maximum context, compactions and misses.
8. **Method:** how each figure is computed.

## How the estimates work

- **Prices** come from the newest price sheet Copilot sent to VS Code (`models.json` in the debug
  logs), including context-size tiers. VS Code debug logs give exact credits, Copilot CLI/SDK give
  credits per call plus whatever their session total adds (else scaled to that total), and OpenCode uses its own cost (in dollars × 100).
  If a model has no matching price sheet and its credits cannot be computed, the report warns and
  excludes those calls from spending totals. Their cache misses remain visible with unknown costs.
  This can happen on a remote VM with only Copilot SDK logs. Use `--input <folder>` with VS Code
  logs from another machine containing `workspaceStorage/.../GitHub.copilot-chat/debug-logs/.../models.json`.
- **Cache lifetimes, from data only:** what a call's log says (Claude's cache tier), Copilot
  CLI/SDK logs, and the longest gap after which a Local chat still hit the cache, once it is more than
  a minute longer than 5 min (a shorter one only proves a minimum). Otherwise the known
  values (Claude 300 s, Sol 6.1 1800 s). A model with no data gets no lifetime, and no expiry is
  judged for it (its misses show as "unknown cache lifetime").
- **Expired caches in older chats** (one record per message) are read from the bill, not guessed
  from the pause. The message's calls (its tool-call rounds, timed in the chat file) are priced
  warm from the price sheet; when the message was billed about one full re-send more than that,
  one call was cold: the one after the longest wait. Before the message, it is a pause; between
  two of its calls, the agent waited (a tool approval, a long command), which keeping warm cannot
  prevent. Pauses run from the start of the previous message's last call, as the cache lifetime
  does. A chat file without rounds falls back to the pause, capped by what the message cost.
- **What-ifs** price each chat's series of calls by the price sheet and scale the result to its
  bill; a chat the model misses by too much is left out and counted. Kept warm follows Cache
  Keeper's rules (one keep-alive per cache lifetime, each a read of the whole context; pauses up to
  2 h; keep-alives at most 50% of the expiry). A split pays a summary, the new chat's first
  prompt, 25k tokens of files read again and 4 extra calls. What a summary or compaction loses is
  not priced. The constants are at the top of the "series of calls" section of the script.
- **Cache Keeper's own messages** (keep-alives, summary requests, `/compact`) are recognised by
  the extension's lists, copied in the script (`KEEPALIVES`, `OWN_PREFIXES`); a test compares
  them with `core.js`.
- **Factors overlap**, for example an expired cache on a large context, so they aren't meant to
  be added up.
- **Duplicates:** VS Code keeps copies of a chat's file under several workspace folders, for
  example when a folder becomes a multi-folder workspace. Copies are merged by chat ID, so each
  message counts once (from the most complete copy). Debug-log calls are de-duplicated too.
- **Workspace names:** multi-folder workspaces are named after their folders
  (`app + lib + tools`). Untitled workspaces whose file VS Code deleted on close show as
  `untitled workspace (closed, <date>)`.
- **Older chats** only have per-message records, so some figures for them are estimated from your
  own debug-log data, and capped so no estimate exceeds what a message actually cost.

**Run from WSL or from Windows, same result.** From WSL it also reads the Windows side
(`/mnt/c/Users/...`); from Windows it also reads the home folders of the running WSL distros
(`\\wsl.localhost\<distro>\home\...`, where a WSL window's logs are). Distros that aren't running
are not started; it lists them so you can start them and run it again.

Reading Windows-side files from WSL is slow: expect about a minute on a machine with a few hundred
chats.
