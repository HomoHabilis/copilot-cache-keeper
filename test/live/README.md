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

## Visual check of the nudges (free)

```bash
test/live/preview.sh                 # screenshots in ./preview-shots (not committed)
```

Opens a real VS Code window with this working tree and shows every nudge, one after the other, on a
made-up costly chat: the split nudge, the Auto keep warm offer, the "agent may be waiting" warning,
the context-size tip, the digest, then the status bar after a commit and its tooltip. The made-up
chat goes through the real code (`cacheKeeper.previewNudges`, a command that is not in the Command
Palette), so the wording, the buttons and the wrapping are what a real chat would get. **No chat
is opened and nothing is sent: it costs no credits.** It takes a screenshot of that window at each
step and closes it after about a minute.

It also shows the status bar on its own: after a commit, with the usual expiry warning, and as
with `cacheKeeper.notifications` off (stages `quiet-warning`, `quiet-split`, `quiet-waiting`,
`quiet-expired`), where the bar does all the telling. For each it also photographs the tooltip:
the mouse is moved over Cache Keeper's entry for a second, then put back. To look at one yourself:

```bash
test/live/preview.sh --show quiet-split      # that stage only, on screen for 2 minutes: hover the status bar
```

Use it after changing a nudge's text: a notification with no button is cut to one line, long ones
wrap to four or five, and a button label that is too long is cut. Look at the screenshots.

While it runs, leave the keyboard and the mouse alone: to photograph the window it is brought to the front (with
a bare Alt key press, which Windows requires), and the tooltip only shows while that window has the
focus. Run a stage by hand from another extension or a keybinding with
`cacheKeeper.previewNudges` and one of `split`, `keepWarm`, `waiting`, `tip`, `digest`, `commit`,
`off`; a preview ends by itself after 2 minutes.

## Files

- `run.sh`: copies the working tree and the driver where Windows VS Code can load them, sets up the
  scratch folder (Cache Keeper's log mirrored to a file with the hidden `cacheKeeper.debugLogFile`
  setting, `minCredits` 0 so cheap chats count), writes the plan, opens the window, waits, checks.
- `plan.js`: the steps per harness.
- `preview.sh`, `preview-driver/`, `shot.ps1`: the visual check above (launcher, the extension that
  steps through the stages, the window screenshot).
- `driver/`: a tiny extension that runs the plan in the window (only loaded for that window, never
  installed). How each harness starts a chat: Local and Copilot SDK have a command; Claude and Codex
  chats start by opening an untitled chat of their scheme (`agent-host-claude:/untitled-<uuid>`).
- `check.js`: finds each chat's log (Local: Agent Debug Log; Copilot SDK: `~/.copilot/session-state`;
  Claude and Codex: through VS Code's `agentSessionData/<id>/session.db`) and reads it with the same
  translators as the extension (`harnesses.js`).
