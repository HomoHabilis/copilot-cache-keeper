// Preview driver (test/live/preview.sh): runs Cache Keeper's previewNudges stage by stage in this
// window and writes each stage's name to a file, so the script can take a screenshot of it.
// No chat is opened and nothing is sent: no credits.
"use strict";
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RESULT = path.join(os.tmpdir(), "ck-preview-result.txt");
const HOLD_MS = Number(process.env.CK_PREVIEW_HOLD_MS) || 7000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = line => fs.appendFileSync(RESULT, line + "\n");
const run = (id, ...a) => Promise.resolve(vscode.commands.executeCommand(id, ...a)).catch(e => say(`NOTE ${id}: ${e.message}`));

async function main() {
  fs.writeFileSync(RESULT, "");
  for (let i = 0; i < 40 && !(await vscode.commands.getCommands(true)).includes("cacheKeeper.previewNudges"); i++) await sleep(500);
  if (!(await vscode.commands.getCommands(true)).includes("cacheKeeper.previewNudges")) { say("ERROR Cache Keeper's preview command is not there"); return; }
  await sleep(2000);
  for (const stage of ["split", "keepWarm", "waiting", "tip", "digest"]) {
    await run("notifications.clearAll");
    await run("cacheKeeper.previewNudges", stage);
    await sleep(1500);                       // the toast slides in
    say(`STAGE ${stage}`);
    await sleep(HOLD_MS);
  }
  await run("notifications.clearAll");
  // the status bar after a commit, then its tooltip: a status-bar entry shows its hover when focused
  await run("cacheKeeper.previewNudges", "commit");
  await sleep(1500);
  say("STAGE statusbar");
  await sleep(HOLD_MS);
  await run("workbench.statusBar.focusLast");
  for (let i = 0; i < 4; i++) {
    await sleep(1200);
    say(`STAGE tooltip-${i}`);
    await sleep(2500);
    await run("workbench.statusBar.focusPrevious");
  }
  await run("cacheKeeper.previewNudges", "off");
  say("DONE");
  if (!process.env.CK_PREVIEW_KEEP_OPEN) { await sleep(1500); await run("workbench.action.closeWindow"); }
}

function activate() { main().catch(e => say("ERROR " + (e.stack || e.message))); }
module.exports = { activate, deactivate() {} };
