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

  await check("canAffordHeartbeat: stops before keeping warm costs more than the cheapest way out", () => {
    const s = { cost: { heartbeat: 3, missExtra: 72, summary: 9, restart: 14 } };
    assert.strictEqual(core.canAffordHeartbeat(s, 0), true);
    assert.strictEqual(core.canAffordHeartbeat(s, 12), false);   // 12 + 3 + 9 > min(72, 23)
  });

  // ---------------------------------------------------------------- extension with a stand-in VS Code

  await check("extension: activates, reads logs, sends a keep-alive 5 s before expiry", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-smoke-"));
    const storage = path.join(tmp, "workspaceStorage", "ws1");
    const logs = path.join(storage, "GitHub.copilot-chat", "debug-logs");
    let clock = now;
    const sent = [];
    const fakeFs = {
      stat: async u => ({ mtime: fs.statSync(u.fsPath).mtimeMs }),
      readFile: async u => fs.readFileSync(u.fsPath),
      writeFile: async (u, b) => fs.writeFileSync(u.fsPath, b),
      readDirectory: async u => fs.readdirSync(u.fsPath).map(n => [n, 1]),
    };
    const settings = { warnSeconds: 60, thresholdCredits: 60, autoSummary: true, minCredits: 5, ttlSeconds: {},
                       keepAliveLeadSeconds: 5, afterSend: "closeTab" };
    const tab = { label: "chat", input: {} };
    const vscode = {
      env: { remoteName: undefined },
      workspace: { getConfiguration: () => ({ get: k => settings[k] }), fs: fakeFs,
                   workspaceFolders: [{ uri: { scheme: "file", fsPath: tmp, path: tmp } }] },
      window: {
        createStatusBarItem: () => ({ show() {}, hide() {}, text: "" }),
        createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
        showWarningMessage: async () => "Auto keep warm",    // the user picks Auto keep warm
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
          if (id === "workbench.action.chat.submit") sent.push({ at: clock, text: a.inputValue });
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
    try {
      const ext = require("../extension");
      fs.mkdirSync(logs, { recursive: true });
      ext.activate({ storageUri: { fsPath: path.join(storage, "local.copilot-cache-keeper") }, subscriptions: [] });
      await ext._read();                                  // first read: no chats yet
      clock += 2000;
      const chat = path.join(logs, "sess-1");
      fs.mkdirSync(chat);
      fs.writeFileSync(path.join(chat, "models.json"), MODELS);
      fs.writeFileSync(path.join(chat, "main.jsonl"), chatLog(clock - 7000, { ctx: 40000 }));
      await ext._read();
      // walk the clock to the cache expiry, deciding every second like the extension does
      for (let i = 0; i < 300 && !sent.length; i++) {
        clock += 1000;
        if (i % 5 === 0) await ext._read();
        await ext._decide();
        await new Promise(r => realSetInterval ? setImmediate(r) : r());
      }
      assert.strictEqual(sent.length, 1, "one keep-alive sent");
      assert.ok(sent[0].text.startsWith("[cache-keeper] Keep-alive"), sent[0].text);
      const startedCall = (now + 2000 - 7000) + 4000;       // last call's start in the fixture
      const leftAtSend = 300 - (sent[0].at - startedCall) / 1000;
      // 5 s lead + 3 s margin until the clock offset is measured, decided once per second
      assert.ok(leftAtSend > 1.5 && leftAtSend <= 9, `sent with ${leftAtSend.toFixed(1)} s left`);
    } finally {
      Module._load = load;
      Date.now = realNow;
      global.setInterval = realSetInterval;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
