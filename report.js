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
const KIND_NAME = { local: "Local", "local-msg": "Local, per message", sdk: "Copilot SDK", claude: "Claude", codex: "Codex" };

/**
 * Per-token credits for a call: what its log says it was billed (Copilot SDK: cache_read, cache_write,
 * input, output), else Copilot's price sheet at this prompt size. Null when unknown.
 */
function callRates(c, sheet) {
  const p = c.rates;
  if (p && (p.cache_read !== undefined || p.input !== undefined))
    return { read: p.cache_read || 0, write: p.cache_write || p.input || 0, out: p.output || 0 };
  return sheet ? core.rates(sheet, c.input || 0) : null;
}

/** Credits for one call: as billed when the log says, else from the per-token rates. */
function callCredits(c, sheet) {
  if (typeof c.credits === "number") return c.credits;
  const r = callRates(c, sheet);
  if (!r) return null;
  const cached = c.cached || 0, written = c.written || 0, fresh = Math.max(0, (c.input || 0) - cached - written);
  return cached * r.read + (written + fresh) * r.write + (c.out || 0) * r.out;
}

const EFFORT_ORDER = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
const DEFAULT_CALLS_PER_MESSAGE = 8;   // model calls in one message, when no debug log shows it
const DEFAULT_TOOL_SHARE = 0.45;       // tool definitions' share of a prompt, when no chat file says it

