// Pure logic: read a Copilot Agent Debug Log session and price the cache options.
// No VS Code API here. File access goes through an `io` object, so the same code reads local
// files (tests, node) or remote ones through VS Code (the extension runs on the Windows side and
// reads logs inside WSL, containers or SSH hosts).
//
//   io = { join(...parts), readText(path) -> Promise<string|null>,
//          stat(path) -> Promise<{mtime}|null>, list(dir) -> Promise<string[]> }
"use strict";

const path = require("path");

const MARKER = "[cache-keeper]";
// Cache lifetimes are not in Copilot's price sheet. Copilot CLI logs them (cacheTtlSeconds);
// these defaults are what it reported, used when nothing better is known.
const DEFAULT_TTLS = [["claude", 300], ["gpt-6.1-sol", 1800]];
const UNKNOWN_TTL = 300;       // assume the short lifetime for other models
const KEEPALIVE_MIN_NEW = 400; // never assume a keep-alive adds fewer uncached tokens than this
const KEEPALIVE_NEW = 600;     // tokens a keep-alive adds uncached besides the agent's last reply
                               // (VS Code's per-message context block + our one-line message)
const HEARTBEAT_OUT = 30;      // "OK"
const SUMMARY_CALLS = 2;       // write the file, then confirm
const TOKENS_PER_WORD = 1.4;
const EDIT_TOOLS = /apply_patch|create_file|replace_string|insert_edit|edit_file|write_file|edit_notebook/i;

/** Local disk access, for tests and command-line use. */
const nodeIo = (() => {
  const fs = require("fs");
  return {
    join: (...p) => path.join(...p),
    readText: async p => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
    stat: async p => { try { return { mtime: fs.statSync(p).mtimeMs }; } catch { return null; } },
    list: async d => { try { return fs.readdirSync(d); } catch { return []; } },
  };
})();

/**
 * Handoff summary length in words, from what the chat contains: context size, your messages,
 * compactions (VS Code summarized the history) and files edited. Between 150 and 1500.
 */
function summaryWords(stats) {
  const w = 120 + 2 * stats.ctx / 1000 + 30 * stats.turns + 150 * stats.compactions + 10 * stats.files;
  return Math.round(Math.min(1500, Math.max(150, w)) / 50) * 50;
}

let learnedTtls = {};          // model id -> seconds, from Copilot CLI logs

/** Read cacheTtlSeconds per model from Copilot CLI session logs under `home`, if any. */
async function learnTtls(io = nodeIo, home = require("os").homedir(), maxFiles = 30) {
  const dir = io.join(home, ".copilot", "session-state");
  const found = {};
  const re = /"modelId":"([^"]+)","cacheExpiresAt":"[^"]*","cacheTtlSeconds":(\d+)/g;
  for (const n of (await io.list(dir)).slice(-maxFiles)) {
    const text = await io.readText(io.join(dir, n, "events.jsonl"));
    if (text) for (const m of text.matchAll(re)) found[m[1]] = Number(m[2]);
  }
  if (Object.keys(found).length) learnedTtls = found;
  return learnedTtls;
}

function ttlFor(model, overrides = {}) {
  model = model || "";
  if (overrides[model]) return overrides[model];
  if (learnedTtls[model]) return learnedTtls[model];
  const hit = DEFAULT_TTLS.find(([prefix]) => model.startsWith(prefix));
  return hit ? hit[1] : UNKNOWN_TTL;
}

function parseJsonl(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line while being written */ }
  }
  return out;
}

/**
 * The price sheet Copilot sent for this chat (models.json, saved per chat), for this model.
 * Returns null when the model is not in it: costs are then unknown and nothing is automated.
 */
function priceSheetFrom(modelsText, model) {
  try {
    const models = JSON.parse(modelsText);
    const m = models.find(x => x.id === model) ||
              models.find(x => (x.capabilities && x.capabilities.family) === model);
    return m && m.billing && m.billing.token_prices ? m.billing.token_prices : null;
  } catch { return null; }
}

