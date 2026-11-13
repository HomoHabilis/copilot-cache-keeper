// Preview driver (test/live/preview.sh): runs Cache Keeper's previewNudges stage by stage in this
// window and writes each stage's name to a file, so the script can take a screenshot of it.
// No chat is opened and nothing is sent: no credits.
"use strict";
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RESULT = path.join(os.tmpdir(), "ck-preview-result.txt");
// preview.sh --show <stage>: only that stage, left on screen for you to look at and hover (no screenshots)
const SHOW = (() => { try { return fs.readFileSync(path.join(os.tmpdir(), "ck-preview-show.txt"), "utf8").trim(); } catch { return ""; } })();
const HOLD_MS = Number(process.env.CK_PREVIEW_HOLD_MS) || 7000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = line => fs.appendFileSync(RESULT, line + "\n");
const run = (id, ...a) => Promise.resolve(vscode.commands.executeCommand(id, ...a)).catch(e => say(`NOTE ${id}: ${e.message}`));

async function main() {
  fs.writeFileSync(RESULT, "");
  for (let i = 0; i < 40 && !(await vscode.commands.getCommands(true)).includes("cacheKeeper.previewNudges"); i++) await sleep(500);
  if (!(await vscode.commands.getCommands(true)).includes("cacheKeeper.previewNudges")) { say("ERROR Cache Keeper's preview command is not there"); return; }
  await sleep(2000);
  if (SHOW) {
    await run("cacheKeeper.previewNudges", SHOW);
    say(`SHOWING ${SHOW}`);
    say("DONE");
    return;                                  // the window stays open; the preview ends by itself after 2 minutes
  }
  for (const stage of ["split", "keepWarm", "waiting", "tip", "digest"]) {
    await run("notifications.clearAll");
    await run("cacheKeeper.previewNudges", stage);
    await sleep(1500);                       // the toast slides in
    say(`STAGE ${stage}`);
    await sleep(HOLD_MS);
  }
  // The status bar and its tooltip. A status-bar entry shows its hover when it has the keyboard focus:
  // Cache Keeper's is the one before the last (the notification bell). "quiet-...": as with
  // cacheKeeper.notifications off, where the bar does all the telling.
  for (const stage of ["commit", "warning", "quiet-warning", "quiet-split", "quiet-waiting", "quiet-expired"]) {
    await run("notifications.clearAll");
    await run("cacheKeeper.previewNudges", stage);
    await sleep(1800);
    say(`STAGE bar-${stage}`);
    await sleep(3500);
    await run("cacheKeeper.previewNudges", "hold");     // no redraw every second: the hover stays open
    await run("workbench.statusBar.focusLast");
    await sleep(1200);                       // (one step at a time: the hover follows the focus only then)
    await run("workbench.statusBar.focusPrevious");
    await sleep(1500);
    say(`STAGE tooltip-${stage}`);
    await sleep(3000);
    await run("workbench.action.focusActiveEditorGroup");
    await run("cacheKeeper.previewNudges", "release");
    await sleep(400);
  }
  await run("cacheKeeper.previewNudges", "off");
  say("DONE");
  if (!process.env.CK_PREVIEW_KEEP_OPEN) { await sleep(1500); await run("workbench.action.closeWindow"); }
}

function activate() { main().catch(e => say("ERROR " + (e.stack || e.message))); }
module.exports = { activate, deactivate() {} };
