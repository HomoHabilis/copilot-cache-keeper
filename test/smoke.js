// Smoke test: core logic on a synthetic Copilot debug log, then the extension loaded with a
// minimal stand-in for the VS Code API, deciding to send a keep-alive before the cache expires.
// Run: node test/smoke.js   (no dependencies)
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const core = require("../core");

let failures = 0;
function check(name, fn) {
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

function chatLog(t0, { model = "claude-opus-5.5", ctx = 150000, keepAlive = false } = {}) {
  const ev = [
    { type: "user_message", ts: t0, attrs: { content: "Refactor the parser" } },
    { type: "turn_start", ts: t0 + 10 },
    { type: "llm_request", ts: t0 + 50, dur: 3000, attrs: { debugName: "panel/editAgent", model, inputTokens: ctx - 20000,
      cachedTokens: 0, outputTokens: 800, copilotUsageNanoAiu: 30e9 } },
    { type: "llm_request", ts: t0 + 4000, dur: 2000, attrs: { debugName: "panel/editAgent", model, inputTokens: ctx,
      cachedTokens: ctx - 1000, outputTokens: 300, copilotUsageNanoAiu: 5e9 } },
    { type: "turn_end", ts: t0 + 6500 },
  ];
  if (keepAlive) {
    ev.push({ type: "user_message", ts: t0 + 9000, attrs: { content: "[cache-keeper] Keep-alive while I'm away." } },
            { type: "turn_start", ts: t0 + 9010 },
            { type: "llm_request", ts: t0 + 9050, dur: 800, attrs: { debugName: "panel/editAgent", model,
              inputTokens: ctx + 900, cachedTokens: ctx, outputTokens: 4, copilotUsageNanoAiu: 3.5e9 } },
            { type: "turn_end", ts: t0 + 10000 });
  }
  return ev.map(e => JSON.stringify(e)).join("\n") + "\n";
}

// ---------------------------------------------------------------- extension with a stand-in VS Code

/**
 * Load a fresh copy of the extension against a fake VS Code and one chat whose last call started
 * 3 s ago. `answer(msg, buttons, n)` is the user's reaction to the n-th warning: a button label,
 * undefined (closed with X) or a promise that never settles (not answered). Messages Cache Keeper
 * submits land in the chat's log with a short reply, so each one starts a new cache window.
 */
async function harness({ answer, settings: extra = {}, ctx = 40000 }) {
  const now = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-smoke-"));
  const storage = path.join(tmp, "workspaceStorage", "ws1");
  const logs = path.join(storage, "GitHub.copilot-chat", "debug-logs");
  const chat = path.join(logs, "sess-1");
  let clock = now;
  const sent = [], warnings = [];
  const fakeFs = {
    stat: async u => ({ mtime: fs.statSync(u.fsPath).mtimeMs }),
    readFile: async u => fs.readFileSync(u.fsPath),
    writeFile: async (u, b) => fs.writeFileSync(u.fsPath, b),
    readDirectory: async u => fs.readdirSync(u.fsPath).map(n => [n, 1]),
  };
  const settings = { warnSeconds: 60, thresholdCredits: 60, autoSummary: true, minCredits: 5, ttlSeconds: {},
                     keepAliveLeadSeconds: 5, afterSend: "closeTab", noResponseAction: "nothing",
                     autoKeepWarmCapPercent: 50, ...extra };
  const tab = { label: "chat", input: {} };
  const append = evs => fs.appendFileSync(path.join(chat, "main.jsonl"), evs.map(e => JSON.stringify(e)).join("\n") + "\n");
  let lastCtx = ctx;
  const vscode = {
    env: { remoteName: undefined },
    workspace: { getConfiguration: () => ({ get: k => settings[k] }), fs: fakeFs,
                 workspaceFolders: [{ uri: { scheme: "file", fsPath: tmp, path: tmp } }] },
    window: {
      createStatusBarItem: () => ({ show() {}, hide() {}, text: "" }),
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      showWarningMessage: async (msg, ...buttons) => { warnings.push({ at: clock, msg }); return answer(msg, buttons, warnings.length); },
      showInformationMessage: async () => undefined,
      showErrorMessage: async m => { throw new Error("unexpected error message: " + m); },
      showQuickPick: async () => undefined,
      tabGroups: { all: [{ tabs: [] }], get activeTabGroup() { return this.all[0]; }, close: async () => {} },
    },
    commands: {
      registerCommand: () => ({ dispose() {} }),
      executeCommand: async (id, a) => {
        if (id === "workbench.action.chat.openSessionInEditorGroup") {
          vscode.window.tabGroups.all[0].tabs = [tab]; vscode.window.tabGroups.all[0].activeTab = tab;
        }
        if (id === "workbench.action.chat.submit") {
          sent.push({ at: clock, text: a.inputValue });
          lastCtx += 700;
          append([{ type: "user_message", ts: clock, attrs: { content: a.inputValue } },
                  { type: "turn_start", ts: clock + 5 },
                  { type: "llm_request", ts: clock + 10, dur: 500, attrs: { debugName: "panel/editAgent", model: "claude-opus-5.5",
                    inputTokens: lastCtx, cachedTokens: lastCtx - 700, outputTokens: 4, copilotUsageNanoAiu: 1e9 } },
                  { type: "turn_end", ts: clock + 600 }]);
          h.cacheFrom = clock + 10;
        }
      },
    },
    StatusBarAlignment: { Right: 2 }, ThemeColor: class {},
    Uri: { file: f => ({ scheme: "file", fsPath: f, path: f }),
           from: o => ({ ...o, toString: () => `${o.scheme}://${o.authority}${o.path}` }),
           joinPath: (b, ...p) => { const f = path.join(b.fsPath, ...p); return { scheme: "file", fsPath: f, path: f }; } },
  };
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === "vscode" ? vscode : load.call(this, req, ...rest); };
  const realNow = Date.now, realSetInterval = global.setInterval;
  Date.now = () => clock;
  global.setInterval = () => 0;
  delete require.cache[require.resolve("../extension")];
  const ext = require("../extension");
  fs.mkdirSync(logs, { recursive: true });
  ext.activate({ storageUri: { fsPath: path.join(storage, "local.copilot-cache-keeper") }, subscriptions: [] });
  await ext._read();                                  // first read: no chats yet
  clock += 2000;
  fs.mkdirSync(chat);
  fs.writeFileSync(path.join(chat, "models.json"), MODELS);
  fs.writeFileSync(path.join(chat, "main.jsonl"), chatLog(clock - 7000, { ctx }));
  await ext._read();
  const h = {
    sent, warnings, ext, logFile: path.join(chat, "main.jsonl"), cacheFrom: clock - 7000 + 4000,
    get clock() { return clock; },
    /** You write in the chat: a real message and the agent's answer. */
    userTypes() {
      lastCtx += 2000;
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

  await check("analyze: keep-alive estimate learned from an earlier keep-alive", () => {
    const s = core.analyze("/logs/k", chatLog(now - 60000, { keepAlive: true }), MODELS, now);
    // fixed part 900 - 300 (previous reply) = 600, plus the last reply (4 tokens)
    const expected = (150900 * 20 + 604 * 500 + 30 * 2000) / 1e6;
    assert.ok(Math.abs(s.cost.heartbeat - expected) < 0.01, `heartbeat ${s.cost.heartbeat} vs ${expected}`);
    assert.strictEqual(s.lastRealUserTs, now - 60000, "keep-alives are not counted as your messages");
  });

  await check("analyze: busy while a turn is open, and unknown model has no cost", () => {
    const busy = chatLog(now - 5000).replace(/.*"turn_end".*\n$/, "");
    assert.strictEqual(core.analyze("/logs/b", busy, MODELS, now).busy, true);
    const unknown = core.analyze("/logs/u", chatLog(now - 5000, { model: "mystery-model" }), MODELS, now);
    assert.strictEqual(unknown.cost, null);
    assert.strictEqual(unknown.ttl, 300);
  });

  await check("rates: long-context tier above 272k for Sol", () => {
    const sheet = JSON.parse(MODELS)[1].billing.token_prices;
    assert.strictEqual(core.rates(sheet, 100000).read, 10 / 1e6);
    assert.strictEqual(core.rates(sheet, 300000).read, 20 / 1e6);
    assert.strictEqual(core.ttlFor("gpt-6.1-sol"), 1800);
  });

  await check("autoCap / canAffordHeartbeat: keep-alives stop at a share of the expiry cost", () => {
    const s = { cost: { heartbeat: 3, missExtra: 72, summary: 9, restart: 14 } };
    const cap = core.autoCap(s, 50);
    assert.strictEqual(cap, 36);
    assert.strictEqual(core.canAffordHeartbeat(s, 0, cap), true);
    assert.strictEqual(core.canAffordHeartbeat(s, 33, cap), true);    // 33 + 3 = 36
    assert.strictEqual(core.canAffordHeartbeat(s, 34, cap), false);
    assert.strictEqual(core.autoCap({ cost: null }, 50), null);
    assert.strictEqual(core.canAffordHeartbeat({ cost: null }, 0, null), false);
  });

  await check("extension: activates, reads logs, sends a keep-alive 5 s before expiry", async () => {
    const h = await harness({ answer: () => "Auto keep warm" });   // the user picks Auto keep warm
    try {
      const startedCall = h.cacheFrom;
      await h.run(300, () => h.sent.length > 0);
      assert.strictEqual(h.sent.length, 1, "one keep-alive sent");
      assert.ok(h.sent[0].text.startsWith("[cache-keeper] Keep-alive"), h.sent[0].text);
      const leftAtSend = 300 - (h.sent[0].at - startedCall) / 1000;
      // 5 s lead + 3 s margin until the clock offset is measured, decided once per second
      assert.ok(leftAtSend > 1.5 && leftAtSend <= 9, `sent with ${leftAtSend.toFixed(1)} s left`);
    } finally { h.close(); }
  });

  await check("warnings: Keep warm once brings the warning back on the next timeout", async () => {
    const h = await harness({ answer: (m, b, n) => n === 1 ? "Keep warm" : never() });
    try {
      await h.run(700);
      assert.strictEqual(h.sent.length, 1, "one keep-alive");
      assert.strictEqual(h.warnings.length, 2, "warned again after Keep warm once");
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

  await check("noResponseAction keepWarmOnce: one keep-alive, then quiet", async () => {
    const h = await harness({ answer: never, settings: { noResponseAction: "keepWarmOnce" } });
    try {
      await h.run(700);
      assert.strictEqual(h.sent.length, 1, "one keep-alive");
      assert.strictEqual(h.warnings.length, 1, "no warning after it was ignored");
    } finally { h.close(); }
  });

  await check("noResponseAction autoKeepWarm: keeps warm up to 50% of the expiry cost, then summary", async () => {
    const h = await harness({ answer: never, settings: { noResponseAction: "autoKeepWarm" } });
    try {
      const start = core.analyze("/x", fs.readFileSync(h.logFile, "utf8"), MODELS, h.clock);
      const cap = start.cost.missExtra / 2;
      await h.run(300 * 30, () => h.sent.some(x => !x.text.includes("Keep-alive")));
      const alives = h.sent.filter(x => x.text.includes("Keep-alive"));
      assert.ok(h.sent[h.sent.length - 1].text.includes("handoff summary"), "ends with a summary");
      assert.ok(alives.length >= 3, `${alives.length} keep-alives`);
      // estimate at each send, as the extension counted it: under the cap, and one more would not fit
      const per = start.cost.heartbeat;
      assert.ok(alives.length * per <= cap * 1.05 && (alives.length + 2) * per > cap,
        `${alives.length} keep-alives at ~${per.toFixed(2)} cr vs cap ${cap.toFixed(2)}`);
      assert.strictEqual(h.warnings.length, 1);
    } finally { h.close(); }
  });

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