/** Credits per token for a prompt of `ctx` tokens: the first tier whose limit fits. */
function rates(sheet, ctx) {
  const batch = sheet.batch_size;
  if (!batch) return { read: 0, write: 0, out: 0 };          // free model
  const tiers = Object.values(sheet).filter(t => t && typeof t === "object")
    .sort((a, b) => (a.max_prompt_tokens || Infinity) - (b.max_prompt_tokens || Infinity));
  const t = tiers.find(x => ctx <= (x.max_prompt_tokens || Infinity)) || tiers[tiers.length - 1];
  return {
    read: (t.cache_read_price || 0) / batch,
    write: (t.cache_write_price || t.input_price || 0) / batch,
    out: (t.output_price || 0) / batch,
  };
}

/** State of one chat from its log text, or null if it has no agent call yet. Pure. */
function analyze(dir, mainText, modelsText, now = Date.now(), ttlOverrides = {}) {
  const events = parseJsonl(mainText);
  const calls = events.filter(e => e.type === "llm_request" && e.attrs &&
    String(e.attrs.debugName || "").startsWith("panel/") && "inputTokens" in e.attrs);
  if (!calls.length) return null;
  calls.sort((a, b) => a.ts - b.ts);
  const last = calls[calls.length - 1];
  const a = last.attrs;
  const model = a.model || "?";
  const ctx = a.inputTokens;                         // after any compaction: what a miss re-sends
  // Size of a fresh chat's first prompt: about the session's first call, minus any big
  // attachments in that first message (capped).
  const firstCtx = Math.min(calls[0].attrs.inputTokens, 40000);
  const lastEnd = last.ts + (last.dur || 0);
  const credits = calls.reduce((s, c) => s + (c.attrs.copilotUsageNanoAiu || 0), 0) / 1e9;
  const userMessages = events.filter(e => e.type === "user_message");
  const lastUser = userMessages[userMessages.length - 1];
  const isOurs = u => String((u.attrs && u.attrs.content) || "").startsWith(MARKER);
  // Busy: a message was sent or a turn started after the last turn ended. (Not "the log changed":
  // VS Code also appends discovery lines to a chat's log when another chat is opened.)
  const lastStart = Math.max(0, ...events.filter(e => e.type === "turn_start" || e.type === "user_message").map(e => e.ts || 0));
  const lastTurnEnd = Math.max(0, ...events.filter(e => e.type === "turn_end").map(e => e.ts || 0));
  const busy = lastStart > lastTurnEnd && now - lastStart < 15 * 60 * 1000;   // cap: a turn that never logged its end
  const ttl = ttlFor(model, ttlOverrides);
  // What the chat contains, for sizing a handoff summary.
  const realTurns = userMessages.filter(u => !isOurs(u)).length;
  const compactions = events.filter(e => e.type === "llm_request" &&
    /summarizeConversationHistory/.test(String((e.attrs && e.attrs.debugName) || ""))).length;
  const files = new Set();
  for (const e of events) {
    if (e.type !== "tool_call" || !EDIT_TOOLS.test(e.name || "")) continue;
    const args = String((e.attrs && e.attrs.args) || "");
    for (const m of args.matchAll(/"(?:filePath|path|file)"\s*:\s*"([^"]+)"/g)) files.add(m[1]);
    for (const m of args.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\\\n]+)/g)) files.add(m[1].trim());
  }
  const stats = { ctx, turns: realTurns, compactions, files: files.size, calls: calls.length };
  const words = summaryWords(stats);
  // Tokens a keep-alive adds uncached: measured on this chat's earlier keep-alives when there are
  // any (exact); otherwise VS Code's context block + our message + the agent's last reply, which is
  // not cached yet. (Your own messages are a poor yardstick: they often bring files and tool output.)
  // Learn only the fixed part (what a keep-alive added minus the agent's reply just before it), then
  // add the current last reply: a keep-alive after a long answer adds more than one after "OK".
  const fixedParts = [];
  for (const u of userMessages.filter(isOurs)) {
    const i = calls.findIndex(c => c.ts >= u.ts);
    if (i <= 0) continue;
    const uncached = (calls[i].attrs.inputTokens || 0) - (calls[i].attrs.cachedTokens || 0);
    fixedParts.push(Math.max(0, uncached - (calls[i - 1].attrs.outputTokens || 0)));
  }
  const recent = fixedParts.slice(-5).sort((x, y) => x - y);
  // floor: the previous "reply" can include reasoning tokens that never enter the context, which
  // would make the learned fixed part look smaller than it is
  const fixedNew = recent.length ? Math.max(KEEPALIVE_MIN_NEW, recent[Math.floor(recent.length / 2)]) : KEEPALIVE_NEW;
  const heartbeatNew = fixedNew + (a.outputTokens || 0);
  const sheet = modelsText ? priceSheetFrom(modelsText, model) : null;
  let cost = null;                                   // null = price unknown for this model
  if (sheet) {
    const r = rates(sheet, ctx);                     // tier that applies at the current context size
    const fresh = rates(sheet, firstCtx);
    const hit = ctx * r.read;
    cost = {
      heartbeat: hit + heartbeatNew * r.write + HEARTBEAT_OUT * r.out,
      missExtra: ctx * r.write - hit,                // what letting the cache expire adds to the next message
      summary: SUMMARY_CALLS * hit + words * TOKENS_PER_WORD * (r.out + r.write),
      restart: (firstCtx + words * TOKENS_PER_WORD) * fresh.write, // first message of a new chat built from the summary
    };
  }
  const firstReal = userMessages.find(u => !isOurs(u));
  const title = firstReal ? String(firstReal.attrs.content).replace(/\s+/g, " ").trim() : "";
  return {
    id: String(dir).split(/[\\/]/).filter(Boolean).pop(), dir, model, ctx, ttl, lastEnd, busy, credits,
    cost, stats, summaryWords: words,
    // The cache is refreshed when a call starts (the prompt is read), not when its answer ends.
    cacheFrom: last.ts,
    remaining: ttl - (now - last.ts) / 1000,
    lastUserText: lastUser && lastUser.attrs ? String(lastUser.attrs.content || "") : "",
    lastUserTs: lastUser ? lastUser.ts : 0,
    title: title.length > 50 ? title.slice(0, 47) + "..." : title,   // which chat a warning is about
    // Last message you typed yourself (not one of ours): tells whether a handoff is still current.
    lastRealUserTs: Math.max(0, ...userMessages.filter(u => !isOurs(u)).map(u => u.ts || 0)),
  };
}

