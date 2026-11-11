// Spend report: what your Copilot chats cost over the last N days, and what drove it. Pure (no
// VS Code): the extension reads the chats (extension.js, spendReport) and hands each one's event
// list (harnesses.js) here. Same prices and cache lifetimes as the warnings (core.js).
//
// A deeper, offline analysis (reasoning effort, tool definitions, older chats without debug logs,
// Copilot CLI, OpenCode, logs from another machine) is the Python helper in tools/spend-analyzer.
"use strict";
const core = require("./core");

const MISS_MIN_CTX = 30000;     // ignore misses on small prompts
const MISS_CACHED_BELOW = 0.5;  // less than half the prompt cached: a miss
const TYPICAL_NEW = 1000;       // tokens a normal message adds uncached (not part of a miss)
const BIG_CTX = 100000;         // above this, the context is re-read (at the cache price) on every call
const KIND_NAME = { local: "Local", sdk: "Copilot SDK", claude: "Claude", codex: "Codex" };

/** Credits for one call: as billed when the log says, else from the per-token rates. */
function callCredits(c, sheet) {
  if (typeof c.credits === "number") return c.credits;
  const r = c.rates || (sheet && core.rates(sheet, c.input || 0));
  if (!r) return null;
  const cached = c.cached || 0, written = c.written || 0, fresh = Math.max(0, (c.input || 0) - cached - written);
  return cached * r.read + (written + fresh) * r.write + (c.out || 0) * r.out;
}

/**
 * chats: [{ kind, id, title, workspace, events, sheetFor(model) -> price sheet or null,
 *           billed? (credits Copilot billed for the whole chat: estimates are scaled to it) }]
 * Returns the calls of the period, with credits, and the figures for the report.
 */