// like Python's statistics.median (the middle two averaged), so this report and the Python helper agree
const median = xs => {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return !n ? 0 : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const mean = xs => xs.reduce((a, x) => a + x, 0) / xs.length;

/** The first (base) price tier's prompt limit when the sheet has several tiers (long-context pricing), else null. */
function tierMax(sheet) {
  const tiers = Object.values(sheet || {}).filter(t => t && typeof t === "object")
    .sort((a, b) => (a.max_prompt_tokens || Infinity) - (b.max_prompt_tokens || Infinity));
  return tiers.length > 1 ? tiers[0].max_prompt_tokens || null : null;
}

/**
 * Model calls per message you sent, per model, from Local chats' debug logs (median), to spread a
 * per-message record of an older chat over its calls.
 */
function callsPerMessage(chats) {
  const per = {};
  for (const ch of chats) {
    if (ch.kind !== "local") continue;
    let count = null, model = null;
    for (const e of [...(ch.events || []), { t: "user" }]) {
      if (e.t === "user" && !core.isOwnMessage(e.text)) {
        if (count && model) (per[model] = per[model] || []).push(count);
        count = 0; model = null;
      } else if (e.t === "call" && count !== null) { count++; model = e.model; }
    }
  }
  const out = {};
  for (const [m, v] of Object.entries(per)) out[m] = median(v);
  return out;
}

/**
 * chats: [{ kind, id, title, workspace, events, sheetFor(model) -> price sheet or null,
 *           billed? (credits Copilot billed for the whole chat: estimates are scaled to it),
 *           billedTotal? (Copilot SDK: the session's billed total; what no call accounts for is added),
 *           subEvents? (Local: the chat's subagent logs), mcpFrac? (Local: MCP share of its tool
 *           definitions), toolShares? ([{ ts, share }]: tool definitions' share of each message's
 *           prompt, from its chat file) }]
 * kind "local-msg": a Local chat known only from VS Code's chat file (its debug log is gone), one
 * "call" per message with its billed credits and prompt size, `gap` (s since the previous message
 * ended), `ours` (Cache Keeper's message), `effort`, `toolShare`; no cached-token detail.
 * The figures follow the Python helper (tools/spend-analyzer), so the two reports agree.
 */
/**
 * Cache lifetimes proven in these Local chats' logs: per model, the longest gap after which a call
 * still hit the cache (core.provenGaps, the same evidence the warnings use).
 */
function measuredLifetimes(chats) {
  const out = {};
  for (const ch of chats) {
    if (ch.kind !== "local") continue;
    const evs = ch.events || [];
    const gaps = core.provenGaps(evs.filter(e => e.t === "call"), evs.filter(e => (e.t === "call" || e.t === "aux") && e.model));
    for (const [m, g] of Object.entries(gaps)) if (g > (out[m] || 0)) out[m] = g;
  }
  return out;
}

/**
 * A call's cache lifetime, from data only: what its log says (Copilot SDK, Claude's cache tier), your
 * cacheKeeper.ttlSeconds, what Copilot CLI/SDK logs say for the model, what these logs prove (at least
 * the built-in value), or the built-in value for the models whose lifetime is known (Claude, Sol 6.1).
 * Null for any other model: no expiry is judged without data.
 */
function lifetime(c, model, measured, overrides) {
  if (c && c.ttl) return c.ttl;
  if (overrides[model]) return overrides[model];
  if (core.ttlSource(model) === "Copilot CLI/SDK log") return core.ttlFor(model);
  // a measured gap is only a minimum: it counts once it beats the 5 min guess (or the known value) by
  // a margin, rounded down to the minute, the same rule as the warnings (core.setMeasuredTtls)
  const known = core.knownTtl(model);
  const m = measured[model];
  if (m && m > (known || core.defaultTtl(model)) + core.MEASURED_MARGIN) return Math.floor(m / 60) * 60;
  return known;
}

function analyzeSpend(chats, { since = 0, now = Date.now(), ttlOverrides = {} } = {}) {
  const recs = [], misses = [], perChat = [], compactionEvents = { count: 0 };
  const measured = measuredLifetimes(chats);
  const unknownLifetime = new Set();
  let unpriced = 0;
  const unpricedModels = new Set();
  const cpm = callsPerMessage(chats);
  const cpmFor = m => cpm[m] || (Object.keys(cpm).length ? median(Object.values(cpm)) : DEFAULT_CALLS_PER_MESSAGE);
  for (const ch of chats) {
    const sheetFor = ch.sheetFor || (() => null);
    const evs = ch.events || [];
    // every billed call: the agent's own, its side calls (titles, summaries, checks), compactions, subagents
    const items = [
      ...evs.filter(e => e.t === "call").map(c => ({ c, role: c.side ? "side" : ch.kind === "local-msg" ? "message" : "agent" })),
      ...evs.filter(e => e.t === "aux" && (e.input || e.credits)).map(c => ({ c, role: c.summary ? "compaction" : "side" })),
      ...(ch.subEvents || []).filter(e => (e.t === "call" || e.t === "aux") && (e.input || e.credits)).map(c => ({ c, role: "subagent" })),
    ];
    // compactions the log shows without their cost (Copilot SDK, Claude, Codex)
    if (ch.kind !== "local") compactionEvents.count += evs.filter(e => e.t === "compaction" && e.ts >= since && e.ts <= now).length;
    if (!items.length && !(ch.billedTotal > 0)) continue;
    for (const it of items) it.credits = callCredits(it.c, sheetFor(it.c.model));
    // billed in the session's total but with no call of its own (Copilot SDK: a compaction's call):
    // one more line, a compaction when the session had one, else a side call
    const logged = items.reduce((a, it) => a + (it.credits || 0), 0);
    if (ch.billedTotal > logged + 0.01) {
      const comps = evs.filter(e => e.t === "compaction");
      // when: its compaction, else the session's last call or message
      const at = comps.length ? comps[comps.length - 1].ts : Math.max(ch.lastTs || 0, ...items.map(it => it.c.ts));
      const latest = items.length ? items.reduce((x, y) => (y.c.ts > x.c.ts ? y : x)).c.model : "?";
      items.push({ c: { t: "call", ts: at, model: latest, input: 0, cached: 0, out: 0,
                        credits: ch.billedTotal - logged }, role: comps.length ? "compaction" : "side", credits: ch.billedTotal - logged });
    }
    // estimates scaled to what Copilot billed for this chat (Claude's session.db)
    const est = items.filter(it => typeof it.c.credits !== "number" && it.credits !== null);
    const estSum = est.reduce((a, it) => a + it.credits, 0);
    if (ch.billed > 0 && estSum > 0 && est.length === items.length) for (const it of est) it.credits *= ch.billed / estSum;
    const mine = { kind: ch.kind, id: ch.id, title: ch.title || String(ch.id).slice(0, 8), workspace: ch.workspace || "",
                   calls: 0, credits: 0, misses: 0, missCredits: 0, maxCtx: 0, first: 0, last: 0 };
    // tool definitions' share of the prompt: this chat's messages in the period (its chat file)
    const shares = (ch.toolShares || []).filter(x => x.ts >= since && x.ts <= now).map(x => x.share);
    const share = shares.length ? mean(shares) : null;
    let prevAgent = null;
    for (const it of items.sort((x, y) => x.c.ts - y.c.ts)) {
      const c = it.c, inPeriod = c.ts >= since && c.ts <= now;
      // the agent's calls and its compactions (summarizing calls) are checked for misses, as in the Python helper
      const isAgent = it.role === "agent" || it.role === "compaction";
      if (!inPeriod) { if (isAgent) prevAgent = c; continue; }
      if (it.credits === null) { unpriced++; unpricedModels.add(c.model || "?"); }
      const rec = { kind: ch.kind, role: it.role, chat: mine.title, chatId: ch.id, workspace: mine.workspace, ts: c.ts, model: c.model || "?",
                    ctx: c.input || 0, cached: c.cached || 0, out: c.out || 0, credits: it.credits || 0, effort: c.effort,
                    toolShare: share !== null ? share : c.toolShare, mcpFrac: ch.mcpFrac, sheet: sheetFor(c.model || "?") };
      recs.push(rec);
      Object.assign(mine, { calls: mine.calls + 1, credits: mine.credits + rec.credits, maxCtx: Math.max(mine.maxCtx, rec.ctx),
                            first: mine.first || c.ts, last: Math.max(mine.last, c.ts) });
      if (it.role === "message") {
        // per message: an expired cache when the pause before it was longer than the lifetime
        const ttl = lifetime(c, rec.model, measured, ttlOverrides), r = rec.sheet && core.rates(rec.sheet, rec.ctx);
        if (!ttl) { unknownLifetime.add(rec.model); continue; }   // no data: not judged
        if (c.gap !== undefined && c.gap !== null && !c.ours && rec.ctx >= MISS_MIN_CTX && c.gap >= ttl) {
          const extra = r ? Math.max(0, rec.ctx - TYPICAL_NEW) * Math.max(0, r.write - r.read) : 0;
          misses.push({ ...rec, pause: c.gap, ttl, expired: true, extra });
          mine.misses++; mine.missCredits += extra;
        }
        continue;
      }
      if (!isAgent) continue;
      // a miss: most of a large prompt sent again uncached, after an earlier call of this chat
      const prev = prevAgent;
      prevAgent = c;
      if (!prev || rec.ctx < MISS_MIN_CTX || rec.cached >= MISS_CACHED_BELOW * rec.ctx) continue;
      const pause = (c.ts - prev.ts) / 1000;     // the cache is refreshed when a request starts
      const ttl = lifetime(c, rec.model, measured, ttlOverrides);
      if (!ttl) unknownLifetime.add(rec.model);
      const r = callRates(c, rec.sheet);
      const extra = r ? Math.max(0, rec.ctx - rec.cached - TYPICAL_NEW) * Math.max(0, r.write - r.read) : 0;
      misses.push({ ...rec, pause, ttl, expired: !!ttl && pause >= ttl - 5, extra });
      mine.misses++; mine.missCredits += extra;
    }
    if (mine.calls) perChat.push(mine);
  }
  const total = recs.reduce((a, c) => a + c.credits, 0);

  // context: re-read above BIG_CTX, the long-context price tier, MCP tool definitions. A per-message
  // record stands for several calls (cpm), and its estimate never exceeds what the message cost.
  // defaults, as the Python helper: the median over every message's share in the period, and over every call's MCP share
  const allShares = chats.flatMap(ch => (ch.toolShares || []).filter(x => x.ts >= since && x.ts <= now).map(x => x.share));
  const defaultShare = allShares.length ? median(allShares) : DEFAULT_TOOL_SHARE;
  const fracs = recs.filter(c => c.role === "agent" && typeof c.mcpFrac === "number").map(c => c.mcpFrac);
  const defaultFrac = fracs.length ? median(fracs) : 0;
  let bigExtra = 0, tierExtra = 0, mcpExtra = 0, bigCount = 0, tierCount = 0;
  for (const c of recs.filter(x => x.role === "agent" || x.role === "message")) {
    const r = c.sheet && core.rates(c.sheet, c.ctx);
    if (!r) continue;
    const perMsg = c.role === "message", n = perMsg ? cpmFor(c.model) : 1;
    const cap = (x, part) => perMsg ? Math.min(x, c.credits * part) : x;
    if (c.ctx > BIG_CTX) { bigExtra += cap((c.ctx - BIG_CTX) * r.read * n, (c.ctx - BIG_CTX) / c.ctx); bigCount++; }
    const tmax = tierMax(c.sheet);
    if (tmax && c.ctx > tmax) {
      const base = core.rates(c.sheet, 0);
      tierExtra += cap(c.ctx * (r.read - base.read) * n + c.out * (r.out - base.out), r.read ? 1 - base.read / r.read : 0);
      tierCount++;
    }
    if (c.kind === "local" || c.kind === "local-msg") {
      const sh = c.toolShare || defaultShare, fr = typeof c.mcpFrac === "number" ? c.mcpFrac : defaultFrac;
      mcpExtra += cap(c.ctx * sh * fr * r.read * n, sh * fr);
    }
  }

  // reasoning effort: output beyond what the same model writes at the lowest effort you used
  const eff = new Map();
  for (const c of recs.filter(x => (x.role === "agent" || x.role === "message") && x.effort)) {
    const model = c.model + (c.role === "message" ? " (per message)" : "");
    if (!eff.has(model)) eff.set(model, new Map());
    const m = eff.get(model);
    if (!m.has(c.effort)) m.set(c.effort, []);
    m.get(c.effort).push(c);
  }
  const effortRows = [];
  let effortExtra = 0;
  for (const [model, byLevel] of eff) {
    const levels = [...byLevel.keys()].sort((a, b) => (EFFORT_ORDER[a] ?? 9) - (EFFORT_ORDER[b] ?? 9));
    const base = median(byLevel.get(levels[0]).map(c => c.out));
    for (const e of levels) {
      const cs = byLevel.get(e), sheet = cs[0].sheet, r = sheet && core.rates(sheet, 0);
      const extra = r && (EFFORT_ORDER[e] ?? 0) >= 3 && e !== levels[0] ? cs.reduce((a, c) => a + Math.max(0, c.out - base), 0) * r.out : 0;
      effortExtra += extra;
      effortRows.push({ model, effort: e, calls: cs.length, credits: cs.reduce((a, c) => a + c.credits, 0),
                        outMedian: median(cs.map(c => c.out)), extra });
    }
  }
  effortRows.sort((a, b) => a.model.localeCompare(b.model) || (EFFORT_ORDER[a.effort] ?? 9) - (EFFORT_ORDER[b.effort] ?? 9));

  const comp = recs.filter(c => c.role === "compaction"), sub = recs.filter(c => c.role === "subagent"), side = recs.filter(c => c.role === "side");
  const credits = xs => xs.reduce((a, c) => a + c.credits, 0);
  const expired = misses.filter(m => m.expired), other = misses.filter(m => !m.expired);
  const sum = xs => xs.reduce((a, m) => a + m.extra, 0);
  const groups = new Map();
  for (const c of recs) {
    const key = `${c.kind}|${c.model}`;
    if (!groups.has(key)) groups.set(key, { kind: c.kind, model: c.model, calls: 0, credits: 0, ctx: [], cached: 0, input: 0 });
    const g = groups.get(key);
    g.calls++; g.credits += c.credits; g.ctx.push(c.ctx);
    if (c.kind !== "local-msg") { g.cached += c.cached; g.input += c.ctx; }
  }
  return {
    total, calls: recs.length, chats: perChat.length, unpriced, unpricedModels: [...unpricedModels].sort(),
    unknownLifetime: [...unknownLifetime].sort(),
    // the measured lifetimes the report used (longer than the guess or known value, by a margin)
    measured: Object.fromEntries(Object.entries(measured).filter(([m, g]) =>
      g > (core.knownTtl(m) || core.defaultTtl(m)) + core.MEASURED_MARGIN).map(([m, g]) => [m, Math.floor(g / 60) * 60])),
    factors: [
      { name: "Expired caches after pauses", credits: sum(expired), count: expired.length,
        what: "Calls that re-sent their whole context after a pause longer than the cache lifetime.",
        todo: "Reply within the cache lifetime, or let Cache Keeper keep it warm, summarize or compact before it expires." },
      { name: `Large context re-read on every call`, credits: bigExtra, count: bigCount,
        what: `Context above ${BIG_CTX / 1000}k tokens is re-read, at the cache price, by every model call.`,
        todo: "Start a new chat per task (a handoff summary carries what matters); a smaller context-size setting compacts earlier." },
      { name: "Max / xhigh reasoning effort", credits: effortExtra, count: effortRows.filter(r => r.extra > 0).reduce((a, r) => a + r.calls, 0),
        what: "Output (reasoning included) beyond what the same model writes at the lowest effort you used.",
        todo: "Use High or Medium by default; Max only for hard problems." },
      { name: "MCP tool definitions sent with every call", credits: mcpExtra, count: 0,
        what: `MCP tools are ${Math.round(100 * defaultFrac)}% of the tool definitions sent, and tool definitions ~${Math.round(100 * defaultShare)}% of each prompt (Local chats).`,
        todo: "Turn off MCP servers and tool sets you don't use in the chat's tools picker." },
      { name: "Other cache misses", credits: sum(other), count: other.length,
        what: "Misses not explained by a pause: after a compaction, or a changed prompt (mode, model or tools switched)" +
          (unknownLifetime.size ? `, or a pause on a model whose cache lifetime no log shows (${[...unknownLifetime].sort().join(", ")})` : "") + ".",
        todo: "Avoid switching mode, model or tools mid-chat: it invalidates the cache." },
      { name: "Long-context price tier", credits: tierExtra, count: tierCount,
        what: "Calls above a model's base price tier (e.g. Sol 6.1 above 272k) pay about double.",
        todo: "Keep the context-size setting at the base tier (272K for Sol) so it compacts before crossing it." },
      { name: "Compactions", credits: credits(comp), count: comp.length + compactionEvents.count,
        what: `${comp.length} history summarizations in Local chats` + (compactionEvents.count ? `, ${compactionEvents.count} in other harnesses (cost not logged)` : "") + ".",
        todo: "Mostly a symptom of long chats: start a new chat per task." },
      { name: "Subagents and side calls", credits: credits(sub) + credits(side), count: sub.length + side.length,
        what: `${sub.length} subagent calls, ${side.length} side calls (titles, summaries, checks).`,
        todo: "Usually small; check that subagents use a cheap model." },
    ].sort((a, b) => b.credits - a.credits),
    effortRows,
    byModel: [...groups.values()].map(g => ({ kind: g.kind, model: g.model, calls: g.calls, credits: g.credits,
      medianCtx: median(g.ctx), cachedShare: g.input ? g.cached / g.input : 0 })).sort((a, b) => b.credits - a.credits),
    byKind: Object.keys(KIND_NAME).map(kd => ({ kind: kd, credits: recs.filter(c => c.kind === kd).reduce((a, c) => a + c.credits, 0),
      chats: perChat.filter(c => c.kind === kd).length })).filter(x => x.chats),
    misses, topMisses: [...misses].sort((a, b) => b.extra - a.extra).slice(0, 10),
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
    L.push("## What drove it", "", "Credits you could have avoided (estimates; they overlap, so don't add them up).", "",
      "| | Credits | Share | Calls | What it is | What to do |", "|---|---:|---:|---:|---|---|");
    for (const f of a.factors) L.push(`| ${f.name} | ${cr(f.credits)} | ${pct(f.credits)} | ${f.count || ""} | ${f.what} | ${f.todo} |`);
    L.push("", "## By harness and model", "", "| Harness | Model | Calls | Credits | Median context | Cached |", "|---|---|---:|---:|---:|---:|");
    for (const g of a.byModel) L.push(`| ${KIND_NAME[g.kind]} | ${g.model} | ${g.calls}${g.kind === "local-msg" ? " msgs" : ""} | ${cr(g.credits)} | ` +
      `${k(g.medianCtx)} | ${g.kind === "local-msg" ? "-" : `${Math.round(100 * g.cachedShare)}%`} |`);
    if (a.effortRows.length) {
      L.push("", "## Reasoning effort", "", "| Model | Effort | Calls | Credits | Median output | Extra vs lowest effort |",
        "|---|---|---:|---:|---:|---:|");
      for (const r of a.effortRows) L.push(`| ${r.model} | ${r.effort} | ${r.calls} | ${cr(r.credits)} | ${Math.round(r.outMedian)} | ${cr(r.extra)} |`);
    }
    if (a.topMisses.length) {
      L.push("", "## Costliest cache misses", "", "| When | Chat | Harness | Model | Context | Pause | Lifetime | Extra credits |",
        "|---|---|---|---|---:|---:|---:|---:|");
      for (const m of a.topMisses) L.push(`| ${day(m.ts)} | ${cell(m.chat)} | ${KIND_NAME[m.kind]} | ${m.model} | ${k(m.ctx)} | ${dur(m.pause)} | ` +
        `${m.ttl ? dur(m.ttl) : "unknown"} | ${cr(m.extra)}${m.expired ? "" : m.ttl ? " (not a pause)" : ""} |`);
    }
    L.push("", "## Costliest chats", "", "| Chat | Harness | Workspace | Calls | Credits | Misses | Max context | Last call |",
      "|---|---|---|---:|---:|---:|---:|---|");
    for (const c of a.topChats) L.push(`| ${cell(c.title)} | ${KIND_NAME[c.kind]} | ${cell(c.workspace)} | ${c.calls} | ${cr(c.credits)} | ` +
      `${c.misses ? `${c.misses} (${cr(c.missCredits)} cr)` : "0"} | ${k(c.maxCtx)} | ${day(c.last)} |`);
  }
  L.push("", "## How it is computed", "",
    "- Local, per message: chats with no Agent Debug Log (it is off by default, and VS Code removes old ones), read from " +
    "VS Code's own chat files, one line per " +
    "message with the credits it was billed (all its model calls together). Their expired caches: a pause before the " +
    "message longer than the cache lifetime, priced on the message's prompt.",
    "- Credits: as billed where the log says (Local, Copilot SDK; Claude scaled to the credits Copilot billed for the chat), " +
    "else from Copilot's price sheet (Codex). 1 credit = $0.01.",
    "- A cache miss: a call with at least 30k tokens of context and less than half of it cached. It is an expired cache when " +
    "the pause since the chat's previous call was longer than the model's cache lifetime. Extra credits: the re-sent part " +
    "at the uncached price minus the cache price.",
    "- Cache lifetimes, from data only: what the call's log says (Copilot SDK, Claude), Copilot CLI/SDK logs for the model, " +
    "the longest gap after which your Local chats still hit the cache, once over 6 min" +
    (Object.keys(a.measured).length ? ` (${Object.entries(a.measured).map(([m, g]) => `${m} ≥${g} s`).join(", ")})` : "") +
    ", else the known values (Claude 5 min, Sol 6.1 30 min)." +
    (a.unknownLifetime.length ? ` No data for ${a.unknownLifetime.join(", ")}: no expiry judged for them.` : ""),
    "- Read on this window's side (Windows, WSL, SSH host or container): Local chats of every workspace, and the Copilot SDK, " +
    "Claude and Codex chats VS Code created. Your own Claude Code sessions are not Copilot spend and are left out.",
    "- For reasoning effort, tool definitions, older chats, Copilot CLI and OpenCode, run tools/spend-analyzer/analyze_spend.py " +
    "(Python) from the repository.");
  if (where.length) L.push("", "Read:", "", ...where.map(w => `- ${w}`));
  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------- VS Code's own chat files
// workspaceStorage/<workspace>/chatSessions/<chat id>.jsonl, on the side VS Code's UI runs (Windows
// for a WSL window): an op log of the chat's requests, one per message, each with the credits it was
// billed. Kept after the chat's debug log is gone, so older chats still count. VS Code before 1.109,
// or with chat.useLogSessionStorage off, writes <chat id>.json instead: the whole chat as one object.
// Chats of a window with no folder open are in globalStorage/emptyWindowChatSessions.

/** The chat's requests, replayed from the op log (or read from a whole-chat .json file). */
function chatFileRequests(text) {
  let reqs = [];
  // a whole-chat .json file parses as one object with its requests; an op log (one change per line) does not
  try {
    const o = JSON.parse(String(text || ""));
    if (o && Array.isArray(o.requests)) return [...o.requests];
  } catch { /* an op log */ }
  for (const line of String(text || "").split("\n")) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const key = o.k || [], v = o.v;
    if (o.kind === 0 && v && typeof v === "object") reqs = [...(v.requests || [])];
    else if (key.length === 1 && key[0] === "requests" && o.kind === 2 && Array.isArray(v)) reqs.splice(o.i === undefined ? reqs.length : o.i, Infinity, ...v);
    else if (key.length === 3 && key[0] === "requests" && o.kind === 1 && Number.isInteger(key[1])) {
      while (reqs.length <= key[1]) reqs.push({});
      reqs[key[1]] = { ...reqs[key[1]], [key[2]]: v };
    }
  }
  return reqs;
}

/**
 * One "call" per billed message of a chat file (see analyzeSpend, kind "local-msg"), and the chat's
 * title (its first message). Copies of the same chat (VS Code keeps one per workspace folder it was
 * in) are merged by the caller: pass all their texts. `unbilled`: finished messages since `since` that
 * carry tokens but no credits (not counted).
 */
function chatFileMessages(texts, since = 0) {
  const best = new Map(), unbilled = new Set();
  let title = "";
  for (const text of texts) {
    const reqs = chatFileRequests(text);
    let prevEnd = null;
    reqs.forEach((q, i) => {
      const ts = q.timestamp || 0, el = q.elapsedMs, msg = q.message && typeof q.message === "object" ? q.message.text || "" : "";
      if (!title && msg) title = msg.trim().split("\n")[0].slice(0, 80);
      if (ts && q.copilotCredits !== undefined && q.copilotCredits !== null && el && Number(q.copilotCredits) > 0) {
        const tools = (q.promptTokenDetails || []).find(d => d && d.label === "Tool Definitions");
        const m = { t: "call", ts, end: ts + el, model: String(q.modelId || "?").split("/").pop(), input: Number(q.promptTokens) || 0,
                    cached: 0, out: Number(q.completionTokens) || 0, credits: Number(q.copilotCredits),
                    gap: prevEnd ? (ts - prevEnd) / 1000 : null, ours: core.isOwnMessage(msg),
                    effort: (q.modelConfiguration || {}).reasoningEffort || undefined,
                    toolShare: tools && tools.percentageOfPrompt ? tools.percentageOfPrompt / 100 : undefined };
        const k = `${ts}|${i}`, old = best.get(k);
        if (!old || m.credits > old.credits) best.set(k, m);   // the most complete copy
      } else if (ts && ts >= since && el && (q.copilotCredits === undefined || q.copilotCredits === null) && (q.promptTokens || q.completionTokens)) {
        unbilled.add(`${ts}|${i}`);   // a finished message with tokens but no credits: not counted, but said
      }
      if (ts && el) prevEnd = ts + el;
    });
  }
  for (const k of best.keys()) unbilled.delete(k);
  return { title, events: [...best.values()].sort((a, b) => a.ts - b.ts), unbilled: unbilled.size };
}

/** Adds another copy's events to a chat: each event once (same kind, time and tokens), in time order. */
function mergeChatEvents(chat, events, subEvents = []) {
  const merge = (a, b) => {
    const seen = new Set(a.map(e => `${e.t}|${e.ts}|${e.input}|${e.out}`));
    return [...a, ...b.filter(e => !seen.has(`${e.t}|${e.ts}|${e.input}|${e.out}`))].sort((x, y) => x.ts - y.ts);
  };
  chat.events = merge(chat.events || [], events);
  chat.subEvents = merge(chat.subEvents || [], subEvents);
}

/**
 * A Copilot SDK session's billed total and its last message time, read directly: for a session whose
 * log has no per-call record (older SDK versions), which the chat readers skip.
 */
function sdkSessionTotal(text) {
  let total = 0, lastTs = 0;
  for (const line of String(text || "").split("\n")) {
    if (!line.includes("totalNanoAiu") && !line.includes('"user.message"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    if (e.type === "user.message") lastTs = Math.max(lastTs, Date.parse(e.timestamp) || 0);
    else if (e.type !== "session.usage_record" && typeof d.totalNanoAiu === "number") total = Math.max(total, d.totalNanoAiu / 1e9);
  }
  return { total, lastTs };
}

/** A Local chat's subagent log (a .jsonl next to main.jsonl): its billed model calls. */
function subagentCalls(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.includes('"llm_request"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const a = e.attrs || {};
    if (e.type !== "llm_request" || !("inputTokens" in a)) continue;
    out.push({ t: "call", ts: e.ts || 0, model: a.model || "?", input: a.inputTokens || 0, cached: a.cachedTokens || 0,
               out: a.outputTokens || 0, credits: a.copilotUsageNanoAiu ? a.copilotUsageNanoAiu / 1e9 : 0 });
  }
  return out;
}

/**
 * Share of the tool definitions sent to the model that come from MCP servers, from a Local chat's
 * tools_<n>.json (debug log folder), by size. Null when unreadable.
 */
function mcpFraction(toolsText) {
  try {
    const raw = JSON.parse(toolsText);
    const tools = raw && !Array.isArray(raw) && "content" in raw ? JSON.parse(raw.content) : raw;
    let all = 0, mcp = 0;
    for (const t of tools) {
      const n = JSON.stringify(t).length, name = String(t.name || (t.function && t.function.name) || "");
      all += n;
      if (name.startsWith("mcp_")) mcp += n;
    }
    return all ? mcp / all : null;
  } catch { return null; }
}

module.exports = { analyzeSpend, spendMarkdown, callCredits, chatFileRequests, chatFileMessages, mcpFraction, subagentCalls, mergeChatEvents,
  sdkSessionTotal };
