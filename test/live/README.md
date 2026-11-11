# Live test (manual, costs credits)

`test/smoke.js` runs headless with a stand-in for VS Code, on every push (CI). This live test is
the other half: the working tree of Cache Keeper in a **real** VS Code window, real chats, real
Copilot calls. It doesn't run on GitHub: it needs your VS Code, your Copilot sign-in, and it spends
credits. Run it before a release, or after a VS Code or harness update.

## What it does

For each harness (Local, Copilot SDK, Claude, Codex), in a WSL window on a scratch folder:

1. Starts a new chat and sends two short messages ("reply with only OK"). Two, because right after
   a chat's first message Claude and Codex rebuild part of their prompt, and a keep-alive sent as
   the second turn would not show the normal cache hit.
2. Types a draft in the chat's input box and attaches a file, without sending.
3. Runs *Cache Keeper: Keep warm now*, so Cache Keeper itself opens the chat and sends a keep-alive.
4. Checks, in the chat's own log on disk:
   - the keep-alive landed in that chat;
   - the call answering it hit the cache (at least 90% of the prompt);
   - the attached file did not go out with it;
   - the draft is still in the input box.

It ends with a table, one row per harness, and exits non-zero if any harness fails:

```
harness  keep-alive sent landed cache hit % attachment not sent draft kept result
local    true            true   98          true                true       PASS
...
```

## Run

From WSL, in the repository:

```bash
test/live/run.sh                 # all four harnesses
test/live/run.sh claude codex    # only some
test/live/run.sh --yes --keep    # no cost prompt; keep the scratch folder and logs
test/live/run.sh --compact local # also compact each chat with Cache Keeper's /compact
```

**`--compact`:** after the keep-alive, Cache Keeper compacts each chat (*Compact chat now*, enabled
for all four harnesses in the test folder). The table gets two more columns: **compacted** (the
`/compact` was sent and a compaction shows in the chat's own log after it) and **compact hit %**
(Local: the cache hit of VS Code's summarizing call, at least 90% to pass; other harnesses' logs
don't record it, shown `?`). A harness that passes can be added to Cache Keeper's default
`compactHarnesses`. The chats are tiny, so if a harness refuses to compact a two-message chat it
shows as not compacted: try again on a longer chat before concluding.

A VS Code window opens and closes itself when done (a few minutes per harness). Don't type in it.
**The first time,** VS Code asks whether you trust the test folder `~/ck-live-ws`: click **Trust**
(the script tells you when). Until then VS Code holds agent requests back, so the test waits for it.
The folder is kept between runs so you are asked only once. The test chats ("ck-live ...") stay in
VS Code's Sessions list; archive them when you like.

**Prerequisites:** Windows VS Code with Copilot signed in, a WSL distro, `node` in WSL, and the
Claude and Codex harnesses enabled if you test them (their SDKs download on first use).

**Cost:** a new chat's first message sends its whole system prompt (20-40k tokens) uncached: about
0.5 credit on Haiku, 5-8 on Sol, 15-20 on Opus, with whatever model each harness is set to. The
other messages are cached and cost little. Picking a cheap model in each harness first keeps a full
run around 2-3 credits.

## Files

- `run.sh`: copies the working tree and the driver where Windows VS Code can load them, sets up the
  scratch folder (Cache Keeper's log mirrored to a file with the hidden `cacheKeeper.debugLogFile`
  setting, `minCredits` 0 so cheap chats count), writes the plan, opens the window, waits, checks.
- `plan.js`: the steps per harness.
- `driver/`: a tiny extension that runs the plan in the window (only loaded for that window, never
  installed). How each harness starts a chat: Local and Copilot SDK have a command; Claude and Codex
  chats start by opening an untitled chat of their scheme (`agent-host-claude:/untitled-<uuid>`).
- `check.js`: finds each chat's log (Local: Agent Debug Log; Copilot SDK: `~/.copilot/session-state`;
  Claude and Codex: through VS Code's `agentSessionData/<id>/session.db`) and reads it with the same
  translators as the extension (`harnesses.js`).