function analyzeSpend(chats, { since = 0, now = Date.now(), ttlOverrides = {} } = {}) {
  const calls = [], misses = [], perChat = [];
  let unpriced = 0;
  const unpricedModels = new Set();
  for (const ch of chats) {
    const all = (ch.events || []).filter(e => e.t === "call");
    if (!all.length) continue;
    const sheetFor = ch.sheetFor || (() => null);
    const priced = all.map(c => ({ c, credits: callCredits(c, sheetFor(c.model)) }));
    // estimates scaled to what Copilot billed for this chat (Claude's session.db)
    const est = priced.filter(p => typeof p.c.credits !== "number" && p.credits !== null);
    const estSum = est.reduce((a, p) => a + p.credits, 0);
    if (ch.billed > 0 && estSum > 0 && est.length === priced.length) for (const p of est) p.credits *= ch.billed / estSum;
    const mine = { kind: ch.kind, id: ch.id, title: ch.title || String(ch.id).slice(0, 8), workspace: ch.workspace || "",
                   calls: 0, credits: 0, misses: 0, missCredits: 0, maxCtx: 0, first: 0, last: 0 };
    for (let i = 0; i < priced.length; i++) {
      const { c, credits } = priced[i];
      if (c.ts < since || c.ts > now) continue;
      if (credits === null) { unpriced++; unpricedModels.add(c.model || "?"); }
      const rec = { kind: ch.kind, chat: mine.title, chatId: ch.id, workspace: mine.workspace, ts: c.ts, model: c.model || "?",
                    ctx: c.input || 0, cached: c.cached || 0, out: c.out || 0, credits: credits || 0 };
      calls.push(rec);
      Object.assign(mine, { calls: mine.calls + 1, credits: mine.credits + rec.credits, maxCtx: Math.max(mine.maxCtx, rec.ctx),
                            first: mine.first || c.ts, last: c.ts });
      // a miss: most of a large prompt sent again uncached, after an earlier call of this chat
      if (i === 0 || rec.ctx < MISS_MIN_CTX || rec.cached >= MISS_CACHED_BELOW * rec.ctx) continue;
      const prev = priced[i - 1].c;
      const pause = (c.ts - (prev.end || prev.ts)) / 1000;
      const ttl = c.ttl || core.ttlFor(rec.model, ttlOverrides);
      const sheet = sheetFor(rec.model), r = c.rates || (sheet && core.rates(sheet, rec.ctx));
      const resent = Math.max(0, rec.ctx - rec.cached - TYPICAL_NEW);
      const extra = r ? resent * Math.max(0, r.write - r.read) : 0;
      misses.push({ ...rec, pause, ttl, expired: pause > ttl, extra });
      mine.misses++; mine.missCredits += extra;
    }
    if (mine.calls) perChat.push(mine);
  }
  const total = calls.reduce((a, c) => a + c.credits, 0);
  // context above BIG_CTX, re-read at the cache price on every call
  const bigCtx = calls.reduce((a, c) => {
    const ch = chats.find(x => x.id === c.chatId), sheet = ch && ch.sheetFor ? ch.sheetFor(c.model) : null;
    const r = sheet && core.rates(sheet, c.ctx);
    return a + (r && c.ctx > BIG_CTX ? (c.ctx - BIG_CTX) * r.read : 0);
  }, 0);
  const expired = misses.filter(m => m.expired), other = misses.filter(m => !m.expired);
  const sum = xs => xs.reduce((a, m) => a + m.extra, 0);
  const groups = new Map();
  for (const c of calls) {
    const k = `${c.kind}|${c.model}`;
    if (!groups.has(k)) groups.set(k, { kind: c.kind, model: c.model, calls: 0, credits: 0, ctx: [], cached: 0, input: 0 });
    const g = groups.get(k);
    g.calls++; g.credits += c.credits; g.ctx.push(c.ctx); g.cached += c.cached; g.input += c.ctx;
  }
  const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
  return {
    total, calls: calls.length, chats: perChat.length, unpriced, unpricedModels: [...unpricedModels].sort(),
    factors: [
      { name: "Expired caches after pauses", credits: sum(expired), count: expired.length,
        todo: "Reply within the cache lifetime, or let Cache Keeper keep it warm, summarize or compact before it expires." },
      { name: "Other cache misses", credits: sum(other), count: other.length,
        todo: "Compactions, or a mode, model or tool change mid-chat, re-send the whole prompt: avoid switching mid-chat." },
      { name: `Context above ${BIG_CTX / 1000}k re-read on every call`, credits: bigCtx, count: calls.filter(c => c.ctx > BIG_CTX).length,
        todo: "Start a new chat per task (a handoff summary carries what matters)." },
    ].sort((a, b) => b.credits - a.credits),
    byModel: [...groups.values()].map(g => ({ kind: g.kind, model: g.model, calls: g.calls, credits: g.credits,
      medianCtx: median(g.ctx), cachedShare: g.input ? g.cached / g.input : 0 })).sort((a, b) => b.credits - a.credits),
    byKind: Object.keys(KIND_NAME).map(k => ({ kind: k, credits: calls.filter(c => c.kind === k).reduce((a, c) => a + c.credits, 0),
      chats: perChat.filter(c => c.kind === k).length })).filter(x => x.chats),
    topMisses: [...misses].sort((a, b) => b.extra - a.extra).slice(0, 10),
    topChats: [...perChat].sort((a, b) => b.credits - a.credits).slice(0, 10),
  };
}

