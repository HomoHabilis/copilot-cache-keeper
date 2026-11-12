// Smoke test: core logic on a synthetic Copilot debug log, then the extension loaded with a
// minimal stand-in for the VS Code API, deciding to send a keep-alive before the cache expires.
// Run: node test/smoke.js   (no dependencies; ONLY=<part of a check name> runs just those)
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const core = require("../core");

let failures = 0;
function check(name, fn) {
  // ONLY=<text> runs just the checks whose name contains it
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return Promise.resolve();
  return Promise.resolve().then(fn).then(
    () => console.log(`ok   ${name}`),
    e => { failures++; console.log(`FAIL ${name}\n     ${e && e.stack || e}`); });
}

// ---------------------------------------------------------------- fixtures

const MODELS = JSON.stringify([{
  id: "claude-opus-5.5", capabilities: { family: "claude-opus-5.5" },
  billing: { token_prices: { batch_size: 1000000,
    default: { input_price: 400, cache_write_price: 500, cache_read_price: 20, output_price: 2000, max_prompt_tokens: 200000 },
    long_context: { input_price: 400, cache_write_price: 500, cache_read_price: 20, output_price: 2000, max_prompt_tokens: 1000000 } } },
}, {
  id: "gpt-6.1-sol", capabilities: { family: "gpt-6.1-sol" },
  billing: { token_prices: { batch_size: 1000000,
    default: { input_price: 200, cache_write_price: 250, cache_read_price: 10, output_price: 1000, max_prompt_tokens: 272000 },
    long_context: { input_price: 400, cache_write_price: 500, cache_read_price: 20, output_price: 1500, max_prompt_tokens: 922000 } } },
}]);

function chatLog(t0, { model = "claude-opus-5.5", ctx = 150000, first = ctx - 20000, keepAlive = false, writePrice = 500, coldKeepAlive = false } = {}) {
  const ev = [
    { type: "user_message", ts: t0, attrs: { content: "Refactor the parser" } },
    { type: "turn_start", ts: t0 + 10 },
    { type: "llm_request", ts: t0 + 50, dur: 3000, attrs: { debugName: "panel/editAgent", model, inputTokens: first,
      // billed: uncached at writePrice per 1M, output at 2000 per 1M (as Copilot's log reports it)
      cachedTokens: 0, outputTokens: 800, copilotUsageNanoAiu: (first * writePrice + 800 * 2000) * 1e3 } },
    { type: "llm_request", ts: t0 + 4000, dur: 2000, attrs: { debugName: "panel/editAgent", model, inputTokens: ctx,
      cachedTokens: ctx - 1000, outputTokens: 300, copilotUsageNanoAiu: 5e9 } },
    { type: "turn_end", ts: t0 + 6500 },
  ];
  if (coldKeepAlive) {            // a keep-alive sent after the cache expired: everything re-sent
    ev.push({ type: "user_message", ts: t0 + 8000, attrs: { content: "[cache-keeper] Keep-alive while I'm away." } },
            { type: "llm_request", ts: t0 + 8050, dur: 800, attrs: { debugName: "panel/editAgent", model,
              inputTokens: ctx + 600, cachedTokens: 0, outputTokens: 4, copilotUsageNanoAiu: ((ctx + 600) * writePrice + 4 * 2000) * 1e3 } },
            { type: "turn_end", ts: t0 + 8900 });
  }
  if (keepAlive) {
    ev.push({ type: "user_message", ts: t0 + 9000, attrs: { content: "[cache-keeper] Keep-alive while I'm away." } },
            { type: "turn_start", ts: t0 + 9010 },
            { type: "llm_request", ts: t0 + 9050, dur: 800, attrs: { debugName: "panel/editAgent", model,
              inputTokens: ctx + 900, cachedTokens: ctx, outputTokens: 4, copilotUsageNanoAiu: 3.5e9 } },
            { type: "turn_end", ts: t0 + 10000 });
  }
  return ev.map(e => JSON.stringify(e)).join("\n") + "\n";
}

// Copilot SDK chat log (~/.copilot/session-state/<id>/events.jsonl), same prices as Opus above.
const SDK_PRICES = { input: 400, cache_read: 20, cache_write: 500, output: 2000 };   // credits per 1M tokens
const iso = t => new Date(t).toISOString();
function sdkUsage(start, dur, { model = "claude-opus-5.5", input, read, write = input - read, out = 300, ttl = 300, auto }) {
  const counts = { input: input - read - write, cache_read: read, cache_write: write, output: out };
  return { type: "session.usage_record", timestamp: iso(start + dur), data: { usage: {
    model, isAuto: auto, inputTokens: input, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: out, duration: dur,
    cacheExpiresAt: iso(start + ttl * 1000), cacheTtlSeconds: ttl,
    copilotUsage: { totalNanoAiu: Object.entries(counts).reduce((a, [k, n]) => a + n * SDK_PRICES[k] * 1e3, 0),
      tokenDetails: Object.entries(counts).map(([k, n]) => ({ batchSize: 1e6, costPerBatch: SDK_PRICES[k] * 1e9, tokenCount: n, tokenType: k })) } } } };
}
const ev = (type, t, data = {}) => ({ type, timestamp: iso(t), data });
function sdkTurn(t, text, { input, read, out = 300, dur = 2000, model } = {}) {
  return [ev("user.message", t, { content: text }), ev("assistant.turn_start", t + 5, { turnId: "0" }),
          sdkUsage(t + 10, dur, { input, read, out, model }), ev("assistant.turn_end", t + dur + 50, { turnId: "0" }),
          ev("session.usage_checkpoint", t + dur + 60)];
}
function sdkChatLog(t0, { ctx = 150000, first = ctx - 20000, model, auto } = {}) {
  return [ev("session.start", t0 - 100),
          ev("user.message", t0, { content: "Refactor the parser" }), ev("assistant.turn_start", t0 + 10, { turnId: "0" }),
          sdkUsage(t0 + 50, 3000, { input: first, read: 0, out: 800, model, auto }), ev("assistant.turn_end", t0 + 3900, { turnId: "0" }),
          ev("assistant.turn_start", t0 + 3950, { turnId: "1" }),
          sdkUsage(t0 + 4000, 2000, { input: ctx, read: ctx - 1000, out: 300, model, auto }),
          ev("assistant.message", t0 + 6000, { content: "Done: the parser is split in three files." }),
          ev("assistant.turn_end", t0 + 6500, { turnId: "1" }), ev("session.usage_checkpoint", t0 + 6510),
         ].map(e => JSON.stringify(e)).join("\n") + "\n";
}

