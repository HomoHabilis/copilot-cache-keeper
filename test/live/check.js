// Checks a live test run (run.sh) against the chats' real logs, on the WSL side:
//   - Cache Keeper sent a keep-alive into the harness's chat (its output log),
//   - the keep-alive landed in that chat's own log,
//   - the call that answered it hit the cache (>= 90% of the prompt),
//   - the attachment typed but not sent did not go out with it,
//   - the unsent text was still in the chat's input box afterwards.
// node test/live/check.js <cache keeper log> <driver result> <runId> <harness...>
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const core = require("../../core");
const harnesses = require("../../harnesses");
const sqlite = require("../../sqlite");

const [logFile, resultFile, runId, ...wanted] = process.argv.slice(2);
const HOME = os.homedir(), SERVER = path.join(HOME, ".vscode-server", "data");
// the attached file's name, outside the test folder (so it is in no workspace listing): it must not
// appear in a keep-alive's request
const MARKER = "ck-live-attachment";
const ckLog = fs.readFileSync(logFile, "utf8"), result = fs.readFileSync(resultFile, "utf8");
const ls = d => { try { return fs.readdirSync(d); } catch { return []; } };
const firstMatch = (dir, prefix) => ls(dir).find(n => n.startsWith(prefix));

/** The chat's own log file, from the 8-character id Cache Keeper logs. */
function chatLog(h, id8) {
  if (h === "local") {
    const ws = path.join(SERVER, "User", "workspaceStorage");
    for (const w of ls(ws)) {
      const dl = path.join(ws, w, "GitHub.copilot-chat", "debug-logs"), n = firstMatch(dl, id8);
      if (n) return path.join(dl, n, "main.jsonl");
    }
    return null;
  }
  if (h === "sdk") {
    const root = path.join(HOME, ".copilot", "session-state"), n = firstMatch(root, id8);
    return n ? path.join(root, n, "events.jsonl") : null;
  }
  // Claude and Codex: id8 is VS Code's id; its session.db links to the harness's log
  const sd = path.join(SERVER, "agentSessionData"), n = firstMatch(sd, id8);
  if (!n) return null;
  const meta = Object.fromEntries((sqlite.readTable(fs.readFileSync(path.join(sd, n, "session.db")), null, "session_metadata") || [])
    .map(r => [r.key, r.value]));
  if (h === "claude") {
    const sdk = JSON.parse(meta.defaultChatProviderData || "{}").sdkSessionId, root = path.join(HOME, ".claude", "projects");
    for (const d of ls(root)) if (fs.existsSync(path.join(root, d, `${sdk}.jsonl`))) return path.join(root, d, `${sdk}.jsonl`);
    return null;
  }
  const thread = meta["codex.threadId"], root = path.join(HOME, ".codex", "sessions");
  for (const y of ls(root)) for (const m of ls(path.join(root, y))) for (const d of ls(path.join(root, y, m))) {
    const f = ls(path.join(root, y, m, d)).find(x => x.endsWith(`-${thread}.jsonl`));
    if (f) return path.join(root, y, m, d, f);
  }
  return null;
}
const translate = { local: harnesses.localTrace, sdk: t => harnesses.sdkTrace(t, {}), claude: harnesses.claudeTrace, codex: harnesses.codexTrace };

const rows = [];
let failed = 0;
for (const h of wanted) {
  const r = { harness: h, sent: false, landed: false, cache: "?", noAttachment: "?", draftKept: false };
  rows.push(r);
  // "keep-alive sent to <id8> ("ck-live <h> <runId>...", model, ...)"
  const m = new RegExp(`keep-alive sent to (\\S+) \\("ck-live ${h} ${runId}`).exec(ckLog);
  r.sent = !!m;
  r.draftKept = new RegExp(`input boxes ${h} after:.*CK-LIVE-DRAFT ${h} ${runId}`).test(result);
  const file = m && chatLog(h, m[1]);
  if (file) {
    const text = fs.readFileSync(file, "utf8");
    const t = translate[h](text);
    const ev = t ? t.events : [];
    const kaIdx = ev.map((e, i) => [e, i]).filter(([e]) => e.t === "user" && core.isKeepAlive(e.text)).map(([, i]) => i).pop();
    if (kaIdx !== undefined) {
      r.landed = true;
      const ka = ev[kaIdx], call = ev.slice(kaIdx).find(e => e.t === "call");
      if (call) r.cache = Math.round(100 * call.cached / call.input);
      // the log lines from the keep-alive message to the call that answered it
      const lines = text.split("\n");
      const from = lines.findIndex(l => l.includes(JSON.stringify(ka.text).slice(1, -1)));
      const to = lines.findIndex((l, i) => i > from && /llm_request|usage_record|token_usage_record|"usage"/.test(l));
      r.noAttachment = from >= 0 ? !lines.slice(from, to < 0 ? undefined : to + 1).some(l => l.includes(MARKER)) : "?";
    }
  }
  r.ok = r.sent && r.landed && r.cache !== "?" && r.cache >= 90 && r.noAttachment === true && r.draftKept;
  if (!r.ok) failed++;
}
const pad = (v, n) => String(v).padEnd(n);
console.log("\n" + ["harness", "keep-alive sent", "landed", "cache hit %", "attachment not sent", "draft kept", "result"].map((x, i) => pad(x, [9, 16, 7, 12, 20, 11, 6][i])).join(""));
for (const r of rows) {
  console.log([r.harness, r.sent, r.landed, r.cache, r.noAttachment, r.draftKept, r.ok ? "PASS" : "FAIL"]
    .map((x, i) => pad(x, [9, 16, 7, 12, 20, 11, 6][i])).join(""));
}
console.log(failed ? `\n${failed} harness(es) failed` : "\nall harnesses passed");
process.exit(failed ? 1 : 0);