const cr = x => x >= 100 ? Math.round(x).toLocaleString("en-US") : x >= 10 ? x.toFixed(1) : x.toFixed(2);
const k = x => `${Math.round(x / 1000)}k`;
const dur = s => s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`;
const day = ts => { const d = new Date(ts), p = n => String(n).padStart(2, "0"); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const cell = t => String(t).replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 60);

/** The report as Markdown. `where`: what was read (one line per source). */
function spendMarkdown(a, { days, where = [], date = new Date() } = {}) {
  const L = [];
  const pct = x => a.total ? `${Math.round(100 * x / a.total)}%` : "-";
  L.push(`# Copilot spend, last ${days} days`, "",
    `${date.toISOString().slice(0, 10)} · **${cr(a.total)} credits** ($${(a.total / 100).toFixed(2)}) · ${a.calls} model calls · ${a.chats} chats` +
    (a.byKind.length ? ` · ${a.byKind.map(x => `${KIND_NAME[x.kind]} ${cr(x.credits)} cr`).join(", ")}` : ""), "");
  if (a.unpriced) L.push(`**Warning:** ${a.unpriced} model call(s) have no known price (${a.unpricedModels.join(", ")}) and count as 0: ` +
    "totals and savings are incomplete. Copilot's price sheet comes from a Local chat's debug log on this side; " +
    "one Local chat here is enough to get it.", "");
  if (!a.calls) { L.push("No model call in this period.", ""); }
  else {
    L.push("## What drove it", "", "Credits you could have avoided (estimates; they overlap).", "",
      "| | Credits | Share | Calls | What to do |", "|---|---:|---:|---:|---|");
    for (const f of a.factors) L.push(`| ${f.name} | ${cr(f.credits)} | ${pct(f.credits)} | ${f.count} | ${f.todo} |`);
    L.push("", "## By harness and model", "", "| Harness | Model | Calls | Credits | Median context | Cached |", "|---|---|---:|---:|---:|---:|");
    for (const g of a.byModel) L.push(`| ${KIND_NAME[g.kind]} | ${g.model} | ${g.calls} | ${cr(g.credits)} | ${k(g.medianCtx)} | ${Math.round(100 * g.cachedShare)}% |`);
    if (a.topMisses.length) {
      L.push("", "## Costliest cache misses", "", "| When | Chat | Harness | Model | Context | Pause | Lifetime | Extra credits |",
        "|---|---|---|---|---:|---:|---:|---:|");
      for (const m of a.topMisses) L.push(`| ${day(m.ts)} | ${cell(m.chat)} | ${KIND_NAME[m.kind]} | ${m.model} | ${k(m.ctx)} | ${dur(m.pause)} | ` +
        `${dur(m.ttl)} | ${cr(m.extra)}${m.expired ? "" : " (not a pause)"} |`);
    }
    L.push("", "## Costliest chats", "", "| Chat | Harness | Workspace | Calls | Credits | Misses | Max context | Last call |",
      "|---|---|---|---:|---:|---:|---:|---|");
    for (const c of a.topChats) L.push(`| ${cell(c.title)} | ${KIND_NAME[c.kind]} | ${cell(c.workspace)} | ${c.calls} | ${cr(c.credits)} | ` +
      `${c.misses ? `${c.misses} (${cr(c.missCredits)} cr)` : "0"} | ${k(c.maxCtx)} | ${day(c.last)} |`);
  }
  L.push("", "## How it is computed", "",
    "- Credits: as billed where the log says (Local, Copilot SDK; Claude scaled to the credits Copilot billed for the chat), " +
    "else from Copilot's price sheet (Codex). 1 credit = $0.01.",
    "- A cache miss: a call with at least 30k tokens of context and less than half of it cached. It is an expired cache when " +
    "the pause since the chat's previous call was longer than the model's cache lifetime. Extra credits: the re-sent part " +
    "at the uncached price minus the cache price.",
    "- Read on this window's side (Windows, WSL, SSH host or container): Local chats of every workspace, and the Copilot SDK, " +
    "Claude and Codex chats VS Code created. Your own Claude Code sessions are not Copilot spend and are left out.",
    "- For reasoning effort, tool definitions, older chats, Copilot CLI and OpenCode, run tools/spend-analyzer/analyze_spend.py " +
    "(Python) from the repository.");
  if (where.length) L.push("", "Read:", "", ...where.map(w => `- ${w}`));
  return L.join("\n") + "\n";
}

module.exports = { analyzeSpend, spendMarkdown, callCredits };