// Claude harness transcript (~/.claude/projects/<folder>/<sdkSessionId>.jsonl), Anthropic model names.
const cl = (type, t, extra = {}) => ({ type, timestamp: iso(t), ...extra });
function claudeCall(t, end, { input, read, out = 300, stop = "end_turn", model = "claude-opus-5-5", ttl = "5m", id }) {
  const written = input - read - 2;
  return [cl("api-request", t, { id }),
          cl("assistant", end, { requestRef: id, message: { id: "msg_" + id, model, stop_reason: stop,
            content: [{ type: "text", text: "Done: the parser is split in three files." }],
            usage: { input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: written, output_tokens: out,
                     cache_creation: { ephemeral_5m_input_tokens: ttl === "5m" ? written : 0, ephemeral_1h_input_tokens: ttl === "1h" ? written : 0 } } } })];
}
function claudeTurn(t, text, { input, read, out = 300, cwd = "/w" } = {}) {
  return [cl("queue-operation", t - 5, { operation: "enqueue" }),
          cl("user", t, { cwd, message: { role: "user", content: [{ type: "text", text }] } }),
          ...claudeCall(t + 10, t + 510, { input, read, out, id: "r" + t })];
}
function claudeChatLog(t0, { ctx = 150000, first = ctx - 20000, cwd = "/w" } = {}) {
  return [cl("user", t0, { cwd, message: { role: "user", content: [{ type: "text", text: "Refactor the parser" }] } }),
          ...claudeCall(t0 + 50, t0 + 3000, { input: first, read: 0, out: 800, stop: "tool_use", id: "r1" }),
          cl("user", t0 + 3900, { message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
          ...claudeCall(t0 + 4000, t0 + 6000, { input: ctx, read: ctx - 1000, id: "r2" }),
         ].map(e => JSON.stringify(e)).join("\n") + "\n";
}
// Codex harness rollout (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl).
const cx = (type, t, payload = {}) => ({ type, timestamp: iso(t), payload });
const cxUser = (t, text) => cx("response_item", t, { type: "message", role: "user", content: [{ type: "input_text", text }] });
const cxUsage = (t, input, read, out) => cx("token_usage_record", t, { usage: { input_tokens: input, cached_input_tokens: read,
  cache_write_input_tokens: input - read, output_tokens: out } });
function codexTurn(t, text, { input, read, out = 300 } = {}) {
  return [cx("event_msg", t, { type: "task_started" }), cxUser(t + 5, "<environment_context>\n  <cwd>/w</cwd>\n</environment_context>"),
          cxUser(t + 10, text), cxUsage(t + 510, input, read, out),
          cx("response_item", t + 520, { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }),
          cx("event_msg", t + 600, { type: "task_complete" })];
}
function codexChatLog(t0, { ctx = 150000, first = ctx - 20000, cwd = "/w" } = {}) {
  return [cx("session_meta", t0 - 100, { id: "thread-1", cwd, originator: "vscode_agent_host", model_provider: "vscode-proxy" }),
          cx("turn_context", t0 - 50, { model: "gpt-6.1-sol", cwd }),
          cx("event_msg", t0, { type: "task_started" }), cxUser(t0 + 10, "Refactor the parser"), cxUsage(t0 + 3000, first, 0, 800),
          cx("response_item", t0 + 3500, { type: "function_call", name: "shell", arguments: "{}" }),
          cx("response_item", t0 + 4000, { type: "function_call_output", output: "ok" }), cxUsage(t0 + 6000, ctx, ctx - 1000, 300),
          cx("event_msg", t0 + 6500, { type: "task_complete" }),
         ].map(e => JSON.stringify(e)).join("\n") + "\n";
}

// ---------------------------------------------------------------- extension with a stand-in VS Code

/**
 * Load a fresh copy of the extension against a fake VS Code and one chat whose last call started
 * 3 s ago. `answer(msg, buttons, n)` is the user's reaction to the n-th warning: a button label,
 * undefined (closed with X) or a promise that never settles (not answered). Messages Cache Keeper
 * submits land in the chat's log with a short reply, so each one starts a new cache window.
 */
async function harness({ answer, settings: extra = {}, ctx = 40000, first, busyOnOpen = false, menu = () => undefined, folders = 1,
                         kind = "local", sdkCwd, sdkId = "sdk-0007", draft = "", noPrices = false, ignorePreserve = false,
                         writesHandoff = true, commandList = [], compactUnlogged = false, sdkAuto, handoffs = [], noFolder = false }) {
  const now = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-smoke-"));
  // a window with no folder open: VS Code gives no workspace storage; workspaceStorage sits next to globalStorage
  const storage = noFolder ? path.join(tmp, "data", "User", "workspaceStorage", "ws1") : path.join(tmp, "workspaceStorage", "ws1");
  const logs = path.join(storage, "GitHub.copilot-chat", "debug-logs");
  // Copilot SDK chats live under ~/.copilot: point the home folder at the temp dir
  const realHome = process.env.HOME;
  // lifetimes learned by an earlier harness (module state in core) must not leak into this one
  await core.learnTtls([], undefined, 30, 30, Date.now() + 1000 * 86400000);
  process.env.HOME = path.join(tmp, "home");
  const sdkRoot = path.join(tmp, "home", ".copilot", "session-state");
  const globalStorage = path.join(tmp, "data", "User", "globalStorage");
  fs.mkdirSync(globalStorage, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "fixtures", "agent-host.db"), path.join(globalStorage, "agent-host.db"));
  fs.cpSync(path.join(__dirname, "fixtures", "agentSessionData"), path.join(tmp, "data", "agentSessionData"), { recursive: true });
  const day = new Date(now), pad = n => String(n).padStart(2, "0");
  const chat = { sdk: path.join(sdkRoot, sdkId), local: path.join(logs, "sess-1"),
    claude: path.join(tmp, "home", ".claude", "projects", "-w", ),
    codex: path.join(tmp, "home", ".codex", "sessions", String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate())) }[kind];
  const logName = { sdk: "events.jsonl", local: "main.jsonl", claude: "claude-sdk-1.jsonl", codex: "rollout-2026-11-03T13-19-13-thread-1.jsonl" }[kind];
  const cwd = sdkCwd || tmp;
  let clock = now;
  const opened = [];
  const sent = [], warnings = [], commands = {}, ran = [], lists = [], infos = [], submits = [], closed = [], listed = [];
  let status;
  const fakeFs = {
    stat: async u => { const st = fs.statSync(u.fsPath); return { mtime: st.mtimeMs, size: st.size }; },
    readFile: async u => fs.readFileSync(u.fsPath),
    writeFile: async (u, b) => fs.writeFileSync(u.fsPath, b),
    createDirectory: async u => fs.mkdirSync(u.fsPath, { recursive: true }),
    readDirectory: async u => { listed.push(u.fsPath); return fs.readdirSync(u.fsPath).map(n => [n, 1]); },
    delete: async u => fs.rmSync(u.fsPath),
  };
  const settings = { warnSeconds: 60, thresholdTokens: 100000, autoSummary: true, minCredits: 5, ttlSeconds: {},
                     keepAliveLeadSeconds: 5, keepAliveJitterPercent: 0, afterSend: "closeTab",
                     autoKeepWarmCapPercent: 50, ...extra };
  const tab = { label: "chat", input: {} };
  // Chat input boxes, as VS Code exposes them to extensions: the chat's own (with what you typed and
  // not sent), and another chat's in the Chat view. A submit empties the focused one.
  const changeListeners = [];
  const inputDoc = (name, text) => { const d = { uri: { scheme: "chatSessionInput", toString: () => `chatSessionInput:${name}` },
    text, isClosed: false, getText() { return this.text; }, get lineCount() { return this.text.split("\n").length; } }; return d; };
  const chatInput = inputDoc("input-0", draft), otherInput = inputDoc("input-1", "other chat's draft");
  const setText = (d, t) => { d.text = t; changeListeners.forEach(f => f({ document: d })); };
  const append = evs => fs.appendFileSync(path.join(chat, logName), evs.map(e => JSON.stringify(e)).join("\n") + "\n");
  let lastCtx = ctx;
  const vscode = {
    env: { remoteName: undefined },
    workspace: { getConfiguration: () => ({ get: k => settings[k] }), fs: fakeFs,
                 openTextDocument: async o => { opened.push(o.content); return { uri: { scheme: "untitled" } }; },
                 textDocuments: [chatInput, otherInput],
                 onDidChangeTextDocument: f => { changeListeners.push(f); return { dispose() { changeListeners.splice(changeListeners.indexOf(f), 1); } }; },
                 applyEdit: async e => { for (const [u, t] of e.edits) setText([chatInput, otherInput].find(d => d.uri.toString() === u.toString()), t); return true; },
                 // more folders = a multi-root workspace: tmp, tmp/repo2, ...
                 workspaceFolders: noFolder ? undefined : Array.from({ length: folders }, (_, i) => {
                   const f = i ? path.join(tmp, `repo${i + 1}`) : tmp;
                   return { uri: { scheme: "file", fsPath: f, path: f, with(o) { return { ...this, ...o, fsPath: o.path || this.fsPath }; } } };
                 }) },
    window: {
      createStatusBarItem: () => (status = { show() {}, hide() {}, text: "" }),
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      showWarningMessage: async (msg, ...buttons) => { warnings.push({ at: clock, msg }); return answer(msg, buttons, warnings.length); },
      showInformationMessage: async m => { infos.push(m); return undefined; },
      showErrorMessage: async m => { throw new Error("unexpected error message: " + m); },
      showQuickPick: async items => menu(items),
      showTextDocument: async () => undefined,
      showInputBox: async o => o.value,
      withProgress: async (o, f) => f({ report() {} }),
      // the status-bar list: picks the first chat
      createQuickPick: () => { const qp = { items: [], activeItems: [], selectedItems: [], dispose() {},
        onDidAccept: f => { qp.accept = f; }, onDidHide() {},
        show() { lists.push(qp.items); qp.selectedItems = [qp.items[0]]; setImmediate(() => qp.accept()); } }; return qp; },
      tabGroups: { all: [{ tabs: [] }], get activeTabGroup() { return this.all[0]; }, close: async t => { closed.push(t); } },
    },
    commands: {
      registerCommand: (id, f) => { commands[id] = f; return { dispose() {} }; },
      getCommands: async () => commandList,
      executeCommand: async (id, a) => {
        ran.push({ id, a });
        if (id === "workbench.action.chat.openSessionInEditorGroup") {
          vscode.window.tabGroups.all[0].tabs = [tab]; vscode.window.tabGroups.all[0].activeTab = tab;
          // the agent starts working (e.g. a subagent) while the tab is being opened
          if (busyOnOpen) append([{ sdk: ev("assistant.turn_start", clock), claude: cl("queue-operation", clock, { operation: "enqueue" }),
            codex: cx("event_msg", clock, { type: "task_started" }) }[kind] || { type: "turn_start", ts: clock }]);
        }
        if (id === "workbench.action.chat.submit") {
          sent.push({ at: clock, text: a.inputValue });
          // the agent does what a summary request asks: it writes the file named in it
          const asked = /`([^`]+\.md)`/.exec(a.inputValue || "");
          if (writesHandoff && asked && core.isOwnMessage(a.inputValue)) {
            fs.mkdirSync(path.dirname(asked[1]), { recursive: true });
            fs.writeFileSync(asked[1], "# handoff\n");
          }
          submits.push(a);
          // preserveInput: only the given text is sent, the input box (text, attachments) is left alone;
          // otherwise (or a VS Code that ignores the option) the box is filled, sent and emptied
          if (ignorePreserve || !(a.acceptInputOptions && a.acceptInputOptions.preserveInput)) { setText(chatInput, a.inputValue); setText(chatInput, ""); }
          // Local /compact: no message in the log, only the summarizing call (an aux request, warm)
          if (kind === "local" && /^\/compact\b/.test(a.inputValue || "")) {
            if (compactUnlogged) return;      // VS Code 1.146: nothing at all in the log
            append([{ type: "llm_request", ts: clock + 10, dur: 3000, attrs: { debugName: "summarizeConversationHistory-full",
              model: "claude-opus-5.5", inputTokens: lastCtx, cachedTokens: lastCtx - 700, outputTokens: 900 } }]);
            return;
          }
          lastCtx += 700;
          if (kind === "sdk") append(sdkTurn(clock, a.inputValue, { input: lastCtx, read: lastCtx - 700, out: 4, dur: 500 }));
          else if (kind === "claude") append(claudeTurn(clock, a.inputValue, { input: lastCtx, read: lastCtx - 700, out: 4, cwd }));
          else if (kind === "codex") append(codexTurn(clock, a.inputValue, { input: lastCtx, read: lastCtx - 700, out: 4 }));
          else append([{ type: "user_message", ts: clock, attrs: { content: a.inputValue } },
                  { type: "turn_start", ts: clock + 5 },
                  { type: "llm_request", ts: clock + 10, dur: 500, attrs: { debugName: "panel/editAgent", model: "claude-opus-5.5",
                    inputTokens: lastCtx, cachedTokens: lastCtx - 700, outputTokens: 4, copilotUsageNanoAiu: 1e9 } },
                  { type: "turn_end", ts: clock + 600 }]);
          h.cacheFrom = clock + 10;
        }
      },
    },
    StatusBarAlignment: { Right: 2 },
    ProgressLocation: { Notification: 15 },
    MarkdownString: class { constructor(v) { this.value = v; } includes(x) { return this.value.includes(x); } toString() { return this.value; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    Range: class { constructor(...a) { this.a = a; } },
    WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push([uri, text]); } },
    Uri: { file: f => ({ scheme: "file", fsPath: f, path: f, with(o) { return { ...this, ...o, fsPath: o.path || this.fsPath }; } }),
           from: o => ({ ...o, toString: () => `${o.scheme}://${o.authority}${o.path}` }),
           joinPath: (b, ...p) => { const f = path.join(b.fsPath, ...p); return vscode.Uri.file(f); } },
  };
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === "vscode" ? vscode : load.call(this, req, ...rest); };
  const realNow = Date.now, realSetInterval = global.setInterval;
  Date.now = () => clock;
  global.setInterval = () => 0;
  delete require.cache[require.resolve("../extension")];
  const ext = require("../extension");
  fs.mkdirSync(logs, { recursive: true });
  const memento = new Map();
  ext.activate({ storageUri: noFolder ? undefined : { fsPath: path.join(storage, "local.copilot-cache-keeper") }, subscriptions: [],
                 globalStorageUri: { fsPath: path.join(globalStorage, "local.copilot-cache-keeper") },
                 globalState: { get: k => memento.get(k), update: async (k, v) => { memento.set(k, v); } } });
  await ext._read();                                  // first read: no chats yet
  clock += 2000;
  fs.mkdirSync(chat, { recursive: true });
  if (kind === "sdk") {
    fs.writeFileSync(path.join(chat, "workspace.yaml"), `id: ${sdkId}\ncwd: ${sdkCwd || tmp}\nclient_name: vscode-agent-host\nsummary_count: 0\n`);
    fs.writeFileSync(path.join(chat, "events.jsonl"), sdkChatLog(clock - 7000, { ctx, auto: sdkAuto, ...(first ? { first } : {}) }));
  } else if (kind === "claude" || kind === "codex") {
    fs.writeFileSync(path.join(chat, logName), (kind === "claude" ? claudeChatLog : codexChatLog)(clock - 7000, { ctx, cwd, ...(first ? { first } : {}) }));
    // Copilot's price sheet, as a Local chat of the workspace has it (Claude and Codex logs carry no prices)
    if (!noPrices) {
      fs.mkdirSync(path.join(logs, "price-src"), { recursive: true });
      fs.writeFileSync(path.join(logs, "price-src", "models.json"), MODELS);
    }
  } else {
    fs.writeFileSync(path.join(chat, "models.json"), MODELS);
    fs.writeFileSync(path.join(chat, "main.jsonl"), chatLog(clock - 7000, { ctx, ...(first ? { first } : {}) }));
  }
  // handoff summaries already in the workspace, written before this window started
  for (const n of handoffs) {
    fs.mkdirSync(path.join(tmp, ".copilot-handoff"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".copilot-handoff", n), "# handoff\n");
  }
  await ext._read();
  const h = {
    sent, warnings, commands, ran, dir: tmp, settings, ext, get status() { return status; }, logFile: path.join(chat, logName), cacheFrom: clock - 7000 + 4000,
    memento, globalStorage, sdkRoot, lists, logs, opened, chatInput, otherInput, setText, infos, append, submits, closed, listed, vscode,
    get clock() { return clock; },
    /** You write in the chat: a real message and the agent's answer. */
    userTypes() {
      lastCtx += 2000;
      if (kind === "sdk") { append(sdkTurn(clock, "Next step please", { input: lastCtx, read: lastCtx - 2000 })); h.cacheFrom = clock + 10; return; }
      if (kind === "claude") { append(claudeTurn(clock, "Next step please", { input: lastCtx, read: lastCtx - 2000, cwd })); h.cacheFrom = clock + 10; return; }
      if (kind === "codex") { append(codexTurn(clock, "Next step please", { input: lastCtx, read: lastCtx - 2000 })); h.cacheFrom = clock + 10; return; }
      append([{ type: "user_message", ts: clock, attrs: { content: "Next step please" } },
              { type: "turn_start", ts: clock + 5 },
              { type: "llm_request", ts: clock + 10, dur: 2000, attrs: { debugName: "panel/editAgent", model: "claude-opus-5.5",
                inputTokens: lastCtx, cachedTokens: lastCtx - 2000, outputTokens: 300, copilotUsageNanoAiu: 3e9 } },
              { type: "turn_end", ts: clock + 2100 }]);
      h.cacheFrom = clock + 10;
    },
    /** Walk the clock `seconds` forward, deciding every second like the extension does. */
    async run(seconds, stop = () => false) {
      for (let i = 0; i < seconds && !stop(); i++) {
        clock += 1000;
        if (i % 5 === 0) await ext._read();
        await ext._decide();
        await new Promise(r => setImmediate(r));
      }
    },
    close() {
      Module._load = load;
      Date.now = realNow;
      global.setInterval = realSetInterval;
      process.env.HOME = realHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
  return h;
}
const never = () => new Promise(() => {});

// ---------------------------------------------------------------- core

(async () => {
  const now = Date.now();

  await check("analyze: prices, timing and costs for an Opus chat", () => {
    const s = core.analyze("/logs/abc123", chatLog(now - 60000), MODELS, now);
    assert.ok(s, "session parsed");
    assert.strictEqual(s.id, "abc123");
    assert.strictEqual(s.ttl, 300, "Claude cache lifetime is 300 s");
    assert.strictEqual(s.cacheFrom, now - 60000 + 4000, "countdown starts at the last call's start");
    assert.strictEqual(s.busy, false);
    assert.ok(s.cost, "cost known from the price sheet");
    // expiry re-sends 150k at the write price minus the cached read: 150k * (500 - 20) / 1e6 = 72
    assert.ok(Math.abs(s.cost.missExtra - 72) < 0.01, `missExtra ${s.cost.missExtra}`);
    assert.ok(s.cost.heartbeat > 2.9 && s.cost.heartbeat < 4, `heartbeat ${s.cost.heartbeat}`);
    assert.ok(s.summaryWords >= 150 && s.summaryWords <= 1500);
  });

  await check("summary length: capped so it costs at most a third of an expiry", () => {
    assert.strictEqual(core.summaryWords({ ctx: 100000, turns: 10, compactions: 0, files: 0 }), 600);
    assert.strictEqual(core.summaryWords({ ctx: 20000, turns: 60, compactions: 5, files: 0 }), 1500);
    assert.strictEqual(core.summaryWords({ ctx: 20000, turns: 60, compactions: 5, files: 0 }, 720), 700);
    assert.strictEqual(core.summaryWords({ ctx: 20000, turns: 60, compactions: 5, files: 0 }, 20), 150, "never below 150");
    // a small context after many compactions, with a long history: uncapped, 1500 words would
    // cost about as much as the expiry itself
    const t0 = now - 60000;
    const history = Array.from({ length: 60 }, (_, i) => JSON.stringify(
      { type: "user_message", ts: t0 - 100000 + i * 1000, attrs: { content: `step ${i}` } })).join("\n") + "\n";
    const s = core.analyze("/logs/small", history + chatLog(t0, { ctx: 25000 }), MODELS, now);
    assert.ok(s.summaryWords < 1500, `words ${s.summaryWords}`);
    assert.ok(s.cost.summary <= s.cost.missExtra / 3 + 1e-9, `summary ${s.cost.summary} vs expiry ${s.cost.missExtra}`);
  });

  await check("analyze: keep-alive estimate learned from an earlier keep-alive", () => {
    const s = core.analyze("/logs/k", chatLog(now - 60000, { keepAlive: true }), MODELS, now);
    // fixed part 900 - 300 (previous reply) = 600, plus the last reply (4 tokens)
    const expected = (150900 * 20 + 604 * 500 + 30 * 2000) / 1e6;
    assert.ok(Math.abs(s.cost.heartbeat - expected) < 0.01, `heartbeat ${s.cost.heartbeat} vs ${expected}`);
    assert.strictEqual(s.lastRealUserTs, now - 60000, "keep-alives are not counted as your messages");
  });

  await check("analyze: a keep-alive on an expired cache is not used to estimate a warm one", () => {
    const s = core.analyze("/logs/k2", chatLog(now - 60000, { keepAlive: true, coldKeepAlive: true }), MODELS, now);
    // only the warm keep-alive counts: its 900 new tokens minus the 4-token reply before it, plus
    // the last reply (4). The cold one (150k uncached) would have made this ~78 cr.
    const expected = (150900 * 20 + 900 * 500 + 30 * 2000) / 1e6;
    assert.ok(Math.abs(s.cost.heartbeat - expected) < 0.05, `heartbeat ${s.cost.heartbeat} vs ${expected}`);
  });

  await check("analyze: expiry priced at what Copilot actually billed for uncached tokens", () => {
    const s = core.analyze("/logs/c", chatLog(now - 60000, { writePrice: 400 }), MODELS, now);
    assert.ok(Math.abs(s.billedWrite * 1e6 - 400) < 0.5, `billed ${s.billedWrite * 1e6}`);
    // 150k * (400 - 20) / 1e6 = 57, not the price sheet's 150k * (500 - 20) / 1e6 = 72
    assert.ok(Math.abs(s.cost.missExtra - 57) < 0.1, `missExtra ${s.cost.missExtra}`);
  });

  await check("analyze: busy through a long tool run and a subagent's own turns", () => {
    const t0 = now - 40 * 60000;                      // turn started 40 min ago, still open
    const ev = [
      { type: "user_message", ts: t0, attrs: { content: "run the mutation tests then push" } },
      { type: "turn_start", ts: t0 + 10 },
      { type: "llm_request", ts: t0 + 50, dur: 2000, attrs: { debugName: "panel/editAgent", model: "claude-opus-5.5",
        inputTokens: 80000, cachedTokens: 0, outputTokens: 300, copilotUsageNanoAiu: 40e9 } },
      { type: "turn_start", ts: t0 + 3000 },          // subagent
      { type: "turn_end", ts: t0 + 9000 },            // subagent done; the agent's turn is still open
      { type: "tool_call", ts: t0 + 10000, name: "run_in_terminal" },   // long run: nothing logged since
    ];
    const s = core.analyze("/logs/long", ev.map(e => JSON.stringify(e)).join("\n") + "\n", MODELS, now);
    assert.strictEqual(s.busy, true);
  });

  await check("analyze: a turn left open by a stopped request or a message sent mid-run is not busy", () => {
    // as seen in a real log: turn 7 runs a terminal command, you send a new message, turn 7 never ends
    const t0 = now - 30 * 60000;
    const ev = [
      { type: "user_message", ts: t0, attrs: { content: "run the mutation tests" } },
      { type: "turn_start", ts: t0 + 10 },
      { type: "llm_request", ts: t0 + 50, dur: 2000, attrs: { debugName: "panel/editAgent", model: "claude-opus-5.5",
        inputTokens: 80000, cachedTokens: 0, outputTokens: 300, copilotUsageNanoAiu: 40e9 } },
      { type: "tool_call", ts: t0 + 2100, name: "run_in_terminal" },
      { type: "user_message", ts: t0 + 60000, attrs: { content: "commit in the meantime" } },
      { type: "turn_start", ts: t0 + 60000 },
      { type: "llm_request", ts: t0 + 60050, dur: 2000, attrs: { debugName: "panel/editAgent", model: "claude-opus-5.5",
        inputTokens: 81000, cachedTokens: 80000, outputTokens: 300, copilotUsageNanoAiu: 5e9 } },
      { type: "turn_end", ts: t0 + 62100 },
    ];
    const s = core.analyze("/logs/stopped", ev.map(e => JSON.stringify(e)).join("\n") + "\n", MODELS, now);
    assert.strictEqual(s.busy, false);
  });

  await check("analyze: busy while a turn is open, and unknown model has no cost", () => {
    const busy = chatLog(now - 5000).replace(/.*"turn_end".*\n$/, "");
    assert.strictEqual(core.analyze("/logs/b", busy, MODELS, now).busy, true);
    const unknown = core.analyze("/logs/u", chatLog(now - 5000, { model: "mystery-model" }), MODELS, now);
    assert.strictEqual(unknown.cost, null);
    assert.strictEqual(unknown.ttl, 300);
  });

  await check("readSessions: a chat whose calls are not recognised is reported, not silently dropped", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-skip-"));
    try {
      fs.mkdirSync(path.join(tmp, "odd-chat"));
      fs.writeFileSync(path.join(tmp, "odd-chat", "main.jsonl"),
        JSON.stringify({ type: "llm_request", ts: now - 1000, attrs: { debugName: "agent/other", model: "x", promptTokens: 5 } }) + "\n");
      const skipped = [];
      const r = await core.readSessions(core.nodeIo, tmp, now, 3600e3, {}, skipped);
      assert.strictEqual(r.length, 0);
      assert.strictEqual(skipped.length, 1);
      assert.ok(skipped[0].why.includes("agent/other") && skipped[0].why.includes("promptTokens"), skipped[0].why);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  await check("rates: long-context tier above 272k for Sol", () => {
    const sheet = JSON.parse(MODELS)[1].billing.token_prices;
    assert.strictEqual(core.rates(sheet, 100000).read, 10 / 1e6);
    assert.strictEqual(core.rates(sheet, 300000).read, 20 / 1e6);
    assert.strictEqual(core.ttlFor("gpt-6.1-sol"), 1800);
  });

  await check("learnTtls: newest Copilot CLI sessions win, source is reported", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-ttl-"));
    try {
      const dir = path.join(tmp, ".copilot", "session-state");
      const write = (name, model, ttl, ageMin) => {
        fs.mkdirSync(path.join(dir, name), { recursive: true });
        const f = path.join(dir, name, "events.jsonl");
        fs.writeFileSync(f, JSON.stringify({ modelId: model, cacheExpiresAt: "x", cacheTtlSeconds: ttl }) + "\n");
        const t = (Date.now() - ageMin * 60000) / 1000;
        fs.utimesSync(f, t, t);
      };
      // names sort the other way round from age: the newest session must win, not the last name
      write("a-new", "claude-haiku-test", 90, 1);
      write("z-old", "claude-haiku-test", 300, 60);
      assert.strictEqual(core.ttlSource("claude-haiku-test"), "default");
      const r = await core.learnTtls(core.nodeIo, tmp);
      assert.strictEqual(r.files, 2);
      assert.strictEqual(r.ttls["claude-haiku-test"], 90);
      assert.strictEqual(core.ttlFor("claude-haiku-test"), 90);
      assert.strictEqual(core.ttlSource("claude-haiku-test"), "Copilot CLI/SDK log");
      assert.strictEqual(core.ttlSource("claude-haiku-test", { "claude-haiku-test": 60 }), "setting");
      // a later look that only reads the old session's window keeps nothing worse than what it reads
      await core.learnTtls(core.nodeIo, tmp, 1);
      assert.strictEqual(core.ttlFor("claude-haiku-test"), 90);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  await check("autoCap / canAffordHeartbeat: keep-alives stop at a share of the expiry cost", () => {
    const s = { cost: { heartbeat: 3, missExtra: 72, summary: 9, restart: 14 } };
    const cap = core.autoCap(s, 50);
    assert.strictEqual(cap, 36);
    assert.strictEqual(core.canAffordHeartbeat(s, 0, cap), true);
    assert.strictEqual(core.canAffordHeartbeat(s, 33, cap), true);    // 33 + 3 = 36
    assert.strictEqual(core.canAffordHeartbeat(s, 34, cap), false);
    assert.strictEqual(core.canAffordHeartbeat(s, 24, cap, true), true);   // 24 + 3 + 9 = 36: summary fits
    assert.strictEqual(core.canAffordHeartbeat(s, 25, cap, true), false);
    assert.strictEqual(core.autoCap({ cost: null }, 50), null);
    assert.strictEqual(core.canAffordHeartbeat({ cost: null }, 0, null), false);
  });

  await check("extension: activates, reads logs, sends a keep-alive 5 s before expiry", async () => {
    const h = await harness({ answer: () => "Auto keep warm" });   // the user picks Auto keep warm
    try {
      const startedCall = h.cacheFrom;
      await h.run(300, () => h.sent.length > 0);
      assert.strictEqual(h.sent.length, 1, "one keep-alive sent");
      assert.ok(core.isKeepAlive(h.sent[0].text), h.sent[0].text);
      const leftAtSend = 300 - (h.sent[0].at - startedCall) / 1000;
      // 5 s lead + 3 s margin until the clock offset is measured, decided once per second
      assert.ok(leftAtSend > 1.5 && leftAtSend <= 9, `sent with ${leftAtSend.toFixed(1)} s left`);
    } finally { h.close(); }
  });

  await check("core: keep-alive jitter stays between 0 and 2 x percent of the lifetime, clamped", () => {
    assert.strictEqual(core.keepAliveJitter(300, 10, () => 0), 0);
    assert.strictEqual(core.keepAliveJitter(300, 10, () => 1), 60);
    assert.strictEqual(core.keepAliveJitter(300, 10, () => 0.5), 30);
    assert.strictEqual(core.keepAliveJitter(300, 0, () => 1), 0);
    assert.strictEqual(core.keepAliveJitter(300, -5, () => 1), 0);
    assert.strictEqual(core.keepAliveJitter(300, 90, () => 1), 120);     // clamped to 20%
    for (let i = 0; i < 1000; i++) {
      const j = core.keepAliveJitter(1800, 10);
      assert.ok(j >= 0 && j <= 360, String(j));
    }
  });

  await check("jitter: auto keep warm varies the send time, never later than the lead", async () => {
    const h = await harness({ answer: () => "Auto keep warm", settings: { keepAliveJitterPercent: 10, autoKeepWarmCapPercent: 100 } });
    try {
      const left = [];
      for (let k = 0; k < 6; k++) {
        const from = h.cacheFrom, n = h.sent.length;
        await h.run(300, () => h.sent.length > n);
        if (h.sent.length === n || !core.isKeepAlive(h.sent[n].text)) break;
        left.push(300 - (h.sent[n].at - from) / 1000);
      }
      assert.ok(left.length >= 3, `${left.length} keep-alives`);
      // 5 s lead + 3 s unmeasured margin (8 s at most, decided once per second), plus up to 60 s
      for (const l of left) assert.ok(l > 4 && l <= 8 + 60 + 1, `sent with ${l.toFixed(1)} s left`);
      assert.ok(Math.max(...left) - Math.min(...left) > 1, `not on a fixed beat: ${left.map(x => x.toFixed(0))}`);
    } finally { h.close(); }
  });

  await check("jitter: Keep warm once is never later than the lead either", async () => {
    for (let k = 0; k < 5; k++) {
      const h = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : never(), settings: { keepAliveJitterPercent: 10 } });
      try {
        const from = h.cacheFrom;
        await h.run(300, () => h.sent.length > 0);
        assert.strictEqual(h.sent.length, 1);
        const l = 300 - (h.sent[0].at - from) / 1000;
        assert.ok(l > 4 && l <= 69, `sent with ${l.toFixed(1)} s left`);
      } finally { h.close(); }
    }
  });

  await check("keep-alive wording: varies, never twice in a row, short, recognised as ours", () => {
    assert.ok(core.KEEPALIVES.length >= 10);
    for (const t of core.KEEPALIVES) {
      assert.ok(t.length <= 80 && /\bOK\b/.test(t) && /no tool|without using tools|don't (run|use) any tools|don't use tools/i.test(t), t);
      assert.ok(!t.includes(core.MARKER), t);
      assert.ok(core.isKeepAlive(t) && core.isOwnMessage(t) && core.isOwnMessage(` ${t}\n`));
    }
    let prev;
    for (let i = 0; i < 200; i++) { const t = core.keepAliveText(prev); assert.notStrictEqual(t, prev); prev = t; }
    assert.strictEqual(core.keepAliveText(undefined, () => 0.9999), core.KEEPALIVES[core.KEEPALIVES.length - 1]);
    assert.ok(core.isOwnMessage("[cache-keeper] Keep-alive while I'm away."), "old tagged keep-alives still ours");
    assert.ok(!core.isOwnMessage("OK, stepping away. Just reply OK, no tools needed. Then fix the parser"));
  });

  await check("keep-alive language: guessed from your messages, English when unsure", () => {
    const cases = [
      ["en", "Refactor the parser please, and add tests for the edge cases"],
      ["it", "Puoi sistemare il parser? Non funziona come dovrebbe, grazie"],
      ["fr", "Peux-tu corriger le parser ? Il ne marche pas avec les fichiers vides, merci"],
      ["es", "¿Puedes arreglar el parser? No funciona con los archivos vacíos, gracias"],
      ["de", "Kannst du bitte den Parser reparieren? Er geht nicht mit leeren Dateien"],
      ["en", "fix bug"],
      ["fr", "Salut, quoi de neuf ?"],
      ["es", "Hola, ¿qué hay de nuevo?"],
      ["de", "Hallo, was gibt es Neues?"],
      ["en", "run the tests"],
      ["en", "`il lo gli che non per` https://example.com/il/che/non"],     // code and links don't count
    ];
    for (const [lang, text] of cases) assert.strictEqual(core.detectLanguage([text]), lang, text);
    // a short Italian chat (seen live): only a few words, still Italian
    assert.strictEqual(core.detectLanguage(["Ciao", "che c'è di nuovo ?", "su questo repo ?"]), "it");
    for (const [lang, list] of Object.entries(core.KEEPALIVES_BY_LANG)) {
      assert.ok(list.length >= 6, lang);
      for (const t of list) assert.ok(/\bOK\b/.test(t) && t.length <= 80 && core.isOwnMessage(t), t);
      assert.ok(list.includes(core.keepAliveText(undefined, Math.random, lang)), lang);
    }
    assert.ok(core.KEEPALIVES.includes(core.keepAliveText(undefined, Math.random, "pt")), "unknown language: English");
    const t0 = Date.now() - 60000;
    const ev = chatLog(t0).trim().split("\n").map(l => JSON.parse(l));
    ev[0].attrs.content = "Puoi sistemare il parser? Non funziona come dovrebbe, grazie";
    const it = core.analyze("/x", ev.map(e => JSON.stringify(e)).join("\n") + "\n", MODELS, Date.now());
    assert.strictEqual(it.lang, "it");
    // a short English-looking question, but Copilot answered in Italian: its answers count too
    const ev2 = chatLog(t0).trim().split("\n").map(l => JSON.parse(l));
    ev2[0].attrs.content = "news on this repo?";
    ev2.splice(4, 0, { type: "agent_response", ts: t0 + 6000, attrs: { content:
      "Le novità recenti riguardano soprattutto CMake e Conan. La directory di lavoro è pulita e il branch è allineato." } });
    const it2 = core.analyze("/x", ev2.map(e => JSON.stringify(e)).join("\n") + "\n", MODELS, Date.now());
    assert.strictEqual(it2.lang, "it");
  });

  await check("summary request: no [cache-keeper] tag, own tag per language, recognised as ours", () => {
    const x = { rel: ".copilot-handoff/a.md", turns: 3, compactions: 0, files: 2, ctxK: 150, words: 400 };
    for (const lang of ["en", "it", "fr", "es", "de", "pt"]) {
      const t = core.summaryPrompt(lang, x);
      assert.ok(!t.includes(core.MARKER), t);
      assert.ok(t.startsWith(core.SUMMARY_TAGS[lang] || core.SUMMARY_TAGS.en), t);
      assert.ok(t.includes(x.rel) && t.includes("400") && t.includes("DONE"), t);
      assert.ok(core.isOwnMessage(t), t);
    }
    assert.ok(core.summaryPrompt("it", x).includes("riepilogo"));
    assert.ok(core.handoffStart("fr").startsWith("Reprends") && core.handoffStart("xx").startsWith("Continue"));
  });

  await check("extension: nothing sent carries the old [cache-keeper] tag", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : never() });
    try {
      await h.run(700);
      assert.strictEqual(h.sent.length, 2, "keep-alive, then the closing summary");
      for (const x of h.sent) assert.ok(!x.text.includes(core.MARKER), x.text);
      assert.ok(h.sent[1].text.startsWith("[summary]"), h.sent[1].text);
    } finally { h.close(); }
  });

  await check("status-bar list: the chat you last typed in first, then soonest expiry, then expired", () => {
    const c = (id, left, cacheFrom = 0, busy = false) => ({ id, left, cacheFrom, busy });
    const list = [c("old", 40), c("cur", 250), c("soon", 10), c("gone1", -5, 1), c("gone2", -50, 2), c("work", -1, 0, true)];
    const ids = l => l.map(x => x.id).join(",");
    assert.strictEqual(ids(core.orderChats(list, "cur", x => x.left)), "cur,work,soon,old,gone2,gone1");
    assert.strictEqual(ids(core.orderChats(list, "gone1", x => x.left)), "gone1,work,soon,old,cur,gone2", "even when expired");
    assert.strictEqual(ids(core.orderChats(list, null, x => x.left)), "work,soon,old,cur,gone2,gone1");
  });

  await check("analyze: an untagged keep-alive is not counted as your message", () => {
    const t0 = Date.now() - 60000;
    const ev = chatLog(t0, { ctx: 150000 }).trim().split("\n").map(l => JSON.parse(l));
    ev.push({ type: "user_message", ts: t0 + 9000, attrs: { content: core.KEEPALIVES[3] } },
            { type: "turn_start", ts: t0 + 9010 },
            { type: "llm_request", ts: t0 + 9050, dur: 800, attrs: { debugName: "panel/editAgent", model: "claude-opus-5.5",
              inputTokens: 150900, cachedTokens: 150000, outputTokens: 4, copilotUsageNanoAiu: 3.5e9 } },
            { type: "turn_end", ts: t0 + 10000 });
    const s = core.analyze("/x", ev.map(e => JSON.stringify(e)).join("\n") + "\n", MODELS, Date.now());
    assert.strictEqual(s.lastRealUserTs, t0, "your last message is still the real one");
  });

  await check("send: not submitted if the agent starts working while the chat tab opens", async () => {
    const h = await harness({ answer: () => "Auto keep warm", busyOnOpen: true });
    try {
      await h.run(320);
      assert.strictEqual(h.sent.length, 0, "nothing queued behind the agent");
    } finally { h.close(); }
  });

  await check("warnings: Keep warm once brings the warning back on the next timeout", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : never() });
    try {
      await h.run(700);
      assert.strictEqual(h.warnings.length, 2, "warned again after Keep warm once");
      assert.strictEqual(h.sent.length, 2, "keep-alive, then the closing summary");
      assert.ok(core.isKeepAlive(h.sent[0].text) && h.sent[1].text.includes("handoff summary"));
    } finally { h.close(); }
  });

  await check("summaryPays: a summary only when it and a new chat cost clearly less than continuing", () => {
    // 30k of context, a new chat's own setup already 25k of it: a new chat would cost about as much
    const small = core.analyze("/logs/a", chatLog(now - 60000, { ctx: 30000, first: 25000 }), MODELS, now);
    assert.strictEqual(core.summaryPays(small), false, JSON.stringify(small.cost));
    const grown = core.analyze("/logs/b", chatLog(now - 60000, { ctx: 40000 }), MODELS, now);   // 20k first, 40k now
    assert.strictEqual(core.summaryPays(grown), true, JSON.stringify(grown.cost));
    assert.strictEqual(core.summaryPays({ cost: null }), false);
  });

  await check("Keep warm once on a chat where a summary would not pay: keep-alive only", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : never(), ctx: 30000, first: 25000 });
    try {
      await h.run(700);
      assert.strictEqual(h.sent.length, 1, h.sent.map(x => x.text.slice(0, 40)).join(" | "));
      assert.ok(core.isKeepAlive(h.sent[0].text));
    } finally { h.close(); }
  });

  await check("Auto keep warm on a chat where a summary would not pay: stops at the cap, no summary", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Auto keep warm" : never(), ctx: 30000, first: 25000 });
    try {
      await h.run(3000);
      assert.ok(h.sent.length >= 1, "kept warm");
      assert.ok(!h.sent.some(x => x.text.includes("handoff summary")), "no summary");
    } finally { h.close(); }
  });

  await check("summaryAfterKeepWarm off: Keep warm once sends no summary", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : never(), settings: { summaryAfterKeepWarm: false } });
    try {
      await h.run(700);
      assert.strictEqual(h.sent.length, 1, "only the keep-alive");
    } finally { h.close(); }
  });

  await check("compact: prompt is /compact with what to keep, in the chat's language; it is not your message", () => {
    for (const lang of ["en", "it", "fr", "es", "de", "xx"]) {
      const t = core.compactPrompt(lang);
      assert.ok(t.startsWith("/compact "), t);
      assert.ok(core.isOwnMessage(t), "recognised as Cache Keeper's (or a command), not a real message");
    }
    assert.ok(core.compactPrompt("it").includes("Conserva"));
    assert.strictEqual(core.compactPrompt("xx"), core.compactPrompt("en"));
  });

  await check("compactPays: pays on a large chat, not on one barely bigger than a new chat", () => {
    const big = core.analyze("/logs/a", chatLog(now - 60000, { ctx: 150000 }), MODELS, now);
    assert.strictEqual(core.compactPays(big), true, JSON.stringify(big.cost));
    assert.ok(big.cost.compacted < 60000 && big.cost.compacted > 20000, `compacted ${big.cost.compacted}`);
    const small = core.analyze("/logs/b", chatLog(now - 60000, { ctx: 30000, first: 25000 }), MODELS, now);
    assert.strictEqual(core.compactPays(small), false, JSON.stringify(small.cost));
    assert.ok(small.cost.compacted <= 30000, "never more than the chat holds");
    assert.strictEqual(core.compactPays({ cost: null }), false);
  });

  await check("compacted since the last call: the next message is priced on the compacted size", () => {
    const base = chatLog(now - 60000, { ctx: 150000 });
    const before = core.analyze("/logs/c", base, MODELS, now);
    const after = core.analyze("/logs/c2", base + JSON.stringify({ type: "llm_request", ts: now - 30000, dur: 3000,
      attrs: { debugName: "summarizeConversationHistory-full", model: "claude-opus-5.5", inputTokens: 150000, cachedTokens: 149000 } }) + "\n", MODELS, now);
    assert.strictEqual(before.compactedIdle, false);
    assert.strictEqual(after.compactedIdle, true);
    assert.strictEqual(after.ctx, before.cost.compacted);
    assert.ok(after.cost.missExtra < before.cost.missExtra / 2, `${after.cost.missExtra} vs ${before.cost.missExtra}`);
    assert.strictEqual(after.cacheFrom, before.cacheFrom, "the countdown is unchanged");
  });

  await check("Compact from a Local chat's warning (More…): sends /compact without your draft, confirmed by the log", async () => {
    let buttons = [], items = [];
    const h = await harness({ answer: (m, b, n) => { if (n === 1) { buttons = b; return "More…"; } return never(); },
                              menu: m => { items = m; return m.find(i => i.label === "Compact"); }, draft: "my unsent text" });
    try {
      await h.run(300);
      assert.deepStrictEqual(buttons.map(b => b.replace(/ \(.*$/, "")), ["Keep warm", "Auto keep warm", "More…"]);
      assert.ok(/\(~[\d.]+ cr\)/.test((items.find(i => i.label === "Compact") || {}).detail || ""), "Compact in the menu with its cost");
      assert.strictEqual(h.sent.length, 1, h.sent.map(x => x.text).join(" | "));
      assert.ok(h.sent[0].text.startsWith("/compact "), h.sent[0].text);
      assert.ok(h.submits[0].acceptInputOptions.preserveInput, "sent like VS Code sends /compact itself");
      assert.strictEqual(h.chatInput.getText(), "my unsent text");
      assert.ok(!h.warnings.some(w => /could not confirm|did not start/.test(w.msg)), h.warnings.map(w => w.msg).join(" | "));
      assert.ok(h.closed.length >= 1, "its tab closed once the compaction was in the log");
      assert.ok(h.infos.some(m => /compacting .* go on in the same chat/.test(m)), h.infos.join(" | "));
    } finally { h.close(); }
  });

  await check("Compact: not offered for chats of other harnesses (not tested there yet), unless set", async () => {
    const labels = items => items.map(i => i.label);
    for (const kind of ["sdk", "claude", "codex"]) {
      let items = [];
      const h = await harness({ kind, answer: (m, b, n) => n === 1 ? "More…" : never(), menu: m => { items = m; },
                                settings: { ttlSeconds: { "gpt-6.1-sol": 300 } } });
      try {
        await h.run(320, () => items.length > 0);
        assert.ok(items.length && !labels(items).includes("Compact"), `${kind}: ${labels(items).join(" | ")}`);
      } finally { h.close(); }
    }
    let items = [];
    const h = await harness({ kind: "sdk", settings: { compactHarnesses: ["local", "sdk"] }, answer: (m, b, n) => n === 1 ? "More…" : never(),
                              menu: m => { items = m; } });
    try {
      await h.run(260);
      assert.ok(labels(items).includes("Compact"), labels(items).join(" | "));
    } finally { h.close(); }
  });

  await check("autoAction compact: no click on a large Local chat compacts it before expiry, no summary", async () => {
    const h = await harness({ answer: never, ctx: 150000, settings: { autoAction: "compact" } });
    try {
      await h.run(310);
      assert.strictEqual(h.sent.length, 1, h.sent.map(x => x.text.slice(0, 40)).join(" | "));
      assert.ok(h.sent[0].text.startsWith("/compact "), h.sent[0].text);
      const left = (h.cacheFrom + 300000 - h.sent[0].at) / 1000;
      assert.ok(left > 0 && left <= 16, `sent ${left}s before expiry`);
      assert.ok(/No click: a compaction \(~[\d.]+ cr\)/.test(h.warnings[0].msg), h.warnings[0].msg);
      assert.ok(!fs.existsSync(path.join(h.dir, ".copilot-handoff")), "no handoff file");
    } finally { h.close(); }
  });

  await check("autoAction compact: once compacted, nothing more until you write again (and the expiry notice is smaller)", async () => {
    const h = await harness({ answer: never, ctx: 150000, settings: { autoAction: "compact" } });
    try {
      await h.run(330);
      assert.strictEqual(h.sent.length, 1);
      const notice = h.infos.find(m => /Copilot cache expired/.test(m)) || "";
      const extra = Number((/~([\d.]+) extra credits/.exec(notice) || [])[1]);
      assert.ok(extra > 0 && extra < 30, `expiry adds ${extra} cr after compacting (about 60 for 150k uncompacted): ${notice}`);
      await h.run(400);
      assert.strictEqual(h.sent.length, 1, "no second compaction or summary");
    } finally { h.close(); }
  });

  await check("Local /compact that VS Code doesn't log (1.146): counted as done, no 'did not start' warning, no second one", async () => {
    const h = await harness({ answer: never, ctx: 150000, settings: { autoAction: "compact" }, compactUnlogged: true });
    try {
      await h.run(330);
      assert.strictEqual(h.sent.length, 1, h.sent.map(x => x.text.slice(0, 40)).join(" | "));
      assert.ok(!h.warnings.some(w => /could not confirm|did not start/.test(w.msg)), h.warnings.map(w => w.msg).join(" | "));
      await h.run(400);
      assert.strictEqual(h.sent.length, 1, "no second compaction or summary");
      const notice = h.infos.find(m => /Copilot cache expired/.test(m)) || "";
      const extra = Number((/~([\d.]+) extra credits/.exec(notice) || [])[1]);
      assert.ok(extra > 0 && extra < 30, `priced as compacted: ${notice}`);
      assert.ok(h.closed.length >= 1, "its tab closed after a while");
    } finally { h.close(); }
  });

  await check("a chat is not moved back into the Chat view once you have written in another chat", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "More…" : never(), menu: m => m.find(i => i.label === "Compact"),
                              settings: { afterSend: "restoreLastTyped" }, compactUnlogged: true });
    try {
      await h.run(300, () => h.sent.length > 0);
      assert.ok((h.sent[0] || {}).text.startsWith("/compact "), "compaction sent");
      // meanwhile you start working in another chat
      await h.run(20);
      const two = path.join(h.logs, "sess-2");
      fs.cpSync(path.join(h.logs, "sess-1"), two, { recursive: true });
      fs.appendFileSync(path.join(two, "main.jsonl"), [
        { type: "user_message", ts: h.clock, attrs: { content: "Something else please" } },
        { type: "llm_request", ts: h.clock + 10, dur: 500, attrs: { debugName: "panel/editAgent", model: "claude-opus-5.5",
          inputTokens: 41000, cachedTokens: 40000, outputTokens: 4, copilotUsageNanoAiu: 1e9 } }].map(e => JSON.stringify(e)).join("\n") + "\n");
      await h.run(60);
      await new Promise(r => setTimeout(r, 1500));
      assert.ok(!h.ran.some(r => r.id === "workbench.action.chat.openInSidebar"), "not moved back");
      assert.ok(h.closed.length >= 1, "its tab closed");
    } finally { h.close(); }
  });

  await check("autoAction compact on a harness without Compact: the summary, as before", async () => {
    const h = await harness({ kind: "sdk", answer: never, ctx: 150000, settings: { autoAction: "compact" } });
    try {
      await h.run(310);
      assert.strictEqual(h.sent.length, 1);
      assert.ok(h.sent[0].text.includes("handoff summary"), h.sent[0].text);
    } finally { h.close(); }
  });

  await check("autoAction off, or an old autoSummary false: nothing automatic; autoAction set wins over autoSummary", async () => {
    for (const settings of [{ autoAction: "off" }, { autoSummary: false }]) {
      const h = await harness({ answer: never, ctx: 150000, settings });
      try {
        await h.run(310);
        assert.strictEqual(h.sent.length, 0, JSON.stringify(settings));
        assert.ok(/No click: it expires/.test(h.warnings[0].msg), h.warnings[0].msg);
      } finally { h.close(); }
    }
    const h = await harness({ answer: never, ctx: 150000, settings: { autoSummary: false, autoAction: "summary" } });
    try {
      await h.run(310);
      assert.strictEqual(h.sent.length, 1);
      assert.ok(h.sent[0].text.includes("handoff summary"));
    } finally { h.close(); }
  });

  await check("autoAction compact: Keep warm once ends with a compaction instead of a summary", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : never(), ctx: 150000, settings: { autoAction: "compact" } });
    try {
      await h.run(700);
      assert.strictEqual(h.sent.length, 2, h.sent.map(x => x.text.slice(0, 40)).join(" | "));
      assert.ok(core.isKeepAlive(h.sent[0].text) && h.sent[1].text.startsWith("/compact "));
    } finally { h.close(); }
  });

  await check("Compact on an expired chat asks first (cost); declined: nothing sent, back to default", async () => {
    for (const reply of ["Compact anyway", undefined]) {
      let asked = "";
      const h = await harness({ answer: (msg) => { if (/already expired/.test(msg)) { asked = msg; return reply; } return never(); } });
      try {
        await h.run(320);                                    // expired
        await h.commands["cacheKeeper.compactNow"]();
        assert.ok(/compaction re-sends the whole context: ~[\d.]+ cr/.test(asked), asked);
        await h.run(5);
        assert.strictEqual(h.sent.length, reply ? 1 : 0, String(reply));
        if (reply) assert.ok(h.sent[0].text.startsWith("/compact "));
      } finally { h.close(); }
    }
  });

  await check("menu: Compact listed for a Local chat with its cost and what it does", async () => {
    let items = [];
    const h = await harness({ answer: never, menu: it => { if (it.some(i => i.label === "Compact")) items = it; return undefined; } });
    try {
      await h.run(20);
      await h.commands["cacheKeeper.options"]();
      const c = items.find(i => i.label === "Compact");
      assert.ok(c && /\/compact\) \(~[\d.]+ cr\); your next message then re-sends ~\d+k tokens instead of \d+k\. Changes the chat in place, no undo/.test(c.detail), c && c.detail);
    } finally { h.close(); }
  });

  await check("warnings: closing one stops later warnings until you write in the chat again", async () => {
    const h = await harness({ answer: () => undefined });
    try {
      await h.run(310);                                  // first window: warned, closed, expired
      assert.strictEqual(h.warnings.length, 1);
      assert.strictEqual(h.sent.length, 0, "default: nothing sent");
      h.userTypes();
      await h.run(310);
      assert.strictEqual(h.warnings.length, 2, "your new message brings the warning back");
    } finally { h.close(); }
  });

  await check("closing the warning acts as Ignore: nothing sent, not even the summary", async () => {
    const h = await harness({ answer: () => undefined, settings: { thresholdTokens: 0 } });
    try {
      await h.run(310);
      assert.strictEqual(h.sent.length, 0);
    } finally { h.close(); }
  });

  await check("warnings: an unanswered one never blocks the warning after your next message", async () => {
    const h = await harness({ answer: never });
    try {
      await h.run(310);
      h.userTypes();
      await h.run(310);
      assert.strictEqual(h.warnings.length, 2);
      assert.strictEqual(h.sent.length, 0);
    } finally { h.close(); }
  });

  await check("no click never keeps warm, even with an old noResponseAction setting left over", async () => {
    for (const old of ["keepWarmOnce", "autoKeepWarm"]) {
      const h = await harness({ answer: never, settings: { noResponseAction: old } });
      try {
        await h.run(700);
        assert.strictEqual(h.sent.filter(x => core.isKeepAlive(x.text)).length, 0, `${old}: no keep-alive`);
        assert.strictEqual(h.warnings.length, 1, "no warning after it was ignored");
        assert.ok(!h.warnings[0].msg.includes("kept warm") && !h.warnings[0].msg.includes("keep-alive is sent"), h.warnings[0].msg);
      } finally { h.close(); }
    }
  });

  await check("auto keep warm: keeps warm up to 50% of the expiry cost, then summary", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Auto keep warm" : never() });
    try {
      const start = core.analyze("/x", fs.readFileSync(h.logFile, "utf8"), MODELS, h.clock);
      const cap = start.cost.missExtra / 2;
      let red = false;
      await h.run(300 * 30, () => {
        red = red || (h.status.backgroundColor || {}).id === "statusBarItem.errorBackground";
        return h.sent.some(x => !core.isKeepAlive(x.text));
      });
      assert.ok(red, "status bar turns red while auto keep warm runs");
      const alives = h.sent.filter(x => core.isKeepAlive(x.text));
      assert.ok(h.sent[h.sent.length - 1].text.includes("handoff summary"), "ends with a summary");
      assert.ok(alives.length >= 3, `${alives.length} keep-alives`);
      // estimate at each send, as the extension counted it: under the cap, and one more would not fit
      const per = start.cost.heartbeat, sum = start.cost.summary;
      assert.ok(alives.length * per + sum <= cap * 1.05 && (alives.length + 2) * per + sum > cap,
        `${alives.length} keep-alives at ~${per.toFixed(2)} cr vs cap ${cap.toFixed(2)}`);
      assert.strictEqual(h.warnings.length, 2, "first warning, then one at the cap");
      assert.ok(h.warnings[1].msg.includes("reached its 50% cap"), h.warnings[1].msg);
    } finally { h.close(); }
  });

  await check("auto keep warm at its cap: choosing Auto keep warm again starts a new cap", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Auto keep warm" : n === 2 ? "Auto keep warm" : never() });
    try {
      await h.run(300 * 60, () => h.sent.some(x => !core.isKeepAlive(x.text)));
      const capAt = h.warnings[1].at;
      assert.ok(h.warnings[2] && h.warnings[2].msg.includes("cap"), "warned again at the new cap");
      assert.ok(h.sent.filter(x => x.at > capAt && core.isKeepAlive(x.text)).length >= 3, "kept going after the cap");
      assert.ok(h.sent[h.sent.length - 1].text.includes("handoff summary"), "summary at the second cap");
    } finally { h.close(); }
  });

  await check("auto keep warm: stops at its time limit (autoKeepWarmMaxMinutes) before the cap", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Auto keep warm" : never(),
                              settings: { autoKeepWarmCapPercent: 100, autoKeepWarmMaxMinutes: 20 } });
    try {
      const start = h.clock;
      await h.run(300 * 30, () => h.sent.some(x => !core.isKeepAlive(x.text)));
      const alives = h.sent.filter(x => core.isKeepAlive(x.text));
      // keep-alives only while they keep it warm within 20 min of the click: at ~1, ~6 and ~11 min
      assert.strictEqual(alives.length, 3, `${alives.length} keep-alives`);
      assert.ok(alives.every(x => x.at - start + 300000 <= 20 * 60000), "none keeps it warm past the limit");
      assert.ok(h.warnings[1] && h.warnings[1].msg.includes("reached its 20 min limit"), h.warnings[1] && h.warnings[1].msg);
      assert.ok(h.sent[h.sent.length - 1].text.includes("handoff summary"), "ends with a summary");
    } finally { h.close(); }
  });

  await check("keep-warm time: Keep warm once counts too, and Auto keep warm again at the limit starts a new period", async () => {
    const answers = ["Keep warm", "Auto keep warm", "Auto keep warm"];
    const h = await harness({ answer: (m, b, n) => answers[n - 1] || never(),
                              settings: { autoKeepWarmCapPercent: 100, autoKeepWarmMaxMinutes: 20 } });
    try {
      const start = h.clock;
      await h.run(300 * 30, () => h.sent.some(x => !core.isKeepAlive(x.text)));
      const limitAt = h.warnings[2].at;
      assert.ok(h.warnings[2].msg.includes("reached its 20 min limit"), h.warnings[2].msg);
      // once + auto together: the same 3 keep-alives as auto alone before the limit
      assert.strictEqual(h.sent.filter(x => x.at < limitAt).length, 3);
      assert.ok(limitAt - start < 20 * 60000, "limit counted from the Keep warm once click");
      assert.ok(h.sent.filter(x => x.at > limitAt && core.isKeepAlive(x.text)).length >= 3, "a new period after choosing again");
      assert.ok(h.warnings[3] && h.warnings[3].msg.includes("20 min limit"), "and its own limit");
    } finally { h.close(); }
  });

  await check("keep-warm time: 120 min is a hard cap, a higher setting counts as 120", async () => {
    // 10-min cache so the time limit, not the spending cap, ends it
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Auto keep warm" : never(),
                              settings: { autoKeepWarmCapPercent: 100, autoKeepWarmMaxMinutes: 600,
                                          ttlSeconds: { "claude-opus-5.5": 600 } } });
    try {
      const start = h.clock;
      await h.run(600 * 20, () => h.sent.some(x => !core.isKeepAlive(x.text)));
      const alives = h.sent.filter(x => core.isKeepAlive(x.text));
      assert.ok(h.warnings[1] && h.warnings[1].msg.includes("reached its 2 h limit"), h.warnings[1] && h.warnings[1].msg);
      assert.ok(alives.every(x => x.at - start + 600000 <= 120 * 60000), "none keeps it warm past 2 h");
      assert.ok(alives.length >= 10, `${alives.length} keep-alives`);
    } finally { h.close(); }
  });

  await check("keep-warm time: Back to default stops counting, keeping warm again starts from zero", async () => {
    const answers = ["Auto keep warm", "Back to default", "Auto keep warm"];
    let k = 0;
    const h = await harness({ answer: never, settings: { autoKeepWarmCapPercent: 100, autoKeepWarmMaxMinutes: 20 },
                              menu: items => { const want = answers[k++]; return items.find(i => i.label === want); } });
    try {
      await h.commands["cacheKeeper.options"]();
      await h.run(300 * 2 + 30);                         // ~10 min of auto keep warm
      assert.strictEqual(h.sent.length, 2);
      await h.commands["cacheKeeper.options"]();         // back to default: counting stops
      await h.commands["cacheKeeper.options"]();         // auto again: a fresh 20 min
      await h.run(300 * 30, () => h.sent.some(x => !core.isKeepAlive(x.text)));
      assert.ok(h.sent.filter(x => core.isKeepAlive(x.text)).length >= 5, `${h.sent.length} sent`);
    } finally { h.close(); }
  });

  await check("expired chat: orange status only when its context is at least thresholdTokens", async () => {
    for (const [threshold, orange] of [[30000, true], [100000, false]]) {     // the chat has 40k tokens
      const h = await harness({ answer: () => undefined, settings: { thresholdTokens: threshold, autoSummary: false } });
      try {
        await h.run(400);
        assert.strictEqual(h.sent.length, 0);
        assert.ok(h.status.text.includes("expired · +"), h.status.text);
        const bg = (h.status.backgroundColor || {}).id;
        assert.strictEqual(bg === "statusBarItem.warningBackground", orange, `threshold ${threshold}: ${bg}`);
        assert.strictEqual(h.status.text.includes("$(warning)"), orange, h.status.text);
        assert.strictEqual(h.status.tooltip.value.includes("tokens of context"), orange, h.status.tooltip);
      } finally { h.close(); }
    }
  });

  await check("status bar follows the chat where you last typed, not the latest model call", async () => {
    const h = await harness({ answer: () => undefined });
    try {
      // another chat: you typed in it earlier, but a Cache Keeper keep-alive ran there just now
      const other = path.join(path.dirname(path.dirname(h.logFile)), "sess-2");
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, "models.json"), MODELS);
      fs.writeFileSync(path.join(other, "main.jsonl"), chatLog(h.clock - 200000, { ctx: 90000 }) +
        [{ type: "user_message", ts: h.clock - 1000, attrs: { content: "[cache-keeper] Keep-alive while I'm away." } },
         { type: "turn_start", ts: h.clock - 990 },
         { type: "llm_request", ts: h.clock - 950, dur: 500, attrs: { debugName: "panel/editAgent", model: "claude-opus-5.5",
           inputTokens: 90900, cachedTokens: 90000, outputTokens: 4, copilotUsageNanoAiu: 3e9 } },
         { type: "turn_end", ts: h.clock - 400 }].map(e => JSON.stringify(e)).join("\n") + "\n");
      await h.run(6);
      assert.ok(h.status.tooltip.value.includes("40k context"), h.status.tooltip);
    } finally { h.close(); }
  });

  await check("minCredits filters everything: no warning and no orange status for a cheap chat", async () => {
    const h = await harness({ answer: () => undefined, settings: { thresholdTokens: 30000, minCredits: 1000 } });
    try {
      await h.run(400);
      assert.strictEqual(h.warnings.length, 0);
      assert.strictEqual(h.sent.length, 0);
      assert.notStrictEqual((h.status.backgroundColor || {}).id, "statusBarItem.warningBackground");
    } finally { h.close(); }
  });

  await check("auto keep warm keeps going when the expiry estimate drops below minCredits", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Auto keep warm" : never(), settings: { autoKeepWarmCapPercent: 100 } });
    try {
      await h.run(300, () => h.sent.length > 0);
      assert.strictEqual(h.sent.length, 1, "first keep-alive");
      h.settings.minCredits = 1e9;      // e.g. a cold call made the estimate drop under the floor
      await h.run(320, () => h.sent.length > 1);
      assert.strictEqual(h.sent.length, 2, "second keep-alive still sent");
      assert.ok(!/expired/.test(h.status.text), h.status.text);
    } finally { h.close(); }
  });

  await check("expired chat with a handoff summary: tooltip gives the new-chat cost", async () => {
    const h = await harness({ answer: () => "Summarize", settings: { thresholdTokens: 30000 } });
    try {
      await h.run(900);
      assert.ok(h.sent.some(x => x.text.includes("handoff summary")), "summary written");
      assert.ok(h.status.text.includes("expired · +"), h.status.text);
      assert.ok(/Handoff summary ready: a new chat from it ≈ [\d.]+ cr/.test(h.status.tooltip.value), h.status.tooltip);
    } finally { h.close(); }
  });

  await check("status-bar list offers New chat from handoff once a summary file exists", async () => {
    let offered;
    const h = await harness({ answer: () => "Summarize", settings: { thresholdTokens: 30000 }, writesHandoff: false,
      menu: items => { offered = items.map(i => i.label); return items.find(i => i.label === "New chat from handoff"); } });
    try {
      await h.run(900);
      const m = h.sent.map(x => x.text.match(/`([^`]+\.md)`/)).find(Boolean);
      assert.ok(m, "summary asks for a file");
      const file = path.isAbsolute(m[1]) ? m[1] : path.join(h.dir, m[1]);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "# handoff");     // the agent wrote it
      await h.commands["cacheKeeper.options"]();
      assert.strictEqual(offered[0], "New chat from handoff", offered.join(", "));
      const open = h.ran.find(x => x.id === "workbench.action.chat.open");
      assert.ok(open && open.a.attachFiles[0].fsPath.endsWith(path.basename(m[1])), "new chat opened with the handoff attached");
    } finally { h.close(); }
  });

  await check("multi-root workspace: summary asked at a full path, found in another folder too", async () => {
    let offered;
    const h = await harness({ answer: () => "Summarize", settings: { thresholdTokens: 30000 }, folders: 2, writesHandoff: false,
      menu: items => { offered = items.map(i => i.label); return undefined; } });
    try {
      await h.run(900);
      const m = h.sent.map(x => x.text.match(/`([^`]+\.md)`/)).find(Boolean);
      assert.ok(m && path.isAbsolute(m[1]), "full path in the request: " + (m && m[1]));
      // the agent wrote it in the second repository's .copilot-handoff/ anyway
      const other = path.join(h.dir, "repo2", ".copilot-handoff", path.basename(m[1]));
      fs.mkdirSync(path.dirname(other), { recursive: true });
      fs.writeFileSync(other, "# handoff");
      await h.commands["cacheKeeper.options"]();
      assert.strictEqual(offered[0], "New chat from handoff", offered.join(", "));
    } finally { h.close(); }
  });

  await check("window restarted: an expired chat's earlier handoff file is found and offered", async () => {
    let offered;
    const h = await harness({ answer: () => undefined, settings: { autoAction: "off" },
      handoffs: ["20261110-0900-sess-1.md", "20261111-1335-sess-1.md", "20261111-1400-other123.md", "notes.md"],
      menu: items => { offered = items.map(i => i.label); return items.find(i => i.label === "New chat from handoff"); } });
    try {
      await h.run(400);                          // well past expiry
      assert.ok(!h.sent.length, "nothing sent");
      await h.commands["cacheKeeper.options"]();
      assert.strictEqual(offered[0], "New chat from handoff", String(offered));
      const open = h.ran.find(x => x.id === "workbench.action.chat.open");
      assert.ok(open && open.a.attachFiles[0].fsPath.endsWith("20261111-1335-sess-1.md"), "the newest of this chat's files");
      assert.ok(h.lists[0].some(i => /handoff summary ready/.test(i.detail)), "listed as ready");
    } finally { h.close(); }
  });

  await check("status-bar list: no New chat from handoff without a summary file", async () => {
    let offered;
    const h = await harness({ answer: () => "Ignore", menu: items => { offered = items.map(i => i.label); } });
    try {
      await h.run(30);
      await h.commands["cacheKeeper.options"]();
      assert.ok(offered && !offered.includes("New chat from handoff"), String(offered));
    } finally { h.close(); }
  });


  // ---------------------------------------------------------------- Copilot SDK chats

  await check("analyzeSdk: lifetime and countdown from the chat's own log, costs from what it was billed", () => {
    const s = core.analyzeSdk("/h/.copilot/session-state/sdk-1", sdkChatLog(now - 60000), { cwd: "/w" }, now);
    assert.ok(s);
    assert.strictEqual(s.kind, "sdk");
    assert.strictEqual(s.id, "sdk-1");
    assert.strictEqual(s.ttl, 300);
    assert.strictEqual(s.ttlFrom, "this chat's log");
    assert.strictEqual(s.cacheFrom, now - 60000 + 4000, "cache refreshed when the last call started");
    assert.strictEqual(s.busy, false);
    assert.strictEqual(s.ctx, 150000);
    // 150k * (500 - 20) / 1e6 = 72, like the Local chat with the same prices
    assert.ok(Math.abs(s.cost.missExtra - 72) < 0.01, String(s.cost.missExtra));
    assert.ok(s.cost.heartbeat > 3 && s.cost.heartbeat < 4.5, String(s.cost.heartbeat));
    assert.strictEqual(s.title, "Refactor the parser");
    assert.ok(s.lastRealUserTs > 0);
    // a setting still wins over the log
    assert.strictEqual(core.analyzeSdk("/x/sdk-1", sdkChatLog(now - 60000), {}, now, { "claude-opus-5.5": 120 }).ttl, 120);
  });

  await check("analyzeSdk: busy while a turn is open, a message waits, or between two turns", () => {
    const base = sdkChatLog(now - 60000);
    const at = (extra, t = now) => core.analyzeSdk("/x/s", base + extra.map(e => JSON.stringify(e)).join("\n") + "\n", {}, t).busy;
    assert.strictEqual(at([ev("user.message", now - 1000, { content: "go" })]), true, "message waiting for its turn");
    assert.strictEqual(at([ev("user.message", now - 2000, { content: "go" }), ev("assistant.turn_start", now - 1990)]), true, "turn open");
    assert.strictEqual(at([ev("user.message", now - 9000, { content: "go" }), ev("assistant.turn_start", now - 8990),
                           ev("assistant.turn_end", now - 1000)]), true, "between turns of one request");
    assert.strictEqual(at([ev("user.message", now - 9000, { content: "go" }), ev("assistant.turn_start", now - 8990),
                           ev("assistant.turn_end", now - 1000), ev("session.usage_checkpoint", now - 990)]), false, "idle checkpoint");
    assert.strictEqual(at([ev("user.message", now - 9000, { content: "go" }), ev("assistant.turn_start", now - 8990),
                           ev("assistant.turn_end", now - 5000)]), false, "turn ended a while ago");
    assert.strictEqual(at([ev("user.message", now - 9000, { content: "go" }), ev("assistant.turn_start", now - 8990),
                           ev("abort", now - 100)]), false, "stopped");
    // a message sent while the agent works is part of that turn, not a new one waiting
    assert.strictEqual(at([ev("user.message", now - 9000, { content: "go" }), ev("assistant.turn_start", now - 8990),
                           ev("user.message", now - 8000, { content: "also check X\n\n<reminder>\nsteer\n</reminder>" }),
                           ev("assistant.turn_end", now - 5000), ev("session.usage_checkpoint", now - 4990)]), false, "steering message");
  });

  await check("analyzeSdk: Cache Keeper's own messages are not yours (also with a <reminder> appended)", () => {
    const ka = core.KEEPALIVES[0];
    const log = sdkChatLog(now - 60000) + sdkTurn(now - 20000, ka, { input: 150700, read: 150000, out: 4, dur: 500 })
      .map(e => JSON.stringify(e)).join("\n") + "\n";
    const s = core.analyzeSdk("/x/s", log, {}, now);
    assert.strictEqual(s.lastUserText, ka);
    assert.ok(s.lastRealUserTs < now - 50000, "the keep-alive is not counted as your message");
    assert.strictEqual(s.stats.turns, 1);
  });

  await check("readSdkSessions: only VS Code SDK chats, not Copilot CLI sessions", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ck-home-"));
    try {
      for (const [id, yaml] of [["a", "client_name: vscode-agent-host\ncwd: /w"], ["b", "cwd: /w"]]) {
        const d = path.join(home, ".copilot", "session-state", id);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, "workspace.yaml"), `id: ${id}\n${yaml}\n`);
        fs.writeFileSync(path.join(d, "events.jsonl"), sdkChatLog(now - 60000));
      }
      const r = await core.readSdkSessions(core.nodeIo, home, now);
      assert.deepStrictEqual(r.map(s => s.id), ["a"]);
      assert.strictEqual(r[0].cwd, "/w");
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  await check("sdkChatOwner: this window's folders, other folders, chats without a folder", () => {
    const o = (cwd, folders, win) => core.sdkChatOwner({ cwd }, folders, win);
    assert.strictEqual(o("/home/u/proj", ["/home/u/proj"]), "window");
    assert.strictEqual(o("/home/u/proj/sub", ["/home/u/proj"]), "window");
    assert.strictEqual(o("/home/u/project2", ["/home/u/proj"]), "", "a sibling folder with a longer name is not inside");
    assert.strictEqual(o("/home/u/other", ["/home/u/proj"]), "");
    assert.strictEqual(o("/home/u/.copilot/chats/83082f29", ["/home/u/proj"]), "workspaceless");
    assert.strictEqual(o("c:\\Users\\Me\\.copilot\\chats\\f8cb3cb8", [], true), "workspaceless");
    assert.strictEqual(o("C:\\Work\\Proj", ["c:\\work\\proj"], true), "window", "Windows paths: case-insensitive");
    assert.strictEqual(core.sdkChatOwner({ cwd: "/tmp/wt", gitRoot: "/home/u/proj" }, ["/home/u/proj"]), "window", "git root counts");
  });

  await check("sqlite: agent-host.db names SDK chats (b-tree, overflow pages, write-ahead log)", () => {
    const sqlite = require("../sqlite");
    const fx = f => fs.readFileSync(path.join(__dirname, "fixtures", f));
    const m = sqlite.sdkChatIds(fx("agent-host.db"), null);
    assert.strictEqual(m.size, 60);
    assert.strictEqual(m.get("sdk-0007"), "vsc-0007", "row larger than a page");
    assert.strictEqual(m.get("sdk-0059"), "vsc-0059");
    assert.ok(!m.has("claude-sdk"), "only Copilot (copilotcli) chats");
    const w = sqlite.sdkChatIds(fx("agent-host-wal.db"), fx("agent-host-wal.db-wal"));
    assert.strictEqual(w.get("sdk-new"), "vsc-new", "row still in the -wal file");
    assert.strictEqual(w.get("sdk-old"), "vsc-old");
    assert.ok(!sqlite.sdkChatIds(fx("agent-host-wal.db"), null).has("sdk-new"));
    assert.strictEqual(sqlite.sdkChatIds(Buffer.from("not a database"), null).size, 0);
  });

  await check("measured lifetimes: a cache hit after a long pause in a Local chat proves a minimum", () => {
    const t0 = now - 7200000;
    const call = (ts, model, input, cached, debugName = "panel/editAgent") =>
      ({ type: "llm_request", ts, dur: 1000, attrs: { debugName, model, inputTokens: input, cachedTokens: cached, outputTokens: 10 } });
    const log = evs => evs.map(e => JSON.stringify(e)).join("\n");
    // own part of the chat (70k - 30k) cached after 1100 s: proof of >= 1100 s
    assert.deepStrictEqual(core.gapsFromLog(log([call(t0, "kimi-x", 30000, 0), call(t0 + 5000, "kimi-x", 70000, 29000),
      call(t0 + 5000 + 1100000, "kimi-x", 71000, 70000)])), { "kimi-x": 1100 });
    // only the shared system prompt cached (own part not): no proof
    assert.deepStrictEqual(core.gapsFromLog(log([call(t0, "kimi-x", 30000, 0), call(t0 + 1100000, "kimi-x", 33000, 30000)])), {});
    // another call of that model in between also refreshed the cache: the gap counts from it
    assert.deepStrictEqual(core.gapsFromLog(log([call(t0, "kimi-x", 30000, 0), call(t0 + 5000, "kimi-x", 70000, 29000),
      call(t0 + 600000, "kimi-x", 2000, 0, "title"), call(t0 + 5000 + 1100000, "kimi-x", 71000, 70000)])), { "kimi-x": 505 });
    try {
      core.setMeasuredTtls({ "kimi-x": 1100, "claude-opus-5.5": 307 });
      assert.strictEqual(core.ttlFor("kimi-x"), 1080, "rounded down to the minute");
      assert.strictEqual(core.ttlSource("kimi-x"), "measured in your chats");
      assert.strictEqual(core.ttlFor("claude-opus-5.5"), 300, "a few seconds over the default is call latency, not a longer cache");
      assert.strictEqual(core.ttlFor("kimi-x", { "kimi-x": 200 }), 200, "a setting wins");
    } finally { core.setMeasuredTtls({}); }
  });

  await check("learnTtls: reads several homes (Windows and the remote side), newest session wins", async () => {
    const mk = (age, model, ttl) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "ck-ttl-"));
      const d = path.join(home, ".copilot", "session-state", "s");
      fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, "events.jsonl");
      fs.writeFileSync(f, `{"modelCacheState":[{"modelId":"${model}","cacheExpiresAt":"x","cacheTtlSeconds":${ttl}}]}\n`);
      const t = (Date.now() - age) / 1000; fs.utimesSync(f, t, t);
      return home;
    };
    const a = mk(60000, "multi-home-model", 600), b = mk(1000, "multi-home-model", 900);
    try {
      const r = await core.learnTtls([{ io: core.nodeIo, home: a }, { io: core.nodeIo, home: b }]);
      assert.strictEqual(r.ttls["multi-home-model"], 900);
      assert.strictEqual(r.dirs.length, 2);
    } finally { [a, b].forEach(h => fs.rmSync(h, { recursive: true, force: true })); }
  });

  await check("learnTtls: newest exact value wins (shorter too), per call or at checkpoints, and applies to Local chats", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ck-ttl-"));
    const resetLearned = () => core.learnTtls([], undefined, 30, 30, Date.now() + 1000 * 86400000);
    try {
      const d = path.join(home, ".copilot", "session-state");
      const put = (name, lines) => { fs.mkdirSync(path.join(d, name), { recursive: true });
        fs.writeFileSync(path.join(d, name, "events.jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n"); };
      // an SDK chat: a checkpoint said 300 s two days ago...
      put("sdk", [{ type: "session.usage_checkpoint", timestamp: iso(now - 2 * 86400000),
                    data: { modelCacheState: [{ modelId: "claude-opus-5.5", cacheExpiresAt: "x", cacheTtlSeconds: 300 }] } }]);
      // ...then a Copilot CLI call an hour ago reported a shorter lifetime (in a usage record, not a checkpoint)
      put("cli", [{ type: "session.usage_record", timestamp: iso(now - 3600000),
                    data: { usage: { model: "claude-opus-5.5", inputTokens: 1000, cacheTtlSeconds: 240 } } }]);
      const r = await core.learnTtls(core.nodeIo, home, 30, 30, now);
      assert.strictEqual(r.ttls["claude-opus-5.5"], 240, "newest wins, even when shorter");
      assert.ok(r.ages["claude-opus-5.5"] >= 3600000 - 1000);
      // a Local chat of that model uses it: same backend
      const s = core.analyze("/logs/x", chatLog(now - 60000), MODELS, now);
      assert.strictEqual(s.ttl, 240);
      assert.strictEqual(s.ttlFrom, "Copilot CLI/SDK log");
      // an SDK chat still goes by its own log
      assert.strictEqual(core.analyzeSdk("/x/s", sdkChatLog(now - 60000), {}, now).ttl, 300);
    } finally { await resetLearned(); fs.rmSync(home, { recursive: true, force: true }); }
  });

  await check("learnTtls: values older than the cutoff are not used, also ones learned earlier", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ck-ttl-"));
    const resetLearned = () => core.learnTtls([], undefined, 30, 30, Date.now() + 1000 * 86400000);
    try {
      const d = path.join(home, ".copilot", "session-state", "s");
      fs.mkdirSync(d, { recursive: true });
      // the file changed recently, but the event inside is 40 days old
      fs.writeFileSync(path.join(d, "events.jsonl"), JSON.stringify({ type: "session.usage_record", timestamp: iso(now - 40 * 86400000),
        data: { usage: { model: "old-model-x", cacheTtlSeconds: 900 } } }) + "\n");
      assert.strictEqual((await core.learnTtls(core.nodeIo, home, 30, 30, now)).ttls["old-model-x"], undefined);
      assert.strictEqual(core.ttlFor("old-model-x"), 300, "default");
      assert.strictEqual((await core.learnTtls(core.nodeIo, home, 30, 60, now)).ttls["old-model-x"], 900, "longer cutoff: used");
      assert.strictEqual(core.LIFETIME_MAX_AGE_DAYS, 60, "default cutoff");
      assert.strictEqual((await core.learnTtls(core.nodeIo, home, 30, undefined, now)).ttls["old-model-x"], 900, "40 days old: within the default");
      // learned earlier, then it ages past the cutoff: dropped, back to the default
      fs.rmSync(d, { recursive: true });
      await core.learnTtls(core.nodeIo, home, 30, 60, now + 25 * 86400000);
      assert.strictEqual(core.ttlFor("old-model-x"), 300);
    } finally { await resetLearned(); fs.rmSync(home, { recursive: true, force: true }); }
  });

  await check("extension: SDK chat in this folder gets its keep-alive, sent to agent-host-copilotcli:/<VS Code id>", async () => {
    const h = await harness({ kind: "sdk", answer: () => "Keep warm" });
    try {
      await h.run(300, () => h.sent.length > 0);
      assert.strictEqual(h.warnings.length, 1, "warned once");
      assert.strictEqual(h.sent.length, 1, "one keep-alive");
      assert.ok(core.isKeepAlive(h.sent[0].text));
      const open = h.ran.find(r => r.id === "workbench.action.chat.openSessionInEditorGroup");
      assert.strictEqual(open.a.resource.scheme, "agent-host-copilotcli");
      assert.strictEqual(open.a.resource.path, "/vsc-0007", "VS Code's id from agent-host.db, not the log folder's");
      await h.run(10);
      await h.commands["cacheKeeper.options"]();
      assert.ok(h.lists.at(-1)[0].description.startsWith("Copilot SDK"), h.lists.at(-1)[0].description);
    } finally { h.close(); }
  });

  await check("Fusion: only models used since your last message count; cost of a cold message from the costliest", () => {
    const now = Date.now(), m = 60000;
    const P = { sol: { input: 140, cache_read: 7, cache_write: 175, output: 700 }, luna: { input: 7, cache_read: 0.7, cache_write: 8.75, output: 35 } };
    const use = (t, model, input, read) => { const u = sdkUsage(t, 1000, { model, input, read, ttl: 1800, auto: true });
      u.data.usage.copilotUsage.tokenDetails = Object.entries(P[model === "gpt-6.1-sol" ? "sol" : "luna"])
        .map(([k, v]) => ({ batchSize: 1e6, costPerBatch: v * 1e9, tokenType: k, tokenCount: 1 })); return u; };
    const turn = (t, text, model, input, read) => [ev("user.message", t, { content: text }), ev("assistant.turn_start", t + 5),
      use(t + 10, model, input, read), ev("assistant.turn_end", t + 1100), ev("session.usage_checkpoint", t + 1110)];
    const ka = core.KEEPALIVES_BY_LANG.it[1];
    // you write (sol answers), 26 min later a keep-alive goes to luna: both models count
    let log = [ev("session.start", now - 40 * m), ...turn(now - 28 * m, "Confronta le cartelle", "gpt-6.1-sol", 121000, 15000),
               ...turn(now - 2 * m, ka, "gpt-6-luna", 93000, 0)].map(e => JSON.stringify(e)).join("\n") + "\n";
    let x = core.analyzeSdk("/x/fusion", log, {}, now);
    assert.strictEqual(x.routed, true);
    assert.deepStrictEqual(x.models, ["gpt-6.1-sol", "gpt-6-luna"]);
    // worst case: sol (the costlier) cold, at most what the next message re-sends (93k now)
    assert.ok(Math.abs(x.cost.missExtra - 93000 * (175 - 7) / 1e6) < 0.01, String(x.cost.missExtra));
    assert.strictEqual(x.lastMsgCall.firstForModel, true);     // the keep-alive: luna's first call, not a miss
    // a new message from you: only the models used since then count
    log += [...turn(now - 1 * m, "Vai avanti", "gpt-6-luna", 95000, 93000)].map(e => JSON.stringify(e)).join("\n") + "\n";
    x = core.analyzeSdk("/x/fusion", log, {}, now);
    assert.deepStrictEqual(x.models, ["gpt-6-luna"]);
    assert.ok(Math.abs(x.cost.missExtra - 95000 * (8.75 - 0.7) / 1e6) < 0.01, String(x.cost.missExtra));
  });

  await check("Fusion (auto model) SDK chat: no countdown, no pop-ups, nothing automatic; Summarize on request", async () => {
    const now = Date.now();
    assert.strictEqual(core.analyzeSdk("/x/f", sdkChatLog(now - 60000, { auto: true }), {}, now).routed, true);
    assert.strictEqual(core.analyzeSdk("/x/f", sdkChatLog(now - 60000), {}, now).routed, false);
    const h = await harness({ kind: "sdk", sdkAuto: true, answer: never, ctx: 150000, settings: { thresholdTokens: 30000 } });
    try {
      await h.run(250);
      assert.ok(/^\$\(versions\) Fusion · 150k/.test(h.status.text), h.status.text);
      assert.ok(/no countdown, no keep-warm, nothing automatic/.test(h.status.tooltip.value), h.status.tooltip.value);
      await h.run(150);                 // past the lifetime: no warning, no automatic summary, no expired notice
      assert.strictEqual(h.warnings.length, 0, "no expiry warning");
      assert.strictEqual(h.sent.length, 0, "nothing sent on its own");
      assert.ok(!h.infos.some(m => /cache expired/.test(m)), h.infos.join(" | "));
      assert.ok(/^\$\(versions\) Fusion/.test(h.status.text), h.status.text);
      await h.commands["cacheKeeper.keepWarmNow"]();
      assert.strictEqual(h.sent.length, 0, "no keep-alive");
      assert.ok(h.infos.some(m => /no keep-warm for .*Fusion picks the model/.test(m)), h.infos.join(" | "));
      await h.commands["cacheKeeper.options"]();
      assert.ok(h.lists.at(-1).some(i => /Fusion/.test(i.label)), "listed");
      await h.commands["cacheKeeper.summaryNow"]();   // on request: sent, no cost question about an expired cache
      assert.ok(h.sent.some(x => x.text.includes("handoff summary")), h.sent.map(x => x.text).join(" | "));
    } finally { h.close(); }
  });

  await check("extension: SDK keep-alive goes out within the lead before the expiry in the log", async () => {
    const h = await harness({ kind: "sdk", answer: () => "Keep warm" });
    try {
      const expiry = h.cacheFrom + 300000;
      await h.run(300, () => h.sent.length > 0);
      const lead = (expiry - h.sent[0].at) / 1000;
      assert.ok(lead > 1.5 && lead <= 9, `sent ${lead} s before expiry`);
    } finally { h.close(); }
  });

  await check("extension: SDK chat of another folder is left to its window", async () => {
    const h = await harness({ kind: "sdk", sdkCwd: "/somewhere/else", answer: () => "Keep warm" });
    try {
      await h.run(300);
      assert.strictEqual(h.warnings.length, 0);
      assert.strictEqual(h.sent.length, 0);
    } finally { h.close(); }
  });

  await check("extension: SDK chat without a folder: claimed by one window, named from its folder", async () => {
    const h = await harness({ kind: "sdk", sdkId: "sdk-unmapped", sdkCwd: "/home/u/.copilot/chats/vsc-from-cwd", answer: () => "Keep warm" });
    try {
      await h.run(300, () => h.sent.length > 0);
      assert.strictEqual(h.sent.length, 1);
      const open = h.ran.find(r => r.id === "workbench.action.chat.openSessionInEditorGroup");
      assert.strictEqual(open.a.resource.path, "/vsc-from-cwd");
      assert.ok(fs.existsSync(path.join(h.globalStorage, "local.copilot-cache-keeper", "sdk-claims", "sdk-unmapped")), "claim file written");
    } finally { h.close(); }
  });

  await check("extension: SDK chat without a folder claimed by another window is left alone", async () => {
    const h = await harness({ kind: "sdk", sdkId: "sdk-unmapped", sdkCwd: "/home/u/.copilot/chats/vsc-x", answer: () => "Keep warm" });
    try {
      const claim = path.join(h.globalStorage, "local.copilot-cache-keeper", "sdk-claims", "sdk-unmapped");
      // the other window keeps refreshing its claim
      for (let i = 0; i < 60; i++) { fs.writeFileSync(claim, `otherwin ${h.clock}`); await h.run(5); }
      assert.strictEqual(h.warnings.length, 0);
      assert.strictEqual(h.sent.length, 0);
    } finally { h.close(); }
  });

  await check("extension: SDK chat without a folder and not in agent-host.db: no send, no wrong chat", async () => {
    const h = await harness({ kind: "sdk", sdkId: "sdk-unknown", sdkCwd: "/w/proj", answer: () => "Keep warm" });
    try {
      // the window has the folder open, but VS Code's id for the chat can't be found
      await h.run(300);
      assert.strictEqual(h.sent.length, 0, "nothing submitted");
      assert.ok(!h.ran.some(r => r.id === "workbench.action.chat.submit"));
    } finally { h.close(); }
  });

  await check("cacheKeeper.expiredChats: how many expired chats the list keeps", async () => {
    // the chat where you last typed, plus 6 expired ones; default keeps 5 of them
    for (const [n, want] of [[0, 1], [1, 2], [2, 3], [undefined, 6]]) {
      const h = await harness({ answer: never, settings: n === undefined ? {} : { expiredChats: n } });
      try {
        for (let i = 1; i <= 6; i++) {
          const d = path.join(h.logs, `old-${i}`);
          fs.mkdirSync(d);
          fs.writeFileSync(path.join(d, "models.json"), MODELS);
          fs.writeFileSync(path.join(d, "main.jsonl"), chatLog(h.clock - 3600000 - i * 60000, { ctx: 40000 }));
        }
        await h.run(6);
        await h.commands["cacheKeeper.options"]();
        assert.strictEqual(h.lists.at(-1).length, want, `expiredChats ${n}: ${h.lists.at(-1).map(i => i.label).join(" | ")}`);
      } finally { h.close(); }
    }
  });

  await check("cacheKeeper.lookbackHours: older chats are not read (default 48 h)", async () => {
    for (const [settings, want] of [[{ lookbackHours: 1 }, 1], [{}, 2]]) {
      const h = await harness({ answer: never, settings });
      try {
        const d = path.join(h.logs, "old-3h");
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, "models.json"), MODELS);
        fs.writeFileSync(path.join(d, "main.jsonl"), chatLog(h.clock - 3 * 3600000, { ctx: 40000 }));
        const t = (h.clock - 3 * 3600000) / 1000; fs.utimesSync(path.join(d, "main.jsonl"), t, t);
        await h.run(6);
        await h.commands["cacheKeeper.options"]();
        assert.strictEqual(h.lists.at(-1).length, want, JSON.stringify(settings));
      } finally { h.close(); }
    }
  });


  // ---------------------------------------------------------------- spend report
  const report = require("../report");
  await check("spend report: billed credits, Claude scaled to its bill, Codex priced, an expired cache found and costed", () => {
    const sheet = { batch_size: 1e6, default: { cache_read_price: 50, cache_write_price: 625, input_price: 500, output_price: 2500 } };
    const t0 = now - 3 * 3600000;
    const local = { kind: "local", id: "l1", title: "Refactor", workspace: "app", sheetFor: () => sheet, events: [
      { t: "call", ts: t0, end: t0 + 1000, model: "claude-opus-5.5", input: 120000, cached: 0, out: 500, credits: 50 },
      // 20 min later: the 300 s cache has expired, the whole prompt is sent again
      { t: "call", ts: t0 + 1200000, end: t0 + 1201000, model: "claude-opus-5.5", input: 121000, cached: 0, out: 500, credits: 51 }] };
    const claude = { kind: "claude", id: "c1", title: "Fix tests", sheetFor: () => sheet, billed: 3, events: [
      { t: "call", ts: t0, end: t0 + 1000, model: "claude-haiku-5.5", input: 20000, cached: 0, out: 100 },
      { t: "call", ts: t0 + 60000, end: t0 + 61000, model: "claude-haiku-5.5", input: 21000, cached: 20000, out: 100 }] };
    const codex = { kind: "codex", id: "x1", title: "Port", sheetFor: () => sheet, events: [
      { t: "call", ts: t0, end: t0 + 1000, model: "gpt-6.1-sol", input: 10000, cached: 0, out: 100 }] };
    const old = { kind: "local", id: "l0", sheetFor: () => sheet, events: [{ t: "call", ts: now - 90 * 86400000, model: "m", input: 1, credits: 999 }] };
    const a = report.analyzeSpend([local, claude, codex, old], { since: now - 60 * 86400000, now });
    const codexCr = 10000 * 625 / 1e6 + 100 * 2500 / 1e6;
    assert.ok(Math.abs(a.total - (101 + 3 + codexCr)) < 1e-6, String(a.total));
    assert.strictEqual(a.calls, 5, "the 90-day-old call is outside 60 days");
    const exp = a.factors.find(f => /Expired/.test(f.name));
    assert.strictEqual(exp.count, 1);
    assert.ok(Math.abs(exp.credits - (121000 - 1000) * (625 - 50) / 1e6) < 1e-6, String(exp.credits));
    assert.strictEqual(a.topMisses[0].chat, "Refactor");
    const md = report.spendMarkdown(a, { days: 60, where: ["Local chats: 2"] });
    for (const h2 of ["# Copilot spend, last 60 days", "## What drove it", "## By harness and model", "## Costliest cache misses", "## Costliest chats"])
      assert.ok(md.includes(h2), h2);
    assert.ok(!/Warning/.test(md), "all priced");
  });

  await check("spend report: every factor of the Python helper (effort, tier, MCP, compactions, subagents); SDK rates read, no NaN", () => {
    const sheet = { batch_size: 1e6, base: { max_prompt_tokens: 272000, cache_read_price: 50, cache_write_price: 625, output_price: 2500 },
                    long: { max_prompt_tokens: 1e6, cache_read_price: 100, cache_write_price: 1250, output_price: 5000 } };
    const t0 = now - 3 * 3600000;
    const local = { kind: "local", id: "l1", title: "Big", sheetFor: () => sheet, mcpFrac: 0.5, toolShares: [{ ts: t0, share: 0.4 }], events: [
      { t: "user", ts: t0, text: "go" },
      { t: "call", ts: t0 + 10, end: t0 + 1000, model: "m", input: 300000, cached: 290000, out: 1000, credits: 20, effort: "medium" },
      { t: "call", ts: t0 + 2000, end: t0 + 3000, model: "m", input: 300000, cached: 299000, out: 9000, credits: 25, effort: "max" },
      { t: "aux", ts: t0 + 4000, model: "m", input: 5000, cached: 0, out: 900, credits: 2, summary: true },
      { t: "aux", ts: t0 + 5000, model: "m", input: 800, cached: 0, out: 10, credits: 0.1 }],
      subEvents: [{ t: "call", ts: t0 + 6000, model: "m", input: 9000, cached: 0, out: 100, credits: 1.5 }] };
    // a Copilot SDK chat priced from its own log (cache_read, cache_write, input, output): a miss mid-chat
    const rates = { cache_read: 0.00005, cache_write: 0.000625, input: 0.0005, output: 0.0025 };
    const sdk = { kind: "sdk", id: "s1", events: [
      { t: "call", ts: t0, model: "x", input: 60000, cached: 0, out: 10, credits: 40, rates },
      { t: "call", ts: t0 + 60000, model: "x", input: 61000, cached: 0, out: 10, credits: 40, rates },
      { t: "compaction", ts: t0 + 70000 }] };
    const a = report.analyzeSpend([local, sdk], { since: 0, now });
    const f = n => a.factors.find(x => x.name.startsWith(n));
    for (const x of a.factors) assert.ok(Number.isFinite(x.credits), `${x.name}: ${x.credits}`);
    assert.ok(Math.abs(f("Other cache misses").credits - (61000 - 1000) * (0.000625 - 0.00005)) < 1e-9, "SDK miss priced from its log");
    assert.ok(Math.abs(f("Max / xhigh").credits - 8000 * 2500 / 1e6) < 1e-9, String(f("Max / xhigh").credits));   // at the base price, like the Python helper
    assert.ok(f("Long-context").credits > 0 && f("Long-context").count === 2);
    assert.ok(Math.abs(f("MCP tool").credits - 2 * 300000 * 0.4 * 0.5 * 100 / 1e6) < 1e-9, String(f("MCP tool").credits));
    assert.strictEqual(f("Compactions").credits, 2);
    assert.strictEqual(f("Compactions").count, 2, "the Local summarizing call and the SDK compaction");
    assert.ok(Math.abs(f("Subagents").credits - 1.6) < 1e-9);
    assert.ok(Math.abs(a.total - (20 + 25 + 2 + 0.1 + 1.5 + 80)) < 1e-9, String(a.total));
    assert.ok(/## Reasoning effort/.test(report.spendMarkdown(a, { days: 60 })));
  });

  await check("spend report: a Copilot SDK session's billed total beyond its calls counts as its compaction", () => {
    const t0 = now - 3600000;
    const sdk = { kind: "sdk", id: "s1", billedTotal: 14, events: [
      { t: "call", ts: t0, model: "gpt-6.1-sol", input: 20000, cached: 0, out: 10, credits: 4 },
      { t: "call", ts: t0 + 60000, model: "gpt-6.1-sol", input: 21000, cached: 20000, out: 10, credits: 2 },
      { t: "compaction", ts: t0 + 120000 }] };
    const a = report.analyzeSpend([sdk], { since: 0, now });
    assert.strictEqual(a.total, 14, "the session's billed total");
    assert.strictEqual(a.factors.find(f => f.name === "Compactions").credits, 8);
  });

  await check("spend report: a Copilot SDK session with only a billed total (older SDK) still counts", () => {
    const log = [JSON.stringify({ type: "user.message", timestamp: iso(now - 7200000), data: { content: "Help me" } }),
                 JSON.stringify({ type: "session.usage_checkpoint", timestamp: iso(now - 7000000), data: { totalNanoAiu: 36e9 } })].join("\n");
    const t = report.sdkSessionTotal(log);
    assert.deepStrictEqual(t, { total: 36, lastTs: now - 7200000 });
    const a = report.analyzeSpend([{ kind: "sdk", id: "old", events: [], billedTotal: t.total, lastTs: t.lastTs }], { since: 0, now });
    assert.strictEqual(a.total, 36);
  });

  await check("spend report: a call with no known price is warned about, not a crash", () => {
    const a = report.analyzeSpend([{ kind: "sdk", id: "s1", events: [
      { t: "call", ts: now - 1000, model: "mystery-1", input: 50000, cached: 0, out: 10 }] }], { since: 0, now });
    assert.strictEqual(a.unpriced, 1);
    assert.ok(/Warning:\*\* 1 model call\(s\) have no known price \(mystery-1\)/.test(report.spendMarkdown(a, { days: 60 })));
  });

  // VS Code's chat file: the initial state, then a request appended, then a field set (its op log)
  const chatFile = (t0, msgs) => [
    JSON.stringify({ kind: 0, v: { requests: [] } }),
    JSON.stringify({ kind: 2, k: ["requests"], v: msgs.map((m, i) => ({ timestamp: t0 + m.at * 1000, message: { text: m.text || `step ${i}` },
      modelId: "copilot/claude-opus-5.5", promptTokens: m.prompt, completionTokens: 200 })) }),
    ...msgs.map((m, i) => JSON.stringify({ kind: 1, k: ["requests", i, "elapsedMs"], v: 20000 })),
    ...msgs.map((m, i) => JSON.stringify({ kind: 1, k: ["requests", i, "copilotCredits"], v: m.credits }))].join("\n") + "\n";

  // the same chat as one object: a .json chat file (VS Code before 1.109, or chat.useLogSessionStorage off)
  const flatChatFile = (t0, msgs) => JSON.stringify({ version: 3, requests: msgs.map((m, i) => ({
    timestamp: t0 + m.at * 1000, message: { text: m.text || `step ${i}` }, modelId: "copilot/claude-opus-5.5",
    promptTokens: m.prompt, completionTokens: 200, elapsedMs: 20000, copilotCredits: m.credits })) }, null, 2);

  await check("chat files: a whole-chat .json file reads like an op log; messages with no credits are counted as left out", () => {
    const t0 = now - 7200000, msgs = [{ at: 0, prompt: 90000, credits: 40, text: "Flat chat" }, { at: 60, prompt: 91000, credits: 6 }];
    const flat = report.chatFileMessages([flatChatFile(t0, msgs)]);
    const log = report.chatFileMessages([chatFile(t0, msgs)]);
    assert.strictEqual(flat.title, "Flat chat");
    assert.deepStrictEqual(flat.events, log.events);
    const noCredits = report.chatFileMessages([chatFile(t0, [{ at: 0, prompt: 90000, credits: undefined }, { at: 60, prompt: 1, credits: 3 }])]);
    assert.strictEqual(noCredits.events.length, 1);
    assert.strictEqual(noCredits.unbilled, 1);
    assert.strictEqual(report.chatFileMessages([chatFile(t0, [{ at: 0, prompt: 90000, credits: undefined }])], now).unbilled, 0, "before the period");
  });

  await check("chat files: replayed per message, copies merged, a pause past the lifetime is an expired cache", () => {
    const t0 = now - 7200000;
    const text = chatFile(t0, [{ at: 0, prompt: 90000, credits: 40, text: "Port the parser" }, { at: 60, prompt: 91000, credits: 6 },
                               { at: 1800, prompt: 92000, credits: 45 }]);
    const m = report.chatFileMessages([text, text]);
    assert.strictEqual(m.title, "Port the parser");
    assert.strictEqual(m.events.length, 3, "copies merged");
    assert.strictEqual(m.events[2].gap, 1800 - 60 - 20, "pause since the previous message ended");
    const sheet = { batch_size: 1e6, default: { cache_read_price: 50, cache_write_price: 625, output_price: 2500 } };
    const a = report.analyzeSpend([{ kind: "local-msg", id: "old", title: m.title, events: m.events, sheetFor: () => sheet }], { since: 0, now });
    assert.strictEqual(a.total, 91);
    const exp = a.factors.find(f => /Expired/.test(f.name));
    assert.strictEqual(exp.count, 1, "only the message after the long pause");
    assert.ok(/\| Local, per message \| claude-opus-5\.5 \| 3 msgs \|/.test(report.spendMarkdown(a, { days: 60 })));
  });

  await check("spend report command: asks the days (60), reads Local logs and older chat files, saves the file, shows its preview", async () => {
    const h = await harness({ answer: never });
    try {
      await h.run(5);
      // chat files on the UI side: an older chat (no debug log left), and the current one (has a log: not counted twice)
      const cs = path.join(h.dir, "workspaceStorage", "ws1", "chatSessions");
      fs.mkdirSync(cs, { recursive: true });
      fs.writeFileSync(path.join(cs, "old-chat.jsonl"), chatFile(h.clock - 86400000, [{ at: 0, prompt: 80000, credits: 30, text: "Older work" }]));
      fs.writeFileSync(path.join(cs, "sess-1.jsonl"), chatFile(h.clock - 3600000, [{ at: 0, prompt: 80000, credits: 999 }]));
      // a .json chat file in another workspace, a chat of a window with no folder, and a chat whose
      // debug log has no model call in it (its chat file counts it)
      const cs2 = path.join(h.dir, "workspaceStorage", "ws2", "chatSessions");
      fs.mkdirSync(cs2, { recursive: true });
      fs.writeFileSync(path.join(cs2, "flat-chat.json"), flatChatFile(h.clock - 7200000, [{ at: 0, prompt: 50000, credits: 12, text: "Flat work" }]));
      const empty = path.join(h.dir, "globalStorage", "emptyWindowChatSessions");
      fs.mkdirSync(empty, { recursive: true });
      fs.writeFileSync(path.join(empty, "no-folder.jsonl"), chatFile(h.clock - 7200000, [{ at: 0, prompt: 40000, credits: 7, text: "No folder work" }]));
      const logless = path.join(h.dir, "workspaceStorage", "ws1", "GitHub.copilot-chat", "debug-logs", "logless");
      fs.mkdirSync(logless, { recursive: true });
      fs.writeFileSync(path.join(logless, "main.jsonl"), JSON.stringify({ ts: h.clock - 7000000, type: "user_message", attrs: { content: "hi" } }) + "\n");
      fs.writeFileSync(path.join(cs, "logless.jsonl"), chatFile(h.clock - 7200000, [{ at: 0, prompt: 30000, credits: 5, text: "Logless work" },
                                                                                  { at: 100, prompt: 31000, credits: undefined }]));
      // its "saved" notification is never clicked: the command must still finish
      h.vscode.window.showInformationMessage = () => new Promise(() => {});
      const done = await Promise.race([h.commands["cacheKeeper.spendReport"]().then(() => true),
                                       new Promise(r => setTimeout(() => r(false), 5000))]);
      assert.ok(done, "the command did not wait for the notification");
      const shown = h.ran.find(r => r.id === "markdown.showPreview");
      assert.ok(shown && /spend-report-\d{4}-\d\d-\d\d-60d\.md$/.test(shown.a.fsPath), "preview of the saved file");
      assert.ok(!h.opened.length, "no unsaved document");
      const md = fs.readFileSync(shown.a.fsPath, "utf8");
      assert.ok(/^# Copilot spend, last 60 days/.test(md), md.slice(0, 200));
      assert.ok(/\| Local \| claude-opus-5\.5 \|/.test(md), md);
      assert.ok(/\| Older work \| Local, per message \|/.test(md), "the older chat, from its chat file");
      assert.ok(!/999/.test(md), "the chat with a debug log is not counted again from its chat file");
      assert.ok(/\| Flat work \| Local, per message \|/.test(md), "a .json chat file");
      assert.ok(/\| No folder work \| Local, per message \| \(no folder\) \|/.test(md), "a chat of a window with no folder");
      assert.ok(/\| Logless work \| Local, per message \|/.test(md), "a debug log with no model call does not hide the chat file");
      assert.ok(/Local chats with no debug log: 4, .*; 1 message\(s\) left out: VS Code recorded no credits for them/.test(md), "where it read");
    } finally { h.close(); }
  });

  await check("spend report from a Windows window: running WSL distros are read too; prices from there when this window has none", async () => {
    const h = await harness({ kind: "codex", answer: never, noPrices: true });
    try {
      await h.run(5);
      // a WSL distro's VS Code server, with a Local chat's debug log (and Copilot's price sheet)
      const home = path.join(h.dir, "wsl", "home", "dev");
      const dl = path.join(home, ".vscode-server", "data", "User", "workspaceStorage", "wsl-ws", "GitHub.copilot-chat", "debug-logs", "wsl-chat");
      fs.mkdirSync(dl, { recursive: true });
      fs.writeFileSync(path.join(dl, "main.jsonl"), chatLog(h.clock - 3600000, { ctx: 60000 }));
      fs.writeFileSync(path.join(dl, "models.json"), MODELS);
      // its chat file stays on Windows: counted once, from the log
      const cs = path.join(h.dir, "workspaceStorage", "ws1", "chatSessions");
      fs.mkdirSync(cs, { recursive: true });
      fs.writeFileSync(path.join(cs, "wsl-chat.jsonl"), chatFile(h.clock - 3600000, [{ at: 0, prompt: 80000, credits: 999 }]));
      const homes = [{ distro: "Ubuntu", home }];
      homes.stopped = ["Debian"];
      h.ext._spendHooks.wslHomes = async () => homes;
      h.vscode.window.showInformationMessage = () => new Promise(() => {});
      await h.commands["cacheKeeper.spendReport"](60);
      const md = fs.readFileSync(h.ran.find(r => r.id === "markdown.showPreview").a.fsPath, "utf8");
      assert.ok(/WSL Ubuntu \(dev\): Local chats: 1, in /.test(md), md);
      assert.ok(/WSL distros not running, not read: Debian/.test(md), "stopped distros are named");
      assert.ok(!/999/.test(md), "the WSL chat's file on Windows is not counted again");
      assert.ok(/Copilot prices: .*wsl-chat.models\.json/.test(md), "the price sheet read there");
      assert.ok(/\| Codex \| gpt-6\.1-sol \|/.test(md) && !/no known price/.test(md), "the Codex chat is priced");
    } finally { h.close(); }
  });

  await check("spend report in a window with no folder open: Copilot's prices found in other workspaces, right after it opens", async () => {
    for (const kind of ["claude", "codex"]) {
      const h = await harness({ kind, answer: never, noFolder: true });
      try {
        await h.run(5);
        h.vscode.window.showInformationMessage = () => new Promise(() => {});
        await h.commands["cacheKeeper.spendReport"](60);
        const md = fs.readFileSync(h.ran.find(r => r.id === "markdown.showPreview").a.fsPath, "utf8");
        assert.ok(/Copilot prices: .*price-src.models\.json/.test(md), md.slice(md.indexOf("Read:")));
        assert.ok(!/no known price/.test(md) && !/\*\*0\.00 credits\*\*/.test(md), md.split("\n")[2]);
      } finally { h.close(); }
    }
  });

  // ---------------------------------------------------------------- Claude and Codex harnesses
  const harnesses = require("../harnesses");
  const ALL_KINDS = [["local", {}], ["sdk", {}], ["claude", {}], ["codex", { ttlSeconds: { "gpt-6.1-sol": 300 } }]];
  const priceFor = m => core.priceSheetFrom(MODELS, m);
  const lines = evs => evs.map(e => JSON.stringify(e)).join("\n") + "\n";

  await check("Claude log: same chat state as the other harnesses (timer, lifetime, costs, title)", () => {
    const s = core.analyzeTrace("claude", "/c/claude-sdk-1.jsonl", harnesses.claudeTrace(claudeChatLog(now - 60000)), { now, priceFor });
    assert.ok(s);
    assert.strictEqual(s.model, "claude-opus-5.5", "Anthropic name mapped to Copilot's");
    assert.strictEqual(s.ttl, 300);
    assert.strictEqual(s.ttlFrom, "this chat's log");
    assert.strictEqual(s.cacheFrom, now - 60000 + 4000, "cache refreshed when the request was sent (api-request), not when the reply ended");
    assert.strictEqual(s.busy, false);
    assert.strictEqual(s.ctx, 150000);
    assert.ok(s.cost && s.cost.missExtra > 60 && s.cost.missExtra < 75, String(s.cost && s.cost.missExtra));
    assert.strictEqual(s.title, "Refactor the parser");
    assert.strictEqual(s.stats.turns, 1, "a tool result is not your message");
    assert.strictEqual(s.creditsEstimated, true, "no credits in Claude's log: estimated from Copilot's prices");
    const billed = core.analyzeTrace("claude", "/c/x.jsonl", harnesses.claudeTrace(claudeChatLog(now - 60000)), { now, priceFor, credits: 70 });
    assert.strictEqual(billed.credits, 70);
    assert.strictEqual(billed.creditsEstimated, false);
  });

  await check("Claude log: busy while a tool runs or a message waits; idle after end_turn or a stop; 1-hour cache", () => {
    const base = claudeChatLog(now - 60000);
    const busy = extra => core.analyzeTrace("claude", "/c/x", harnesses.claudeTrace(base + lines(extra)), { now, priceFor }).busy;
    assert.strictEqual(busy([cl("queue-operation", now - 1000, { operation: "enqueue" })]), true, "message queued");
    assert.strictEqual(busy([cl("user", now - 9000, { message: { content: [{ type: "text", text: "go" }] } }),
      ...claudeCall(now - 8990, now - 5000, { input: 151000, read: 150000, stop: "tool_use", id: "t1" })]), true, "tool running");
    assert.strictEqual(busy([cl("user", now - 9000, { message: { content: [{ type: "text", text: "go" }] } }),
      ...claudeCall(now - 8990, now - 5000, { input: 151000, read: 150000, stop: "tool_use", id: "t1" }),
      cl("user", now - 4000, { message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } })]), false, "stopped");
    assert.strictEqual(busy([cl("user", now - 9000, { message: { content: [{ type: "text", text: "go" }] } }),
      ...claudeCall(now - 8990, now - 5000, { input: 151000, read: 150000, id: "t2" })]), false, "turn ended");
    const s = core.analyzeTrace("claude", "/c/x", harnesses.claudeTrace(base + lines(claudeCall(now - 30000, now - 29000,
      { input: 152000, read: 150000, ttl: "1h", id: "t3" }))), { now, priceFor });
    assert.strictEqual(s.ttl, 3600, "1-hour cache tier in the log");
  });

  await check("Claude log: a /compact (local command) is one message, Cache Keeper's own, done when 'Compacted'; the carried-over summary is not a message", () => {
    const base = claudeChatLog(now - 120000);
    const prompt = core.compactPrompt("en"), args = prompt.replace(/^\/compact\s*/, "");
    const t0 = now - 20000;
    const tail = [
      cl("system", t0 + 1230, { subtype: "compact_boundary", compactMetadata: { trigger: "manual" } }),
      cl("user", t0 + 1229, { isCompactSummary: true, isVisibleInTranscriptOnly: true,
        message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." } }),
      cl("user", t0, { isMeta: true, message: { role: "user", content: "<local-command-caveat>The command below was run directly in Claude Code</local-command-caveat>" } }),
      cl("user", t0, { message: { role: "user", content: `<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args>${args}</command-args>` } }),
      cl("user", t0 + 1400, { message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } })];
    const s = core.analyzeTrace("claude", "/c/x", harnesses.claudeTrace(base + lines(tail)), { now, priceFor });
    assert.strictEqual(s.busy, false, "not left busy after the compaction");
    assert.ok(s.compactedAt >= t0, "compaction seen");
    assert.ok(core.isOwnMessage(s.lastUserText), `last message is Cache Keeper's /compact: ${s.lastUserText}`);
    assert.ok(!/being continued/.test(s.lastUserText || ""), "the summary is not a message");
    const mid = core.analyzeTrace("claude", "/c/x", harnesses.claudeTrace(base + lines(tail.slice(2, 4))), { now, priceFor });
    assert.strictEqual(mid.busy, true, "busy while the /compact runs");
  });

  await check("Copilot SDK log: a compaction counts from its start (logged at once), busy until its end", () => {
    const base = sdkChatLog(now - 120000);
    const t0 = now - 20000;
    const started = base + lines([ev("session.compaction_start", t0, { compactionAttemptId: "a1" })]);
    const run = core.analyzeSdk("/x/sdk-1", started, {}, now);
    assert.strictEqual(run.compactStartedAt, t0, "start seen");
    assert.strictEqual(run.busy, true, "busy while it runs");
    const done = core.analyzeSdk("/x/sdk-1", started + lines([ev("session.compaction_complete", t0 + 14000, { success: true, compactionAttemptId: "a1" })]), {}, now);
    assert.strictEqual(done.busy, false, "idle once complete");
    assert.strictEqual(done.compactedAt, t0 + 14000);
  });

  await check("Claude log: a reply streamed in blocks counts once; subagent calls don't move the timer", () => {
    const [req, reply] = claudeCall(now - 30000, now - 29000, { input: 152000, read: 150000, id: "dup" });
    const sub = { ...claudeCall(now - 1000, now - 500, { input: 9000, read: 0, id: "sub" })[1], isSidechain: true };
    const t = harnesses.claudeTrace(claudeChatLog(now - 60000) + lines([req, reply, { ...reply, timestamp: iso(now - 28990) }, sub]));
    assert.strictEqual(t.events.filter(e => e.t === "call").length, 3);
    const s = core.analyzeTrace("claude", "/c/x", t, { now, priceFor });
    assert.strictEqual(s.cacheFrom, now - 30000);
    assert.strictEqual(s.ctx, 152000);
  });

  await check("Codex log: its own context blocks aren't messages; busy during a task; model from the log", () => {
    const s = core.analyzeTrace("codex", "/x/rollout-thread-1.jsonl", harnesses.codexTrace(codexChatLog(now - 60000)), { now, priceFor });
    assert.ok(s);
    assert.strictEqual(s.model, "gpt-6.1-sol");
    assert.strictEqual(s.ttl, 1800, "no lifetime in Codex's log: learned or default");
    assert.strictEqual(s.cacheFrom, now - 60000 + 4000, "request started when its last input (a tool output) arrived");
    assert.strictEqual(s.title, "Refactor the parser");
    assert.strictEqual(s.stats.turns, 1);
    assert.strictEqual(s.busy, false);
    const busy = extra => core.analyzeTrace("codex", "/x", harnesses.codexTrace(codexChatLog(now - 60000) + lines(extra)), { now, priceFor }).busy;
    assert.strictEqual(busy([cx("event_msg", now - 2000, { type: "task_started" }), cxUser(now - 1990, "go")]), true);
    assert.strictEqual(busy([cx("event_msg", now - 2000, { type: "task_started" }), cx("event_msg", now - 100, { type: "turn_aborted" })]), false);
    const ka = core.KEEPALIVES[0];
    const k = core.analyzeTrace("codex", "/x", harnesses.codexTrace(codexChatLog(now - 60000) + lines(codexTurn(now - 20000, ka, { input: 150700, read: 150000, out: 4 }))), { now, priceFor });
    assert.strictEqual(k.lastUserText, ka);
    assert.ok(k.lastRealUserTs < now - 50000, "the keep-alive is not your message");
  });

  await check("extension: Claude chat gets its keep-alive through agent-host-claude:/<VS Code id>, credits as billed", async () => {
    const h = await harness({ kind: "claude", answer: () => "Keep warm" });
    try {
      await h.run(300, () => h.sent.length > 0);
      assert.strictEqual(h.warnings.length, 1);
      assert.strictEqual(h.sent.length, 1);
      assert.ok(core.isKeepAlive(h.sent[0].text));
      const open = h.ran.find(r => r.id === "workbench.action.chat.openSessionInEditorGroup");
      assert.strictEqual(open.a.resource.scheme, "agent-host-claude");
      assert.strictEqual(open.a.resource.path, "/vsc-claude-1");
      await h.run(10);
      await h.commands["cacheKeeper.options"]();
      const item = h.lists.at(-1)[0];
      assert.ok(item.description.startsWith("Claude"), item.description);
      assert.ok(/spent 70 cr/.test(item.detail), item.detail);
    } finally { h.close(); }
  });

  await check("extension: Codex chat gets its keep-alive through agent-host-codex:/<VS Code id>", async () => {
    const h = await harness({ kind: "codex", answer: () => "Keep warm", settings: { ttlSeconds: { "gpt-6.1-sol": 300 } } });
    try {
      const expiry = h.cacheFrom + 300000;
      await h.run(300, () => h.sent.length > 0);
      assert.strictEqual(h.sent.length, 1);
      const lead = (expiry - h.sent[0].at) / 1000;
      assert.ok(lead > 1.5 && lead <= 9, `sent ${lead} s before expiry`);
      const open = h.ran.find(r => r.id === "workbench.action.chat.openSessionInEditorGroup");
      assert.strictEqual(open.a.resource.scheme, "agent-host-codex");
      assert.strictEqual(open.a.resource.path, "/vsc-codex-1");
    } finally { h.close(); }
  });

  await check("extension: Claude chat busy when its tab opens: nothing submitted", async () => {
    const h = await harness({ kind: "claude", answer: () => "Keep warm", busyOnOpen: true });
    try {
      await h.run(300);
      assert.strictEqual(h.sent.length, 0);
    } finally { h.close(); }
  });

  await check("extension: Claude/Codex chats of another folder, your own Claude Code sessions, own-account billing: left alone", async () => {
    const log = path.join(os.tmpdir(), `ck-smoke-log-${process.pid}.txt`);
    const h = await harness({ kind: "claude", sdkCwd: "/somewhere/else", answer: () => "Keep warm", settings: { debugLogFile: log } });
    try {
      await h.run(300);
      assert.strictEqual(h.warnings.length, 0);
      assert.strictEqual(h.sent.length, 0);
      const text = fs.readFileSync(log, "utf8");
      assert.ok(/Claude chat in \/somewhere\/else, not open in this window/.test(text), "other folder");
      assert.ok(/not created in VS Code/.test(text), "discovered Claude Code session");
      assert.ok(/billed to your own anthropic account/.test(text), "own Anthropic account");
    } finally { h.close(); fs.rmSync(log, { force: true }); }
  });


  await check("diagnostics run without error for every harness and name the chat", async () => {
    for (const [kind, id, extra] of [["local", "sess-1", {}], ["sdk", "sdk-0007", {}], ["claude", "vsc-clau", {}],
                                     ["codex", "vsc-code", { ttlSeconds: { "gpt-6.1-sol": 300 } }]]) {
      const log = path.join(os.tmpdir(), `ck-smoke-diag-${process.pid}-${kind}.txt`);
      const h = await harness({ kind, answer: never, settings: { debugLogFile: log, ...extra } });
      try {
        await h.run(6);
        await h.commands["cacheKeeper.diagnose"]();
        await new Promise(r => setTimeout(r, 50));
        const text = fs.readFileSync(log, "utf8");
        const err = /^\d\d:\d\d:\d\d diagnostics: .*$/m.exec(text);   // the command's error line
        assert.ok(!err, `${kind}: ${err && err[0]}`);
        assert.ok(new RegExp(`${id}[^\\n]*listed`).test(text), `${kind}: chat not in diagnostics\n${text}`);
      } finally { h.close(); fs.rmSync(log, { force: true }); }
    }
  });


  await check("every harness: our message is sent alone (preserveInput): your unsent text and attachments stay in the box", async () => {
    for (const [kind, extra] of ALL_KINDS) {
      const h = await harness({ kind, answer: () => "Keep warm", draft: "half-written question", settings: extra });
      try {
        await h.run(300, () => h.sent.length > 0);
        assert.strictEqual(h.sent.length, 1, kind);
        const o = h.submits[0].acceptInputOptions || {};
        assert.strictEqual(o.preserveInput, true, `${kind}: sent without the box's attachments and implicit context`);
        assert.strictEqual(h.chatInput.text, "half-written question", `${kind}: box untouched`);
        await h.run(15);
        assert.strictEqual(h.chatInput.text, "half-written question", kind);
        assert.strictEqual(h.otherInput.text, "other chat's draft", kind);
      } finally { h.close(); }
    }
  });

  await check("fallback, a VS Code that ignores preserveInput: the unsent text is put back after the reply, for every harness", async () => {
    for (const [kind, extra] of ALL_KINDS) {
      const h = await harness({ kind, answer: () => "Keep warm", draft: "half-written question", settings: extra, ignorePreserve: true });
      try {
        await h.run(300, () => h.sent.length > 0);
        assert.strictEqual(h.sent.length, 1, kind);
        assert.strictEqual(h.chatInput.text, "", `${kind}: the submit emptied the box`);
        await h.run(15);
        assert.strictEqual(h.chatInput.text, "half-written question", `${kind}: draft back after the reply`);
        assert.strictEqual(h.otherInput.text, "other chat's draft", `${kind}: other chats' boxes untouched`);
      } finally { h.close(); }
    }
  });

  await check("unsent text: never overwrites what you typed again meanwhile; nothing to do without a draft", async () => {
    const h = await harness({ answer: () => "Keep warm", draft: "old draft", ignorePreserve: true });
    try {
      await h.run(300, () => h.sent.length > 0);
      h.setText(h.chatInput, "new text typed meanwhile");
      await h.run(15);
      assert.strictEqual(h.chatInput.text, "new text typed meanwhile");
    } finally { h.close(); }
    const h2 = await harness({ answer: () => "Keep warm" });
    try {
      await h2.run(300, () => h2.sent.length > 0);
      await h2.run(15);
      assert.strictEqual(h2.chatInput.text, "");
    } finally { h2.close(); }
  });


  // ---------------------------------------------------------------- the same features on every harness
  // One chat, written in each harness's own log format: Italian, 2 files edited, 1 compaction, a cache
  // hit after a 20 min pause, then one of our keep-alives and one of our summary requests.
  const IT_USER = "Ciao, puoi rifattorizzare il parser? Grazie, è per il nuovo modulo.";
  const IT_REPLY = "Certo, ho diviso il parser in tre file e questa è la nuova struttura del modulo.";
  const KA = core.KEEPALIVES_BY_LANG.it[0];
  const SUM = core.summaryPrompt("it", { rel: "/w/.copilot-handoff/x.md", turns: 1, compactions: 1, files: 2, ctxK: 50, words: 300 });
  // calls: [startOffsetMs, input, cached, out]; the 3rd comes 20 min after the 2nd and still hits the cache
  const P0 = now - 3600000, GAP = 20 * 60000;
  const CALLS = [[0, 30000, 0, 800], [5000, 60000, 29000, 300], [5000 + GAP, 61000, 60000, 300]];
  const KA_CALL = [5000 + GAP + 60000, 61900, 61000, 4], SUM_CALL = [5000 + GAP + 120000, 63000, 61900, 400];
  const LOCAL_MODEL = "claude-opus-5.5";
  const build = {
    local() {
      const e = [{ type: "user_message", ts: P0 - 10, attrs: { content: IT_USER } }, { type: "turn_start", ts: P0 - 5 }];
      const call = ([o, i, c, out]) => ({ type: "llm_request", ts: P0 + o, dur: 1000, attrs: { debugName: "panel/editAgent", model: LOCAL_MODEL,
        inputTokens: i, cachedTokens: c, outputTokens: out, copilotUsageNanoAiu: ((i - c) * 480 + c * 20 + out * 2000) * 1e3 } });
      e.push(call(CALLS[0]),
        { type: "tool_call", ts: P0 + 1500, name: "replace_string_in_file", attrs: { args: JSON.stringify({ filePath: "/w/a.js" }) } },
        { type: "tool_call", ts: P0 + 1600, name: "create_file", attrs: { args: JSON.stringify({ filePath: "/w/b.js" }) } },
        { type: "llm_request", ts: P0 + 2000, dur: 500, attrs: { debugName: "summarizeConversationHistory", model: LOCAL_MODEL } },
        call(CALLS[1]), { type: "agent_response", ts: P0 + 6200, attrs: { response: IT_REPLY } }, { type: "turn_end", ts: P0 + 6500 },
        { type: "user_message", ts: P0 + CALLS[2][0] - 10, attrs: { content: IT_USER + " Ancora una cosa." } }, { type: "turn_start", ts: P0 + CALLS[2][0] - 5 },
        call(CALLS[2]), { type: "turn_end", ts: P0 + CALLS[2][0] + 1200 });
      for (const [text, c] of [[KA, KA_CALL], [SUM, SUM_CALL]]) {
        e.push({ type: "user_message", ts: P0 + c[0] - 10, attrs: { content: text } }, { type: "turn_start", ts: P0 + c[0] - 5 }, call(c),
               { type: "turn_end", ts: P0 + c[0] + 1200 });
      }
      return { text: e.map(x => JSON.stringify(x)).join("\n"), trace: harnesses.localTrace };
    },
    sdk() {
      const e = [ev("user.message", P0 - 10, { content: IT_USER }), ev("assistant.turn_start", P0 - 5)];
      const call = ([o, i, c, out]) => sdkUsage(P0 + o, 1000, { input: i, read: c, out });
      e.push(call(CALLS[0]), ev("tool.execution_start", P0 + 1500, { toolName: "edit", arguments: { path: "/w/a.js" } }),
        ev("tool.execution_start", P0 + 1600, { toolName: "create", arguments: { path: "/w/b.js" } }),
        ev("session.compaction_complete", P0 + 2000), ev("assistant.turn_end", P0 + 4900), ev("assistant.turn_start", P0 + 4950),
        call(CALLS[1]), ev("assistant.message", P0 + 6200, { content: IT_REPLY }), ev("assistant.turn_end", P0 + 6500), ev("session.usage_checkpoint", P0 + 6510),
        ev("user.message", P0 + CALLS[2][0] - 10, { content: IT_USER + " Ancora una cosa." }), ev("assistant.turn_start", P0 + CALLS[2][0] - 5),
        call(CALLS[2]), ev("assistant.turn_end", P0 + CALLS[2][0] + 1200), ev("session.usage_checkpoint", P0 + CALLS[2][0] + 1210));
      for (const [text, c] of [[KA, KA_CALL], [SUM, SUM_CALL]]) {
        e.push(ev("user.message", P0 + c[0] - 10, { content: text }), ev("assistant.turn_start", P0 + c[0] - 5), call(c),
               ev("assistant.turn_end", P0 + c[0] + 1200), ev("session.usage_checkpoint", P0 + c[0] + 1210));
      }
      return { text: lines(e), trace: t => harnesses.sdkTrace(t, { cwd: "/w" }) };
    },
    claude() {
      const user = (t, text) => cl("user", t, { cwd: "/w", message: { role: "user", content: [{ type: "text", text }] } });
      const call = ([o, i, c, out], stop = "end_turn", content) => {
        const [req, rep] = claudeCall(P0 + o, P0 + o + 1000, { input: i, read: c, out, stop, id: "r" + o });
        if (content) rep.message.content = content;
        return [req, rep];
      };
      const e = [user(P0 - 10, IT_USER),
        ...call(CALLS[0], "tool_use", [{ type: "tool_use", name: "Edit", input: { file_path: "/w/a.js" } }, { type: "tool_use", name: "Write", input: { file_path: "/w/b.js" } }]),
        cl("user", P0 + 1500, { message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
        cl("system", P0 + 2000, { subtype: "compact_boundary" }),
        ...call(CALLS[1], "end_turn", [{ type: "text", text: IT_REPLY }]),
        user(P0 + CALLS[2][0] - 10, IT_USER + " Ancora una cosa."), ...call(CALLS[2])];
      for (const [text, c] of [[KA, KA_CALL], [SUM, SUM_CALL]]) e.push(user(P0 + c[0] - 10, text), ...call(c));
      return { text: lines(e), trace: harnesses.claudeTrace };
    },
    codex() {
      const e = [cx("session_meta", P0 - 100, { id: "thread-1", cwd: "/w" }), cx("turn_context", P0 - 50, { model: LOCAL_MODEL, cwd: "/w" })];
      const turn = (t, text, calls, extra = []) => {
        e.push(cx("event_msg", t - 20, { type: "task_started" }), cxUser(t - 15, "<environment_context>\n</environment_context>"), cxUser(t - 10, text));
        for (const [o, i, c, out] of calls) {
          if (o !== calls[0][0]) e.push(cx("response_item", P0 + o - 10, { type: "function_call_output", output: "ok" }));
          e.push(cxUsage(P0 + o + 1000, i, c, out));
        }
        e.push(...extra, cx("event_msg", t + 9000 + (calls.at(-1)[0] - calls[0][0]), { type: "task_complete" }));
      };
      turn(P0, IT_USER, [CALLS[0], CALLS[1]], [
        cx("response_item", P0 + 1500, { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: /w/a.js\n*** Add File: /w/b.js\n*** End Patch" }),
        cx("compacted", P0 + 2000), cx("response_item", P0 + 6200, { type: "message", role: "assistant", content: [{ type: "output_text", text: IT_REPLY }] })]);
      turn(P0 + CALLS[2][0], IT_USER + " Ancora una cosa.", [CALLS[2]]);
      for (const [text, c] of [[KA, KA_CALL], [SUM, SUM_CALL]]) turn(P0 + c[0], text, [c]);
      return { text: lines(e).replace(/"timestamp":"[^"]+"/g, m => m), trace: harnesses.codexTrace };
    },
  };
  const expectTtl = { local: [300, "default"], sdk: [300, "this chat's log"], claude: [300, "this chat's log"], codex: [300, "default"] };

  for (const kind of ["local", "sdk", "claude", "codex"]) {
    await check(`feature matrix, ${kind}: language, summary sizing, your messages vs ours, prices, credits, lifetime, timer, keep-alive cost, measured lifetime`, () => {
      const { text, trace } = build[kind]();
      const s = core.analyzeTrace(kind, "/x/chat-1", trace(text), { now, priceFor: kind === "local" ? m => core.priceSheetFrom(MODELS, m) : priceFor });
      assert.ok(s, "parsed");
      assert.strictEqual(s.model, LOCAL_MODEL);
      assert.strictEqual(s.lang, "it", "language from the agent's answers and your messages");
      assert.strictEqual(s.stats.files, 2, "edited files");
      assert.strictEqual(s.stats.compactions, 1, "compactions");
      assert.strictEqual(s.stats.turns, 2, "your messages only, not our keep-alive and summary request");
      assert.strictEqual(s.title, IT_USER.slice(0, 47) + "...");
      assert.strictEqual(s.lastUserText, SUM.trim());
      assert.ok(core.isOwnMessage(s.lastUserText));
      assert.ok(Math.abs(s.lastRealUserTs - (P0 + CALLS[2][0] - 10)) < 20, "last message you typed");
      assert.strictEqual(s.ctx, SUM_CALL[1]);
      assert.strictEqual(s.busy, false);
      const [ttl, from] = expectTtl[kind];
      assert.strictEqual(s.ttl, ttl, "lifetime");
      assert.strictEqual(s.ttlFrom, from, "lifetime source");
      // cache refreshed when the last call started (Codex: when its last input arrived, just before)
      assert.ok(Math.abs(s.cacheFrom - (P0 + SUM_CALL[0])) <= 10, `timer start ${s.cacheFrom - P0} vs ${SUM_CALL[0]}`);
      // prices: Opus 500/20/2000 per 1M; Local's write price is corrected to what calls were billed (480)
      const write = kind === "local" ? 480e-6 : 500e-6, read = 20e-6;
      assert.ok(Math.abs(s.cost.missExtra - SUM_CALL[1] * (write - read)) < 0.01, `expiry cost ${s.cost.missExtra}`);
      // keep-alive cost learned from our earlier messages (keep-alive and summary request): uncached part
      // minus the reply before it; of the two samples the upper middle one is used
      const samples = [(KA_CALL[1] - KA_CALL[2]) - CALLS[2][3], (SUM_CALL[1] - SUM_CALL[2]) - KA_CALL[3]].sort((a, b) => a - b);
      const fixed = Math.max(400, samples[1]);
      const heartbeat = SUM_CALL[1] * read + (fixed + SUM_CALL[3]) * write + 30 * 2000e-6;
      assert.ok(Math.abs(s.cost.heartbeat - heartbeat) < 0.01, `keep-alive cost ${s.cost.heartbeat} vs ${heartbeat}`);
      assert.ok(s.cost.summary > 0 && s.cost.restart > 0);
      assert.ok(s.summaryWords >= 150 && s.summaryWords <= 1500);
      // credits: as billed where the log has them (Local, SDK), else estimated from the prices
      assert.strictEqual(s.creditsEstimated, kind === "claude" || kind === "codex");
      const all = [...CALLS, KA_CALL, SUM_CALL];
      const billed = all.reduce((a, [, i, c, out]) => a + ((i - c) * (kind === "local" ? 480 : 500) + c * 20 + out * 2000) / 1e6, 0);
      assert.ok(Math.abs(s.credits - billed) < 0.05, `credits ${s.credits} vs ${billed}`);
      // measured lifetime: only where the log doesn't state it
      if (kind === "local" || kind === "codex") assert.ok(s.hitGaps[LOCAL_MODEL] >= 1190, JSON.stringify(s.hitGaps));
      else assert.deepStrictEqual(s.hitGaps, {});
    });
  }


  const URI = { local: "vscode-chat-session", sdk: "agent-host-copilotcli", claude: "agent-host-claude", codex: "agent-host-codex" };

  await check("every harness: Summarize writes the handoff request into that chat, through its own URI", async () => {
    for (const [kind, settings] of ALL_KINDS) {
      const h = await harness({ kind, answer: () => "Summarize", settings, ctx: 150000 });
      try {
        await h.run(300, () => h.sent.length > 0);
        assert.strictEqual(h.sent.length, 1, kind);
        assert.ok(h.sent[0].text.startsWith("[summary]"), `${kind}: ${h.sent[0].text.slice(0, 40)}`);
        assert.ok(/\.copilot-handoff\/.*\.md/.test(h.sent[0].text), kind);
        const open = h.ran.find(r => r.id === "workbench.action.chat.openSessionInEditorGroup");
        assert.strictEqual(open.a.resource.scheme, URI[kind], kind);
        assert.ok(h.infos.some(m => /writing the handoff summary/.test(m)), kind);
      } finally { h.close(); }
    }
  });

  await check("every harness: status bar countdown, tooltip with lifetime source and costs, list label", async () => {
    const from = { local: "default", sdk: "this chat's log", claude: "this chat's log", codex: "setting" };
    for (const [kind, settings] of ALL_KINDS) {
      const h = await harness({ kind, answer: never, settings, ctx: 150000 });
      try {
        await h.run(3);
        assert.ok(/^\$\(flame\) \d:\d\d$/.test(h.status.text), `${kind}: ${h.status.text}`);
        const tip = String(h.status.tooltip.value);
        assert.ok(tip.includes(`cache lifetime 300 s (${from[kind]})`), `${kind}: ${tip.split("\n")[1]}`);
        assert.ok(/Expiry adds \| ~\d+ cr/.test(tip) && /Keep-alive \| ~/.test(tip) && /Handoff summary \| ~/.test(tip), kind);
        await h.commands["cacheKeeper.options"]();
        assert.ok(h.lists.at(-1)[0].description.startsWith({ local: "Local", sdk: "Copilot SDK", claude: "Claude", codex: "Codex" }[kind]), kind);
      } finally { h.close(); }
    }
  });

  await check("every harness: at expiry, the notice says what the next message will cost", async () => {
    for (const [kind, settings] of ALL_KINDS) {
      const h = await harness({ kind, answer: never, settings, ctx: 40000 });   // below the summary threshold: it just expires
      try {
        await h.run(320);
        const n = h.infos.find(m => /^Copilot cache expired/.test(m));
        assert.ok(n && /~[\d.]+ extra credits/.test(n), `${kind}: ${n}`);
      } finally { h.close(); }
    }
  });

  await check("Claude/Codex without Copilot prices: warning says so, nothing automatic, no costs shown", async () => {
    for (const [kind, settings] of ALL_KINDS.filter(([k]) => k === "claude" || k === "codex")) {
      const h = await harness({ kind, answer: never, settings, noPrices: true, ctx: 150000 });
      try {
        await h.run(320);
        assert.strictEqual(h.sent.length, 0, `${kind}: no automatic summary without a price`);
        assert.ok(h.warnings.length === 1 && /No price for this model/.test(h.warnings[0].msg), `${kind}: ${h.warnings[0] && h.warnings[0].msg}`);
      } finally { h.close(); }
    }
  });

  await check("Codex chat: a cache hit after a long pause is kept as a measured lifetime, like Local chats", async () => {
    const h = await harness({ kind: "codex", answer: never });
    try {
      // 25 min after the last call, the cache still covered the chat's own conversation
      h.append(codexTurn(h.clock + 1500000, "Next step please", { input: 152000, read: 150500 }));
      await h.run(6);
      const ev = h.memento.get("measuredCacheGaps") || {};
      assert.ok(ev["gpt-6.1-sol"] && ev["gpt-6.1-sol"].gap >= 1490, JSON.stringify(ev));
    } finally { h.close(); }
  });


  await check("a log appended within the same millisecond (same mtime) is still re-read", async () => {
    const h = await harness({ kind: "codex", answer: never });
    try {
      const pin = Math.floor(Date.now() / 1000) - 5;     // a whole second: utimes keeps it exactly
      fs.utimesSync(h.logFile, pin, pin);
      await h.run(1);
      h.append(codexTurn(h.clock + 1500000, "Next step please", { input: 152000, read: 150500 }));
      fs.utimesSync(h.logFile, pin, pin);                // as if written in the same millisecond as before
      await h.run(6);
      await h.commands["cacheKeeper.options"]();
      assert.ok(/152k/.test(h.lists.at(-1)[0].description), h.lists.at(-1)[0].description);
    } finally { h.close(); }
  });


  await check("Claude and Codex: attachments the harness adds to a message are not part of what you typed", () => {
    const reminder = "<system-reminder>\nThe user provided the following references:\n- /home/u/models.json\n</system-reminder>";
    const userWith = (t, text) => cl("user", t, { cwd: "/w", message: { role: "user", content: [{ type: "text", text }, { type: "text", text: reminder }] } });
    const c = core.analyzeTrace("claude", "/c/x", harnesses.claudeTrace(lines([userWith(now - 60000, "hi"),
      ...claudeCall(now - 59990, now - 59000, { input: 30000, read: 0, id: "a" }),
      userWith(now - 30000, core.KEEPALIVES[0]), ...claudeCall(now - 29990, now - 29000, { input: 30500, read: 30000, id: "b" })])), { now, priceFor });
    assert.strictEqual(c.title, "hi");
    assert.strictEqual(c.stats.turns, 1, "our keep-alive still recognised with a reminder block added");
    assert.strictEqual(c.lastUserText, core.KEEPALIVES[0]);
    const x = core.analyzeTrace("codex", "/x/x", harnesses.codexTrace(codexChatLog(now - 60000).replace(
      '"text":"Refactor the parser"', '"text":"Refactor the parser\\n\\n@/home/u/attach-me.txt\\n@/home/u/b.txt"')), { now, priceFor });
    assert.strictEqual(x.title, "Refactor the parser");
  });


  await check("every harness: Summarize on an expired chat asks first (cost), writes it if you confirm", async () => {
    for (const [kind, settings] of ALL_KINDS) {
      const h = await harness({ kind, settings, ctx: 40000,      // below the threshold: no automatic summary
        answer: (msg) => /already expired/.test(msg) ? "Write anyway" : never(),
        menu: items => items.find(i => i.label === "Summarize") });
      try {
        await h.run(320);
        assert.strictEqual(h.sent.length, 0, `${kind}: expired, nothing sent yet`);
        await h.commands["cacheKeeper.options"]();
        await h.run(3);
        const ask = h.warnings.find(w => /already expired/.test(w.msg));
        assert.ok(ask && /re-sends the whole context: ~[\d.]+ cr/.test(ask.msg), `${kind}: ${ask && ask.msg}`);
        assert.strictEqual(h.sent.length, 1, `${kind}: summary sent after confirming`);
        assert.ok(h.sent[0].text.startsWith("[summary]"), kind);
      } finally { h.close(); }
    }
  });

  await check("Summarize on an expired chat, declined: nothing sent, back to default (not left waiting)", async () => {
    const h = await harness({ ctx: 40000, answer: () => undefined, menu: items => items.find(i => i.label === "Summarize") });
    try {
      await h.run(320);
      await h.commands["cacheKeeper.options"]();
      await h.run(10);
      assert.strictEqual(h.sent.length, 0);
      // re-open the list: the chat's mode is shown in its detail line
      await h.commands["cacheKeeper.options"]();
      const item = h.lists.at(-1)[0];
      assert.ok(/^default/.test(item.detail) && !/summary waiting/.test(item.detail), item.detail);
    } finally { h.close(); }
  });

  await check("Summarize on a warm chat from the list: written right away, no question", async () => {
    const h = await harness({ ctx: 40000, answer: never, menu: items => items.find(i => i.label === "Summarize") });
    try {
      await h.run(30);
      await h.commands["cacheKeeper.options"]();
      await h.run(2);
      assert.strictEqual(h.sent.length, 1);
      assert.ok(h.sent[0].text.startsWith("[summary]"));
      assert.ok(!h.warnings.some(w => /already expired/.test(w.msg)));
    } finally { h.close(); }
  });

  // ---------------------------------------------------------------- fixes from the 2026-11 review

  const kinds = sent => sent.map(x => core.isKeepAlive(x.text) ? "keep-alive" : x.text.startsWith("[summary]") ? "summary" : x.text.slice(0, 20));

  await check("Keep warm once, then Back to default: the closing summary is cancelled", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : "Back to default" });
    try {
      await h.run(700);
      assert.deepStrictEqual(kinds(h.sent), ["keep-alive"]);
    } finally { h.close(); }
  });

  await check("Keep warm once, next warning unanswered: it says a summary follows, and one does", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : never() });
    try {
      await h.run(700);
      assert.deepStrictEqual(kinds(h.sent), ["keep-alive", "summary"]);
      assert.ok(/No click: a handoff summary .* ends keeping warm/.test(h.warnings[1].msg), h.warnings[1].msg);
    } finally { h.close(); }
  });

  await check("Keep warm once, then Stop keeping warm: no closing summary, and Stop says what it did", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : never() });
    try {
      await h.run(320);
      assert.deepStrictEqual(kinds(h.sent), ["keep-alive"]);
      await h.commands["cacheKeeper.stop"]();
      assert.ok(/stopped keeping 1 chat/.test(h.infos.at(-1)), h.infos.at(-1));
      await h.run(400);
      assert.deepStrictEqual(kinds(h.sent), ["keep-alive"]);
    } finally { h.close(); }
  });

  await check("late click: Keep warm on a warning whose cache expired asks about the cost, arms nothing for later", async () => {
    let click;
    const late = new Promise(r => { click = r; });
    const h = await harness({ answer: (m, b, n) => n === 1 ? late : never() });
    try {
      await h.run(320);                                  // expired, warning still in the notification center
      assert.strictEqual(h.sent.length, 0);
      click("Keep warm");
      await h.run(3);
      assert.ok(h.warnings.some(w => /already expired/.test(w.msg)), "asked first, with the cost");
      h.userTypes();
      await h.run(320);
      assert.strictEqual(h.sent.length, 0, "no keep-alive in the window after your next message");
    } finally { h.close(); }
  });

  await check("late click: Auto keep warm on a warning from an earlier cache window does nothing", async () => {
    let click;
    const late = new Promise(r => { click = r; });
    const h = await harness({ answer: (m, b, n) => n === 1 ? late : never() });
    try {
      await h.run(320);
      h.userTypes();
      await h.run(10);
      click("Auto keep warm");
      await h.run(320);
      assert.strictEqual(h.sent.length, 0);
      assert.ok(h.infos.some(m => /cache window that is over/.test(m)), h.infos.join(" | "));
    } finally { h.close(); }
  });

  await check("list on an expired chat: Keep warm now (asks first) instead of arming Keep warm / Auto", async () => {
    let offered;
    const h = await harness({ answer: () => undefined, menu: items => { offered = items.map(i => i.label); return items.find(i => i.label === "Keep warm now"); } });
    try {
      await h.run(320);
      await h.commands["cacheKeeper.options"]();
      await h.run(2);
      assert.ok(offered.includes("Keep warm now") && !offered.includes("Keep warm") && !offered.includes("Auto keep warm"), offered.join(", "));
      assert.ok(h.warnings.some(w => /already expired/.test(w.msg)), "cost question");
      assert.strictEqual(h.sent.length, 0, "declined: nothing sent");
    } finally { h.close(); }
  });

  await check("no price: the list doesn't offer Auto keep warm", async () => {
    let offered;
    const h = await harness({ kind: "claude", noPrices: true, ctx: 150000, answer: never, menu: items => { offered = items.map(i => i.label); } });
    try {
      await h.run(3);
      await h.commands["cacheKeeper.options"]();
      assert.ok(offered.includes("Keep warm") && !offered.includes("Auto keep warm"), offered.join(", "));
    } finally { h.close(); }
  });

  await check("a summary that takes more than 90 s: its tab is left alone until the agent is done", async () => {
    const h = await harness({ ctx: 40000, answer: never,
                              menu: items => items.find(i => i.label === "Summarize") });
    try {
      await h.run(10);
      await h.commands["cacheKeeper.options"]();
      await h.run(1, () => h.sent.length > 0);
      assert.strictEqual(h.sent.length, 1);
      h.append([{ type: "turn_start", ts: h.clock + 700 }]);     // still writing the summary
      await h.run(150);
      assert.strictEqual(h.closed.length, 0, "tab not closed while it works");
      h.append([{ type: "turn_end", ts: h.clock }]);
      await h.run(5);
      assert.strictEqual(h.closed.length, 1, "closed once done");
    } finally { h.close(); }
  });

  await check("parsed logs are reused while the text is unchanged", () => {
    let n = 0;
    const tr = t => { n++; return { events: [], t }; };
    const a = core.cachedTrace("k", "text-1", tr), b = core.cachedTrace("k", "text-1", tr);
    assert.strictEqual(a, b);
    core.cachedTrace("k", "text-2", tr);
    assert.strictEqual(n, 2);
  });

  // ---------------------------------------------------------------- review bugs not covered above, and the UI/mechanics follow-up

  await check("no price sheet anywhere: other workspaces are searched about once a minute, not on every read", async () => {
    const h = await harness({ kind: "claude", noPrices: true, ctx: 150000, answer: never });
    try {
      await h.run(120);
      const ws = path.join(h.dir, "workspaceStorage");
      const n = h.listed.filter(d => d === ws).length;
      assert.ok(n >= 1 && n <= 3, `workspaceStorage listed ${n} times in 2 min`);
    } finally { h.close(); }
  });

  await check("timer ticks don't overlap: a tick still running makes the next one skip", async () => {
    const h = await harness({ answer: never });
    try {
      let runs = 0, release;
      const tick = h.ext._noOverlap("t", () => { runs++; return new Promise(r => { release = r; }); });
      tick(); await new Promise(r => setImmediate(r));
      tick(); await new Promise(r => setImmediate(r));
      assert.strictEqual(runs, 1, "second tick skipped while the first runs");
      release(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
      tick(); await new Promise(r => setImmediate(r));
      assert.strictEqual(runs, 2, "runs again once the first is done");
    } finally { h.close(); }
  });

  await check("tab cleanup: two tabs with the chat's title, none closed", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : never(), settings: { afterSend: "restoreLastTyped" } });
    try {
      h.vscode.window.tabGroups.all.push({ tabs: [{ label: "chat", input: {} }] });   // another chat with the same title
      await h.run(320);
      await new Promise(r => setTimeout(r, 1500));      // moving the chat back waits on real timers
      assert.ok(core.isKeepAlive((h.sent[0] || {}).text || ""), "keep-alive sent");
      assert.ok(h.ran.some(r => r.id === "workbench.action.chat.openInSidebar"), "moved back into the Chat view");
      assert.strictEqual(h.closed.length, 0, "the same-named tabs are left alone");
    } finally { h.close(); }
  });

  await check("handoff folder kept out of git in a worktree (.git is a file pointing to the main repository)", async () => {
    const h = await harness({ ctx: 40000, answer: never, menu: items => items.find(i => i.label === "Summarize") });
    try {
      const main = path.join(h.dir, "main", ".git");
      fs.mkdirSync(path.join(main, "worktrees", "wt"), { recursive: true });
      fs.writeFileSync(path.join(main, "worktrees", "wt", "commondir"), "../..\n");
      fs.writeFileSync(path.join(h.dir, ".git"), `gitdir: ${path.join(main, "worktrees", "wt")}\n`);
      await h.run(10);
      await h.commands["cacheKeeper.options"]();
      await h.run(2);
      assert.ok(fs.readFileSync(path.join(main, "info", "exclude"), "utf8").includes(".copilot-handoff/"));
    } finally { h.close(); }
  });

  await check("local window: no unmeasured-clock margin on the lead", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : never() });
    try {
      await h.run(250);
      assert.ok(h.infos.some(m => /will send a keep-alive 5s before/.test(m)), h.infos.join(" | "));
    } finally { h.close(); }
  });

  await check("a model with no lifetime data: 5 min assumed and shown as a guess (~, warning, tooltip)", async () => {
    const h = await harness({ answer: never, settings: { minCredits: 0 } });
    try {
      // you switch the chat to a model no log or built-in value says anything about
      h.append([{ type: "user_message", ts: h.clock, attrs: { content: "Go on with the new model" } },
                { type: "turn_start", ts: h.clock + 5 },
                { type: "llm_request", ts: h.clock + 10, dur: 500, attrs: { debugName: "panel/editAgent", model: "brand-new-model",
                  inputTokens: 41000, cachedTokens: 0, outputTokens: 4 } },
                { type: "turn_end", ts: h.clock + 600 }]);
      await h.run(5);
      assert.ok(/^\$\(flame\) ~\d:\d\d/.test(h.status.text), h.status.text);
      await h.run(300, () => h.warnings.length > 0);
      const w = (h.warnings[0] || {}).msg || "";
      assert.ok(/expires in ~\d+s \(lifetime assumed: no data for this model\)\./.test(w), w);
    } finally { h.close(); }
    assert.strictEqual(core.ttlSource("brand-new-model"), "assumed: no data for this model");
    assert.strictEqual(core.ttlFor("brand-new-model"), 300);
    assert.strictEqual(core.ttlSource("claude-opus-5.5"), "default");
    const t0 = now - 60000;
    const s = core.analyzeTrace("local", "/x/new", { events: [{ t: "user", ts: t0, text: "go" }, { t: "turn_start", ts: t0 },
      { t: "call", ts: t0 + 10, end: t0 + 500, model: "brand-new-model", input: 50000, cached: 0, out: 5 }, { t: "turn_end", ts: t0 + 600 }], info: {} },
      { now });
    assert.strictEqual(s.ttl, 300);
    assert.strictEqual(s.ttlAssumed, true);
  });

  await check("warning: short, what no click does; 3 buttons (main, second, More…) that fit; a cost button works", async () => {
    let buttons;
    const h = await harness({ answer: (m, b, n) => { if (n === 1) { buttons = b; return b[0]; } return never(); } });
    try {
      await h.run(320);
      const msg = h.warnings[0].msg;
      assert.ok(msg.length < 160 && /^".+" expires in \d+s\. Expiry: \+[\d.]+ cr\. No click: /.test(msg), msg);
      assert.ok(/^Keep warm \(~[\d.]+ cr\)$/.test(buttons[0]) && buttons[1] === "Auto keep warm" && buttons[2] === "More…" && buttons.length === 3, buttons.join(" | "));
      assert.ok(core.isKeepAlive(h.sent[0].text), "Keep warm (~x cr) chose Keep warm");
    } finally { h.close(); }
  });

  await check("warning More… then the menu closed: the warning stays unanswered (last-chance status bar still shows)", async () => {
    let menus = 0;
    const h = await harness({ answer: (m, b, n) => n === 1 ? "More…" : never(), menu: () => { menus++; return undefined; } });
    try {
      await h.run(280);
      assert.strictEqual(menus, 1, "More… opened the chat's menu");
      assert.ok(/click to choose/.test(h.status.text), h.status.text);
      assert.strictEqual(h.sent.length, 0);
    } finally { h.close(); }
  });

  await check("chat menu: the current choice is marked, each choice shows its cost for this chat", async () => {
    let k = 0, offered;
    const h = await harness({ answer: never, menu: items => { if (k++ === 0) return items.find(i => i.label === "Keep warm"); offered = items; } });
    try {
      await h.run(10);
      await h.commands["cacheKeeper.options"]();
      await h.commands["cacheKeeper.options"]();
      const by = l => offered.find(i => i.label === l);
      assert.ok(/current/.test(by("Keep warm").description || ""), "Keep warm marked");
      assert.ok(!by("Back to default").description, "only the current one");
      assert.ok(/\(~[\d.]+ cr\)/.test(by("Keep warm").detail) && /up to ~[\d.]+ cr/.test(by("Auto keep warm").detail) &&
        /\(~[\d.]+ cr\)/.test(by("Summarize").detail), offered.map(i => i.detail).join(" | "));
      assert.ok(/no click: /.test(by("Back to default").detail), by("Back to default").detail);
    } finally { h.close(); }
  });

  await check("Keep warm now: names the chat; with several chats it asks which one", async () => {
    let offered;
    const h = await harness({ answer: never, menu: items => { offered = items; return undefined; } });
    try {
      await h.run(10);
      await h.commands["cacheKeeper.keepWarmNow"]();
      assert.ok(h.infos.some(m => /keep-alive sent to "Refactor the parser"/.test(m)), h.infos.join(" | "));
      // a second chat in the workspace
      const two = path.join(h.logs, "sess-2");
      fs.cpSync(path.join(h.logs, "sess-1"), two, { recursive: true });
      await h.run(6);
      const n = h.sent.length;
      await h.commands["cacheKeeper.keepWarmNow"]();
      assert.ok(offered && offered.length === 2, "asked which chat");
      assert.strictEqual(h.sent.length, n, "cancelled: nothing sent");
    } finally { h.close(); }
  });

  await check("status bar: short texts, red while auto keep warm runs, armed after Keep warm", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Auto keep warm" : never() });
    try {
      await h.run(250);
      assert.ok(/^\$\(zap\) \d:\d\d · [\d.]+\/[\d.]+ cr$/.test(h.status.text), h.status.text);
      assert.strictEqual(h.status.backgroundColor.id, "statusBarItem.errorBackground");
    } finally { h.close(); }
    const k = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : never() });
    try {
      await k.run(250);
      assert.ok(/^\$\(flame\) \d:\d\d · armed$/.test(k.status.text), k.status.text);
    } finally { k.close(); }
  });

  await check("last chance: an unanswered warning makes the status bar ask; answering from the list counts", async () => {
    const h = await harness({ answer: never, menu: items => items.find(i => i.label === "Keep warm") });
    try {
      await h.run(272);                                   // warned at 60 s, now under 30 s left, no answer
      assert.ok(/^\$\(bell\) .* \d:\d\d · click to choose$/.test(h.status.text), h.status.text);
      assert.strictEqual(h.status.backgroundColor.id, "statusBarItem.warningBackground");
      await h.commands["cacheKeeper.options"]();
      await h.run(30);
      assert.ok(h.sent.length && core.isKeepAlive(h.sent[0].text), "kept warm from the list");
      assert.ok(!/click to choose/.test(h.status.text), h.status.text);
    } finally { h.close(); }
  });

  await check("New chat from handoff: in the same harness when VS Code has a command for it, else Local and says so", async () => {
    for (const commandList of [["workbench.action.chat.openNewSessionSidebar.agent-host-claude"], []]) {
      const h = await harness({ kind: "claude", ctx: 150000, commandList, answer: () => "Summarize",
        menu: items => items.find(i => i.label === "New chat from handoff") });
      try {
        await h.run(900);
        await h.commands["cacheKeeper.options"]();
        const ids = h.ran.map(r => r.id);
        if (commandList.length) assert.ok(ids.includes(commandList[0]) && !ids.includes("workbench.action.chat.newChat"), ids.join(", "));
        else {
          assert.ok(ids.includes("workbench.action.chat.newChat"), ids.join(", "));
          assert.ok(h.infos.some(m => /no command to start a new Claude chat/.test(m)), h.infos.join(" | "));
        }
        assert.ok(ids.includes("workbench.action.chat.open"), "handoff attached");
      } finally { h.close(); }
    }
  });

  await check("cache hit logged after each message; diagnostics count Cache Keeper's warm and cold ones", async () => {
    const log = path.join(os.tmpdir(), `ck-hit-${process.pid}.log`);
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : never(), settings: { debugLogFile: log } });
    try {
      await h.run(320);
      await h.commands["cacheKeeper.diagnose"]();
      const text = fs.readFileSync(log, "utf8");
      assert.ok(/cache hit for Cache Keeper's message in sess-1: \d+% cached .* s after the previous call started \(\d+ s after it ended\)/.test(text), text.slice(-1500));
      assert.ok(/own messages since this window started: 1 landed warm, 0 cold/.test(text));
    } finally { h.close(); fs.rmSync(log, { force: true }); }
  });

  await check("agent working past the cache lifetime: 'possibly expired', not a confident 'expired'", async () => {
    const h = await harness({ answer: never });
    try {
      h.append([{ type: "user_message", ts: h.clock, attrs: { content: "Run the long tests" } }, { type: "turn_start", ts: h.clock + 5 }]);
      await h.run(320);
      assert.ok(/^\$\(sync~spin\) working · possibly expired/.test(h.status.text), h.status.text);
      assert.ok(String(h.status.tooltip.value).includes("possibly expired"));
    } finally { h.close(); }
  });

  await check("summary request answered without the file: you are told", async () => {
    const h = await harness({ ctx: 40000, answer: never, writesHandoff: false, menu: items => items.find(i => i.label === "Summarize") });
    try {
      await h.run(10);
      await h.commands["cacheKeeper.options"]();
      await h.run(5);
      assert.ok(h.warnings.some(w => /did not write .*\.md/.test(w.msg)), h.warnings.map(w => w.msg).join(" | "));
    } finally { h.close(); }
  });

  await check("handoff cleanup: newest 5 always kept, older ones past 7 days deleted, other files untouched", async () => {
    const h = await harness({ ctx: 40000, answer: never, menu: items => items.find(i => i.label === "Summarize") });
    try {
      const dir = path.join(h.dir, ".copilot-handoff");
      fs.mkdirSync(dir, { recursive: true });
      const put = (name, days) => { const f = path.join(dir, name); fs.writeFileSync(f, "x"); const t = (h.clock - days * 86400000) / 1000; fs.utimesSync(f, t, t); };
      [1, 2, 3].forEach(d => put(`2026110${d}-1000-recent${d}.md`, d));
      [10, 11, 12, 13, 14].forEach(d => put(`202610${d}-1000-old${d}.md`, d));
      put("notes.md", 30);
      await h.run(10);
      await h.commands["cacheKeeper.options"]();         // writes a new summary, then cleans up
      await h.run(5);
      const left = fs.readdirSync(dir).sort();
      assert.ok(left.includes("notes.md") && left.includes("20261010-1000-old10.md"), left.join(", "));
      assert.ok(!left.some(n => /old1[1-4]/.test(n)), left.join(", "));
      assert.strictEqual(left.filter(n => /^\d{8}-\d{4}-/.test(n)).length, 5, left.join(", "));
    } finally { h.close(); }
  });

  await check("incremental parse: a grown log reuses its parsed lines and equals a full parse", () => {
    const a = JSON.stringify({ n: 1 }) + "\n" + JSON.stringify({ n: 2 }) + "\n" + '{"n":';
    const p1 = core.parseGrowing(null, a);
    assert.deepStrictEqual(p1.all.map(x => x.n), [1, 2], "unfinished last line left out");
    const b = a + "3}\n" + JSON.stringify({ n: 4 }) + "\n";
    const p2 = core.parseGrowing({ text: a, done: p1.done, lines: p1.lines }, b);
    assert.deepStrictEqual(p2.all.map(x => x.n), [1, 2, 3, 4]);
    assert.strictEqual(p2.lines[0], p1.lines[0], "earlier lines not parsed again");
    const c = JSON.stringify({ n: 9 }) + "\n";        // rewritten, not grown: parsed in full
    assert.deepStrictEqual(core.parseGrowing({ text: b, done: p2.done, lines: p2.lines }, c).all.map(x => x.n), [9]);
  });

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