async function readSession(io, dir, now = Date.now(), ttlOverrides = {}) {
  const main = await io.readText(io.join(dir, "main.jsonl"));
  if (main === null) return null;
  return analyze(dir, main, await io.readText(io.join(dir, "models.json")), now, ttlOverrides);
}

/** All chats under a debug-logs folder whose log changed in the last `maxAgeMs`. */
async function readSessions(io, root, now = Date.now(), maxAgeMs = 3 * 3600 * 1000, ttlOverrides = {}) {
  const out = [];
  for (const n of await io.list(root)) {
    const dir = io.join(root, n);
    const st = await io.stat(io.join(dir, "main.jsonl"));
    if (!st || now - st.mtime > maxAgeMs) continue;
    const s = await readSession(io, dir, now, ttlOverrides);
    if (s) out.push(s);
  }
  return out.sort((x, y) => y.lastEnd - x.lastEnd);
}

/**
 * "Keep warm while worth it": keep sending heartbeats while that stays cheaper than the
 * cheapest way out. Ways out: let it expire (missExtra) or summary + new chat (summary + restart).
 * Before the budget would be exceeded, the caller writes the summary and stops.
 */
function canAffordHeartbeat(session, spentSoFar) {
  const c = session.cost;
  if (!c) return false;
  const budget = Math.min(c.missExtra, c.summary + c.restart);
  return spentSoFar + c.heartbeat + c.summary <= budget;
}

function fmt(credits) {
  return credits >= 10 ? credits.toFixed(0) : credits.toFixed(1);
}

module.exports = {
  MARKER, nodeIo, analyze, readSession, readSessions, canAffordHeartbeat, ttlFor, learnTtls,
  rates, priceSheetFrom, fmt, summaryWords,
};
