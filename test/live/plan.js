// Writes the live test plan (see driver/extension.js) for the given harnesses to stdout.
// node test/live/plan.js <openFolder uri> <attach uri> <runId> [local] [sdk] [claude] [codex]
"use strict";
const crypto = require("crypto");
const [folder, attach, runId, ...wanted] = process.argv.slice(2);
const harnesses = wanted.length ? wanted : ["local", "sdk", "claude", "codex"];
// How each harness starts a chat: Local and Copilot SDK have a command; Claude and Codex chats are
// started by opening an untitled chat of their scheme, as VS Code itself does.
const start = {
  local: { new: "workbench.action.chat.newLocalChat" },
  sdk: { new: "workbench.action.chat.openNewSessionEditor.agent-host-copilotcli" },
  claude: { openUri: `agent-host-claude:/untitled-${crypto.randomUUID()}` },
  codex: { openUri: `agent-host-codex:/untitled-${crypto.randomUUID()}` },
};
const steps = [];
for (const h of harnesses) {
  if (!start[h]) throw new Error(`unknown harness ${h} (local, sdk, claude, codex)`);
  const reply = h === "codex" ? 40 : 30;
  // Two real turns first: right after a chat's first message, Claude and Codex rebuild part of their
  // prompt, so a keep-alive sent as the second turn would not show the normal cache hit.
  steps.push({ ...start[h], text: `ck-live ${h} ${runId}: reply with only OK, no tools.`, reply },
             { send: `ck-live ${h} ${runId} turn 2: reply with only OK, no tools.`, reply });
  if (h !== "local") steps.push({ toSidebar: true });           // Local chats start in the Chat view
  // Something typed and attached but not sent: must stay in the box, and not go out with the keep-alive.
  steps.push({ draft: `CK-LIVE-DRAFT ${h} ${runId}`, attach: [attach] }, { boxes: `${h} before` },
             { wait: 8 }, { cmd: "cacheKeeper.keepWarmNow" }, { wait: reply + 5 }, { boxes: `${h} after` });
}
steps.push({ cmd: "cacheKeeper.diagnose" }, { wait: 5 });
process.stdout.write(JSON.stringify({ openFolder: folder, close: true, runId, harnesses, steps }, null, 1));
