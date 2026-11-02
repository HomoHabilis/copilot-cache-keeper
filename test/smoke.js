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

// ---------------------------------------------------------------- extension with a stand-in VS Code

/**
 * Load a fresh copy of the extension against a fake VS Code and one chat whose last call started
 * 3 s ago. `answer(msg, buttons, n)` is the user's reaction to the n-th warning: a button label,
 * undefined (closed with X) or a promise that never settles (not answered). Messages Cache Keeper
 * submits land in the chat's log with a short reply, so each one starts a new cache window.
 */
async function harness({ answer, settings: extra = {}, ctx = 40000, first, busyOnOpen = false, menu = () => undefined }) {
  const now = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-smoke-"));
  const storage = path.join(tmp, "workspaceStorage", "ws1");
  const logs = path.join(storage, "GitHub.copilot-chat", "debug-logs");
  const chat = path.join(logs, "sess-1");
  let clock = now;
  const sent = [], warnings = [], commands = {}, ran = [];
  let status;
  const fakeFs = {
    stat: async u => ({ mtime: fs.statSync(u.fsPath).mtimeMs }),
    readFile: async u => fs.readFileSync(u.fsPath),
    writeFile: async (u, b) => fs.writeFileSync(u.fsPath, b),
    readDirectory: async u => fs.readdirSync(u.fsPath).map(n => [n, 1]),
  };
  const settings = { warnSeconds: 60, thresholdTokens: 100000, autoSummary: true, minCredits: 5, ttlSeconds: {},
                     keepAliveLeadSeconds: 5, keepAliveJitterPercent: 0, afterSend: "closeTab",
                     autoKeepWarmCapPercent: 50, ...extra };
  const tab = { label: "chat", input: {} };
  const append = evs => fs.appendFileSync(path.join(chat, "main.jsonl"), evs.map(e => JSON.stringify(e)).join("\n") + "\n");
  let lastCtx = ctx;
  const vscode = {
    env: { remoteName: undefined },
    workspace: { getConfiguration: () => ({ get: k => settings[k] }), fs: fakeFs,
                 workspaceFolders: [{ uri: { scheme: "file", fsPath: tmp, path: tmp } }] },
    window: {
      createStatusBarItem: () => (status = { show() {}, hide() {}, text: "" }),
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      showWarningMessage: async (msg, ...buttons) => { warnings.push({ at: clock, msg }); return answer(msg, buttons, warnings.length); },
      showInformationMessage: async () => undefined,
      showErrorMessage: async m => { throw new Error("unexpected error message: " + m); },
      showQuickPick: async items => menu(items),
      // the status-bar list: picks the first chat
      createQuickPick: () => { const qp = { items: [], activeItems: [], selectedItems: [], dispose() {},
        onDidAccept: f => { qp.accept = f; }, onDidHide() {},
        show() { qp.selectedItems = [qp.items[0]]; setImmediate(() => qp.accept()); } }; return qp; },
      tabGroups: { all: [{ tabs: [] }], get activeTabGroup() { return this.all[0]; }, close: async () => {} },
    },
    commands: {
      registerCommand: (id, f) => { commands[id] = f; return { dispose() {} }; },
      executeCommand: async (id, a) => {
        ran.push({ id, a });
        if (id === "workbench.action.chat.openSessionInEditorGroup") {
          vscode.window.tabGroups.all[0].tabs = [tab]; vscode.window.tabGroups.all[0].activeTab = tab;
          // the agent starts working (e.g. a subagent) while the tab is being opened
          if (busyOnOpen) append([{ type: "turn_start", ts: clock }]);
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
    StatusBarAlignment: { Right: 2 },
    MarkdownString: class { constructor(v) { this.value = v; } includes(x) { return this.value.includes(x); } toString() { return this.value; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
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
  fs.writeFileSync(path.join(chat, "main.jsonl"), chatLog(clock - 7000, { ctx, ...(first ? { first } : {}) }));
  await ext._read();
  const h = {
    sent, warnings, commands, ran, dir: tmp, ext, get status() { return status; }, logFile: path.join(chat, "main.jsonl"), cacheFrom: clock - 7000 + 4000,
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
      ["en", "`il lo gli che non per` https://example.com/il/che/non"],     // code and links don't count
    ];
    for (const [lang, text] of cases) assert.strictEqual(core.detectLanguage([text]), lang, text);
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

  await check("expired chat: orange status only when its context is at least thresholdTokens", async () => {
    for (const [threshold, orange] of [[30000, true], [100000, false]]) {     // the chat has 40k tokens
      const h = await harness({ answer: () => undefined, settings: { thresholdTokens: threshold, autoSummary: false } });
      try {
        await h.run(400);
        assert.strictEqual(h.sent.length, 0);
        assert.ok(h.status.text.includes("cache expired"), h.status.text);
        const bg = (h.status.backgroundColor || {}).id;
        assert.strictEqual(bg === "statusBarItem.warningBackground", orange, `threshold ${threshold}: ${bg}`);
        assert.strictEqual(h.status.text.includes("$(warning)"), orange, h.status.text);
        assert.strictEqual(h.status.tooltip.value.includes("thresholdTokens"), orange, h.status.tooltip);
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

  await check("expired chat with a handoff summary: tooltip gives the new-chat cost", async () => {
    const h = await harness({ answer: () => "Summarize", settings: { thresholdTokens: 30000 } });
    try {
      await h.run(900);
      assert.ok(h.sent.some(x => x.text.includes("handoff summary")), "summary written");
      assert.ok(h.status.text.includes("cache expired"), h.status.text);
      assert.ok(/Handoff summary ready: a new chat from it ≈ [\d.]+ cr/.test(h.status.tooltip.value), h.status.tooltip);
    } finally { h.close(); }
  });

  await check("status-bar list offers New chat from handoff once a summary file exists", async () => {
    let offered;
    const h = await harness({ answer: () => "Summarize", settings: { thresholdTokens: 30000 },
      menu: items => { offered = items.map(i => i.label); return items.find(i => i.label === "New chat from handoff"); } });
    try {
      await h.run(900);
      const m = h.sent.map(x => x.text.match(/`([^`]+\.md)`/)).find(Boolean);
      assert.ok(m, "summary asks for a file");
      fs.mkdirSync(path.dirname(path.join(h.dir, m[1])), { recursive: true });
      fs.writeFileSync(path.join(h.dir, m[1]), "# handoff");     // the agent wrote it
      await h.commands["cacheKeeper.options"]();
      assert.strictEqual(offered[0], "New chat from handoff", offered.join(", "));
      const open = h.ran.find(x => x.id === "workbench.action.chat.open");
      assert.ok(open && open.a.attachFiles[0].fsPath.endsWith(m[1]), "new chat opened with the handoff attached");
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

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
