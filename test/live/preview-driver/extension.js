// Preview driver (test/live/preview.sh): runs Cache Keeper's previewNudges stage by stage in this
// window and writes each stage's name to a file, so the script can take a screenshot of it.
// No chat is opened and nothing is sent: no credits.
"use strict";
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

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
  if (SHOW === "documentation") {
    const extension = vscode.extensions.getExtension("local.copilot-cache-keeper");
    const file = vscode.Uri.joinPath(extension.extensionUri, "README-offline.md");
    const markdown = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
    const html = await vscode.commands.executeCommand("markdown.api.render", markdown);
    const expected = Array.from(markdown.matchAll(/!\[[^\]]*\]\((data:image\/png;base64,[^)]+)\)/g)).length;
    const images = Array.from(html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g), match => match[1]);
    if (!expected || images.length !== expected || images.some(image => !image.startsWith("data:image/png;base64,"))) {
      throw new Error(`Markdown renderer preserved ${images.length} of ${expected} embedded images`);
    }
    fs.writeFileSync(path.join(__dirname, "..", "shots", "documentation.html"), html);
    say(`NOTE Markdown renderer preserved all ${images.length} embedded images`);
    await vscode.commands.executeCommand("cacheKeeper.documentation");
    await sleep(5000);
    const title = vscode.workspace.getConfiguration("window").get("title", "Extension Development Host");
    const capture = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(__dirname, "..", "shot.ps1"), "-Title", title.includes("${") ? "Extension Development Host" : title,
      "-Front", "-Escape", "-Out", path.join(__dirname, "..", "shots", "documentation-window.png")], { encoding: "utf8" });
    say(`NOTE screenshot: ${capture.trim()}`);
    say("STAGE documentation-1");
    await sleep(HOLD_MS);
    say("DONE");
    await sleep(1500); await run("workbench.action.closeWindow");
    return;
  }
  if (SHOW === "readme") {
    // the extension's own page, as VS Code shows the README (do its pictures load?), top and further down
    const x = vscode.extensions.getExtension("local.copilot-cache-keeper-readme");
    say(`NOTE readme extension ${x ? "loaded from " + x.extensionPath : "NOT loaded"}; all local.*: ${vscode.extensions.all.filter(e => e.id.startsWith("local.")).map(e => e.id).join(", ")}`);
    await run("extension.open", "local.copilot-cache-keeper-readme");
    await sleep(5000);
    say("STAGE readme-1");
    for (let i = 2; i <= 6; i++) { await sleep(3500); say(`STAGE readme-${i}`); }
    await sleep(3000);
    say("DONE");
    await sleep(1500); await run("workbench.action.closeWindow");
    return;
  }
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
  // The status bar and its tooltip (the script moves the mouse over the entry for that picture).
  // "quiet-...": as with cacheKeeper.notifications off, where the bar does all the telling.
  for (const stage of ["commit", "warning", "quiet-warning", "quiet-split", "quiet-waiting", "quiet-expired"]) {
    await run("notifications.clearAll");
    await run("cacheKeeper.previewNudges", stage);
    await sleep(1800);
    say(`STAGE bar-${stage}`);
    await sleep(3500);
    await run("cacheKeeper.previewNudges", "hold");     // no redraw every second: the tooltip stays open
    say(`STAGE tooltip-${stage}`);            // the script puts the mouse over the entry and takes the picture
    await sleep(4500);
    await run("cacheKeeper.previewNudges", "release");
    await sleep(400);
  }
  await run("cacheKeeper.previewNudges", "off");
  say("DONE");
  if (!process.env.CK_PREVIEW_KEEP_OPEN) { await sleep(1500); await run("workbench.action.closeWindow"); }
}

function activate() { main().catch(async e => {
  say("ERROR " + (e.stack || e.message));
  if (SHOW === "documentation" || SHOW === "readme") await run("workbench.action.closeWindow");
}); }
module.exports = { activate, deactivate() {} };
