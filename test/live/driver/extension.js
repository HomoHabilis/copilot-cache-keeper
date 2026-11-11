// Live test driver: runs the plan written by run.sh (ck-live-plan.json in the Windows temp folder)
// in a real VS Code window, next to the working-tree copy of Cache Keeper, and logs what it did to
// ck-live-result.txt. It sends real chat messages: every step costs Copilot credits. See README.md.
//
// Plan: { openFolder: "vscode-remote://...", close: true, steps: [ ... ] }, steps run in order:
//   { new: "<command>", text, reply, close }   start a chat with a command (e.g. newLocalChat), send text
//   { openUri: "<scheme>:/<id or untitled-...>", text, reply, close }  open a chat as a tab, send text
//   { send: "text", reply }                     send text into the focused chat (its next turn)
//   { toSidebar: true }                         move the active chat tab into the Chat view
//   { draft: "text", attach: [uri] }            type (not send) into the Chat view's input, attach files
//   { boxes: "label" }                          log every chat input box's text
//   { cmd: "<command>", args: [...] }           run a command (e.g. cacheKeeper.keepWarmNow)
//   { cmd: "<command>", pick: true }            run a command that asks "which chat?" and take the first one
//   { wait: seconds }
"use strict";
const vscode = require("vscode");
const fs = require("fs"), path = require("path"), os = require("os");

const OUT = path.join(os.tmpdir(), "ck-live-result.txt");
const PLAN = path.join(os.tmpdir(), "ck-live-plan.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lines = [];
function log(m) { lines.push(`${new Date().toISOString()} ${m}`); fs.writeFileSync(OUT, lines.join("\n") + "\n"); }
const tabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label + (t.isActive ? "*" : ""))).join(" | ");
const boxes = () => vscode.workspace.textDocuments.filter(d => d.uri.scheme === "chatSessionInput")
  .map(d => `${d.uri.toString()}=${JSON.stringify(d.getText())}`).join(" | ");

async function closeActiveTab() {
  const g = vscode.window.tabGroups.activeTabGroup;
  if (g.activeTab) await vscode.window.tabGroups.close(g.activeTab, true);
}

async function run() {
  if (!fs.existsSync(PLAN)) return;                  // loaded without a plan: do nothing
  const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));
  const f = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const ck = vscode.extensions.getExtension("local.copilot-cache-keeper");
  log(`start remote=${vscode.env.remoteName} folder=${f && f.uri.toString()} cacheKeeper=${ck ? ck.extensionPath + " v" + ck.packageJSON.version : "none"}`);
  // A window started with --extensionDevelopmentPath ignores folder arguments: open it from here
  // (the window reloads into it, this extension included, and runs the plan then).
  if (plan.openFolder && (!f || f.uri.toString() !== plan.openFolder)) {
    log("opening the test folder");
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.parse(plan.openFolder), { forceReuseWindow: true });
    return;
  }
  fs.unlinkSync(PLAN);                               // run once, even if the window reloads
  // A folder VS Code doesn't trust yet asks first, and agent requests wait for the answer: wait for it
  // here (run.sh tells you to click Trust), so no step runs while requests would be held back.
  if (!vscode.workspace.isTrusted) {
    log("WAITING-TRUST: click Trust in the VS Code window (once: the test folder is kept between runs)");
    const ok = await Promise.race([new Promise(r => vscode.workspace.onDidGrantWorkspaceTrust(() => r(true))), sleep(600000).then(() => false)]);
    if (!ok) { log("ERROR the test folder was not trusted within 10 min"); return; }
    log("folder trusted");
  }
  await sleep(12000);                                // let Copilot, the Agent Host and Cache Keeper start
  for (const st of plan.steps) {
    try {
      if (st.wait) { await sleep(st.wait * 1000); continue; }
      if (st.new || st.openUri) {
        if (st.new) log(`${st.new} -> ${await vscode.commands.executeCommand(st.new) || ""}`);
        else {
          await vscode.commands.executeCommand("workbench.action.chat.openSessionInEditorGroup", { resource: vscode.Uri.parse(st.openUri) });
          log(`opened ${st.openUri}`);
        }
        await sleep(4000);
        await vscode.commands.executeCommand("workbench.action.chat.submit", { inputValue: st.text });
        log(`sent "${st.text}" | tabs: ${tabs()}`);
        await sleep((st.reply || 25) * 1000);
        if (st.close) await closeActiveTab();
        continue;
      }
      if (st.send) {
        await vscode.commands.executeCommand("workbench.action.chat.submit", { inputValue: st.send });
        log(`sent "${st.send}" | tabs: ${tabs()}`);
        await sleep((st.reply || 25) * 1000);
        continue;
      }
      if (st.toSidebar) { await vscode.commands.executeCommand("workbench.action.chat.openInSidebar"); await sleep(2500); log(`moved into the Chat view | tabs: ${tabs()}`); continue; }
      if (st.draft !== undefined) {
        await vscode.commands.executeCommand("workbench.action.chat.open", { query: st.draft, isPartialQuery: true,
          attachFiles: (st.attach || []).map(u => vscode.Uri.parse(u)) });
        await sleep(1500);
        log(`draft typed: ${JSON.stringify(st.draft)}, ${(st.attach || []).length} attachment(s)`);
        continue;
      }
      if (st.boxes) { log(`input boxes ${st.boxes}: ${boxes()}`); continue; }
      if (st.cmd && st.pick) {
        // the command asks "which chat?" when there are several: take the first item, as a click would
        // (Cache Keeper lists the chat you last wrote in first). With one chat it asks nothing.
        const done = vscode.commands.executeCommand(st.cmd, ...(st.args || []));
        await sleep(2500);
        await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
        await done;
        log(`ran ${st.cmd}, first chat picked | tabs: ${tabs()}`);
        continue;
      }
      if (st.cmd) { await vscode.commands.executeCommand(st.cmd, ...(st.args || [])); log(`ran ${st.cmd} | tabs: ${tabs()}`); continue; }
    } catch (e) { log(`step ${JSON.stringify(st)} FAILED: ${e.message}`); }
  }
  log("DONE");
  await sleep(2000);
  if (plan.close !== false) await vscode.commands.executeCommand("workbench.action.closeWindow");
}

function activate() { run().catch(e => log("ERROR " + (e.stack || e))); }
module.exports = { activate };
