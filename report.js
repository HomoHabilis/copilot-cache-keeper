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
const KIND_NAME = { local: "Local", "local-msg": "Local, older chats", sdk: "Copilot SDK", claude: "Claude", codex: "Codex" };

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

// ---------------------------------------------------------------- a chat as a series of calls
// Every chat becomes a list of its agent calls: { mi (which message of yours), ctx, new (tokens not read
// from the cache when all goes well), out, cold (null, "pause", "wait" or "other"), gap (s), ttl, sheet,
// fixed (the call's own rates, when its log has them) }. The what-ifs (kept warm, split, smaller window)
// re-price that list. Same constants and steps as the Python helper, so the two reports agree.
const COLD_KEPT = 0.045;       // share of a prompt still read from the cache on a cold send (measured: the system prompt)
const NEAR_TTL = 0.8;          // a wait this close to the cache lifetime explains a cold send the bill shows
const MSG_NEW = 800;           // tokens a message of yours adds
const KEEP_LEAD = 15;          // s before expiry a keep-alive goes out
const KEEP_MAX = 2 * 3600;     // Cache Keeper's keep-warm time limit
const KEEP_CAP = 0.5;          // ... and its cap: keep-alives may cost this share of what the expiry would add
const PING_NEW = 60, PING_OUT = 15;                       // a keep-alive: tokens added, tokens answered
const SUMMARY_OUT = 2500, SUMMARY_TOK = 2500;             // a handoff summary: tokens written, tokens read by the new chat
const REREAD = 25000, EXTRA_CALLS = 4;                    // a new chat reads files again: tokens, and extra calls to do it
const NEW_CHAT_MAX = 50000;                               // a new chat's first prompt is the chat's own first prompt, at most this
const WINDOW = 200000, WINDOW_AFTER = 0.35, COMPACT_OUT = 8000;   // a smaller context window: size, share left by a compaction, its output
const MAX_CHATS = 3;           // split what-if: at most this many chats
const SPLIT_CANDIDATES = 30;   // ... cutting at this many of your messages at most
const WHATIF_TOP = 30, WHATIF_MIN = 50;                   // what-ifs for the costliest chats, of at least this many credits
const FIT_RANGE = [0.6, 1.6];  // a chat is simulated only if the price-sheet model lands this close to its bill

/** 'keepalive', 'other' (a summary request, /compact) or null for a message you wrote yourself. */
function ownKind(text) {
  const t = String(text || "").trim();
  if (core.isKeepAlive(t)) return "keepalive";
  if (!core.isOwnMessage(t)) return null;
  // older versions tagged every message; their summary requests said so
  return !t.startsWith(core.MARKER) || t.toLowerCase().includes("handoff") ? "other" : "keepalive";
}

const ratesOf = c => c.fixed || core.rates(c.sheet, c.ctx);

/** One call by the price sheet: the cached part read, the new part written; cold, nearly all written again. */
function modelCost(c, cold = c.cold) {
  const r = ratesOf(c), out = c.out * r.out;
  if (cold) return c.ctx * (COLD_KEPT * r.read + (1 - COLD_KEPT) * r.write) + out;
  const fresh = Math.min(c.new, c.ctx);
  return (c.ctx - fresh) * r.read + fresh * r.write + out;
}

/**
 * An older chat (one record per message) as a series of calls, and its cold sends.
 * A message's calls are its tool-call rounds (their end times are in the chat file; else your median
 * number of calls per message), the context growing evenly up to the message's prompt. A cold send is
 * not guessed from the pause: it is read from the bill. When a message was billed about one (two, ...)
 * full re-send(s) more than its calls cost warm, that many calls were cold: the ones after the longest
 * waits. A wait near the cache lifetime makes it an expiry, before the message (a pause) or between
 * two of its calls (the agent waited for an approval or a long command); otherwise it is unexplained.
 * The pause before a message runs from the start of the previous message's last call, as the cache lifetime does.
 * Returns { series, misses: Map(message -> [{ ctx, gap, extra, cold }]) }; sets m.coldFirst.
 */
function rebuildMessages(msgs, { sheetFor, cpmFor, ttlFor }) {
  let series = [], prev = null, lastStart = null;
  const misses = new Map();
  [...msgs].sort((a, b) => a.ts - b.ts).forEach((m, mi) => {
    const sheet = sheetFor(m.model), r = sheet && core.rates(sheet, m.input || 0);
    if (!r || !m.input || !r.write) { prev = null; lastStart = null; series = []; return; }   // no price: nothing after it can be modelled from before
    let ends = m.rounds || [];
    const n = Math.max(m.nrounds || ends.length || Math.round(cpmFor(m.model)), 1);
    if (ends.length !== n) ends = null;
    const compacted = !!prev && m.input < 0.8 * prev.input;
    const start = !prev ? Math.min(m.input, Math.max(20000, ((m.toolShare || 0.13) + 0.03) * m.input + 3000))
      : compacted ? 0.9 * m.input : Math.min(m.input, prev.input + MSG_NEW);
    const ttl = ttlFor(m), mine = [];
    for (let k = 0; k < n; k++) {
      const ctx = n === 1 ? m.input : start + (m.input - start) * k / (n - 1);
      const wait = k === 0 ? (lastStart ? (m.ts - lastStart) / 1000 : 0) : ends ? (ends[k] - ends[k - 1]) / 1000 : 0;
      const before = series.length ? series[series.length - 1].ctx : 0;
      const c = { mi, k, ts: k === 0 ? m.ts : ends ? ends[k - 1] : m.ts, ctx,
                  new: series.length && !(compacted && k === 0) ? Math.max(0, ctx - before) : ctx, out: (m.out || 0) / n,
                  cold: null, gap: Math.max(wait, 0), ttl, sheet };
      series.push(c); mine.push(c);
    }
    const warm = mine.reduce((a, c) => a + modelCost(c, false), 0), resid = m.credits - warm;
    const one = m.input * (1 - COLD_KEPT) * (r.write - r.read);
    const judged = prev && !compacted && !m.ours && ttl && m.input >= MISS_MIN_CTX && one > 0;
    const found = [];
    if (judged && !m.nrounds) {
      // a chat file that does not say how many calls the message made: the bill cannot be checked, so the
      // pause decides (longer than the lifetime: expired), for at most what the message cost beyond its output
      if (mine[0].gap >= ttl) {
        mine[0].cold = "pause";
        found.push({ ctx: Math.round(mine[0].ctx), gap: mine[0].gap, cold: "pause",
                     extra: Math.min(one, Math.max(0, m.credits - (m.out || 0) * r.out)) });
      }
    } else {
      const ncold = judged ? Math.min(Math.floor(resid / one + 0.5), n) : 0;
      // the longest waits first (a stable sort: the earlier call on a tie, as in the Python helper)
      for (const c of [...mine].sort((a, b) => b.gap - a.gap).slice(0, Math.max(ncold, 0))) {
        c.cold = c.gap >= NEAR_TTL * ttl ? (c.k === 0 ? "pause" : "wait") : "other";
        found.push({ ctx: Math.round(c.ctx), gap: c.gap, extra: resid / ncold, cold: c.cold });
      }
    }
    if (found.length) misses.set(m, found);
    m.coldFirst = !!(mine.length && mine[0].cold);
    // the cache lifetime runs from the start of the message's last call: the end of the round before it
    prev = m;
    lastStart = ends ? (n > 1 ? ends[n - 2] : m.ts) : (m.end || m.ts);
  });
  return { series, misses };
}

/**
 * The series by the price sheet. keeper: every expiry after a pause that Cache Keeper could have kept
 * warm (within its time limit and its cap) costs its keep-alives instead.
 */
function simTotal(series, keeper = false) {
  let total = 0;
  for (const c of series) {
    if (keeper && c.cold === "pause" && c.ttl) {
      const r = ratesOf(c), n = Math.floor(c.gap / (c.ttl - KEEP_LEAD));
      const ping = (c.ctx - Math.min(c.new, c.ctx)) * r.read + PING_NEW * r.write + PING_OUT * r.out;
      const extra = modelCost(c) - modelCost(c, false);
      if (n >= 1 && c.gap <= KEEP_MAX + c.ttl && n * ping <= KEEP_CAP * extra) { total += modelCost(c, false) + n * ping; continue; }
    }
    total += modelCost(c);
  }
  return total;
}

/**
 * The same work in shorter chats: a new chat (from a handoff summary) at the start of each message in
 * `cuts`, and/or a compaction whenever the context passes `window`. Returns the new series and what
 * the summaries, the new chats' first prompts, the files read again and the compactions cost.
 */
function simReshape(series, cuts = new Set(), window = 0) {
  const out = [];
  let shift = 0, over = 0, prevMi = null;
  const base = Math.min(series[0].ctx, NEW_CHAT_MAX);
  for (const c of series) {
    const r = ratesOf(c);
    let cold = c.cold;
    if (cuts.has(c.mi) && c.mi !== prevMi && out.length) {
      const start = base + SUMMARY_TOK + REREAD;
      if (c.ctx - shift - c.new > start) {
        over += out[out.length - 1].ctx * r.read + 300 * r.write + SUMMARY_OUT * r.out + start * r.write +
          EXTRA_CALLS * ((base + SUMMARY_TOK + REREAD / 2) * r.read + 300 * r.out);
        shift = c.ctx - c.new - start; cold = null;
      }
    } else if (window && c.ctx - shift > window) {
      const after = window * WINDOW_AFTER;
      over += (c.ctx - shift) * r.read + COMPACT_OUT * r.out + after * r.write;
      shift = c.ctx - after;
    }
    prevMi = c.mi;
    const ctx = Math.max(c.ctx - shift, Math.min(c.ctx, base + SUMMARY_TOK));
    out.push({ ...c, ctx, new: Math.min(c.new, ctx), cold });
  }
  return { series: out, over };
}

/** The cheapest way to do the chat in at most MAX_CHATS chats, cutting at your messages. */
function bestSplit(series, keeper) {
  let starts = [...new Set(series.filter((c, i) => i && c.mi !== series[i - 1].mi).map(c => c.mi))].sort((a, b) => a - b);
  if (starts.length > SPLIT_CANDIDATES) {
    const all = starts;
    starts = Array.from({ length: SPLIT_CANDIDATES }, (_, i) => all[pyRound(i * (all.length - 1) / (SPLIT_CANDIDATES - 1))]);
  }
  let best = { total: simTotal(series, keeper), cuts: [] };
  const tryCuts = cuts => {
    const s2 = simReshape(series, new Set(cuts)), t = simTotal(s2.series, keeper) + s2.over;
    if (t < best.total - 1e-9) best = { total: t, cuts };
  };
  for (let n = 1; n < MAX_CHATS; n++) {
    // every choice of n messages, in the order Python's itertools.combinations gives them
    const pick = (from, chosen) => {
      if (chosen.length === n) return tryCuts(chosen);
      for (let i = from; i < starts.length; i++) pick(i + 1, [...chosen, starts[i]]);
    };
    pick(0, []);
  }
  return best;
}
// Python's round(): halves go to the even neighbour
const pyRound = x => { const f = Math.floor(x); return x - f === 0.5 ? (f % 2 ? f + 1 : f) : Math.round(x); };

/**
 * For the costliest chats: what the expiries cost, and what keeping warm, splitting and a smaller
 * context window would have saved. Savings are the price-sheet model's, scaled to the chat's bill.
 * entries: [{ chat (its row of the report), series, billed }]
 */
function whatIf(entries) {
  const rows = [];
  let skipped = 0;
  for (const { chat, series, billed } of [...entries].sort((a, b) => b.billed - a.billed).slice(0, WHATIF_TOP)) {
    if (billed < WHATIF_MIN || series.length < 2) continue;
    const base = simTotal(series), scale = base ? billed / base : 0;
    if (scale < FIT_RANGE[0] || scale > FIT_RANGE[1]) { skipped++; continue; }
    const cold = kind => series.filter(c => c.cold === kind).reduce((a, c) => a + modelCost(c) - modelCost(c, false), 0) * scale;
    const split = bestSplit(series, false), both = bestSplit(series, true);
    const maxCtx = Math.max(...series.map(c => c.ctx));
    let win = null;
    if (maxCtx > WINDOW) {
      const s2 = simReshape(series, new Set(), WINDOW);
      win = (base - simTotal(s2.series, true) - s2.over) * scale;
    }
    rows.push({ chat, billed, start: series[0].ts, maxCtx, coldPause: cold("pause"), coldWait: cold("wait"),
                keeper: (base - simTotal(series, true)) * scale, split: (base - split.total) * scale,
                both: (base - both.total) * scale, chats: both.cuts.length + 1, window: win });
  }
  const sum = f => rows.reduce((a, r) => a + (r[f] || 0), 0);
  return { rows, skipped, billed: sum("billed"), coldPause: sum("coldPause"), coldWait: sum("coldWait"),
           keeper: sum("keeper"), split: sum("split"), both: sum("both"), window: sum("window") };
}

/**
 * What Cache Keeper's own messages did in one chat: keep-alives sent and their cost, the expiries they
 * avoided (your next message came after the cache would have expired, and found it warm), summaries.
 * timeline, in time order: { user: true, own } for a message, or a call { own (per-message records),
 * perMessage, ts, end, ctx, credits, cold, ttl, r }. Adds to `k`.
 */
function keptWarm(timeline, k) {
  let pending = 0, lastReal = null, cur = null, first = false;
  for (const c of timeline) {
    if (c.user) {
      cur = c.own; first = true;
      if (cur === "keepalive") { k.pings++; pending++; }
      if (cur === "other") k.summaries++;
      continue;
    }
    const own = c.perMessage ? c.own : cur;
    if (c.perMessage) {
      if (own === "keepalive") { k.pings++; pending++; }
      if (own === "other") k.summaries++;
    }
    if (own === "keepalive") k.spent += c.credits || 0;
    else if (own === "other") { k.summaryCredits += c.credits || 0; pending = 0; }
    else {
      const starts = c.perMessage || first;
      if (starts && pending && c.ttl && c.r && lastReal && (c.ts - lastReal) / 1000 > c.ttl && !c.cold) {
        k.avoided++;
        k.avoidedCredits += Math.max(0, c.ctx - TYPICAL_NEW) * (1 - COLD_KEPT) * (c.r.write - c.r.read);
      }
      if (starts) pending = 0;
      lastReal = c.end || c.ts;
    }
    first = false;
  }
}

/**
 * The what-ifs for one live chat, from its event list (harnesses.js): what it was billed, the expiries
 * it paid, what keeping warm and splitting would have saved, and what each call now costs just to
 * re-read the context. Null when it has fewer than two priced agent calls.
 * { billed, calls, ctx, maxCtx, growing, paid: { pause: { count, credits }, wait: { count, credits } },
 *   keeperSaving, split: { saving, share, chats } | null (the bill is not explained well enough),
 *   carry: { perCall, newPerCall }, lastCommit }
 */
function liveInsight(events, { sheetFor = () => null, ttl = 0 } = {}) {
  const users = events.filter(e => e.t === "user").map(e => ({ ts: e.ts, own: ownKind(e.text) }));
  const series = [], paid = { pause: { count: 0, credits: 0 }, wait: { count: 0, credits: 0 } };
  let prev = null, billed = 0, mi = 0, ui = 0;
  for (const c of events) {
    if (c.t !== "call" || c.side) continue;
    const sheet = sheetFor(c.model || "?"), r = callRates(c, sheet), ctx = c.input || 0, cached = c.cached || 0, life = c.ttl || ttl;
    let cold = null, pause = 0;
    if (prev && r && ctx >= MISS_MIN_CTX && cached < MISS_CACHED_BELOW * ctx) {
      pause = (c.ts - prev.ts) / 1000;
      const expired = !!life && pause >= life - 5;
      const waited = expired && users.length > 0 && !users.some(u => u.ts > prev.ts && u.ts <= c.ts);
      cold = waited ? "wait" : expired ? "pause" : "other";
      if (cold !== "other") { paid[cold].count++; paid[cold].credits += Math.max(0, ctx - cached - TYPICAL_NEW) * Math.max(0, r.write - r.read); }
    }
    prev = c;
    if (!ctx || !r) continue;
    for (; ui < users.length && users[ui].ts <= c.ts; ui++) if (!users[ui].own) mi++;
    const last = series[series.length - 1];
    series.push({ mi, k: !last || last.mi !== mi ? 0 : 1, ts: c.ts, ctx, new: cold && last ? Math.max(0, ctx - last.ctx) : Math.max(0, ctx - cached),
                  out: c.out || 0, cold, gap: pause, ttl: life, sheet, fixed: c.rates ? r : null });
    billed += callCredits(c, sheet) || 0;
  }
  if (series.length < 2) return null;
  const base = simTotal(series), scale = base ? billed / base : 0, fits = scale >= FIT_RANGE[0] && scale <= FIT_RANGE[1];
  const lastCall = series[series.length - 1], r = ratesOf(lastCall), maxCtx = Math.max(...series.map(c => c.ctx));
  const fresh = Math.min(Math.min(series[0].ctx, NEW_CHAT_MAX) + SUMMARY_TOK + REREAD, lastCall.ctx);
  let split = null;
  if (fits) {
    const b = bestSplit(series, false);
    split = { saving: (base - b.total) * scale, share: billed ? (base - b.total) * scale / billed : 0, chats: b.cuts.length + 1 };
  }
  return { billed, calls: series.length, ctx: lastCall.ctx, maxCtx, growing: lastCall.ctx >= 0.9 * maxCtx, paid,
           keeperSaving: fits ? (base - simTotal(series, true)) * scale : 0, split,
           carry: { perCall: lastCall.ctx * r.read, newPerCall: fresh * r.read },
           lastCommit: Math.max(0, ...events.filter(e => e.t === "commit").map(e => e.ts)) };
}

function analyzeSpend(chats, { since = 0, now = Date.now(), ttlOverrides = {} } = {}) {
  const recs = [], misses = [], perChat = [], compactionEvents = { count: 0 };
  const measured = measuredLifetimes(chats);
  const unknownLifetime = new Set();
  let unpriced = 0;
  const unpricedModels = new Set();
  const cpm = callsPerMessage(chats);
  const cpmFor = m => cpm[m] || (Object.keys(cpm).length ? median(Object.values(cpm)) : DEFAULT_CALLS_PER_MESSAGE);
  const whatIfEntries = [], kept = { pings: 0, spent: 0, avoided: 0, avoidedCredits: 0, summaries: 0, summaryCredits: 0 };
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
    const inside = e => e.ts >= since && e.ts <= now;
    // older chats (one record per message): cold sends read from the bill
    const rebuilt = ch.kind === "local-msg" ? rebuildMessages(items.filter(it => it.role === "message" && inside(it.c)).map(it => it.c),
      { sheetFor, cpmFor, ttlFor: m => lifetime(m, m.model || "?", measured, ttlOverrides) }) : null;
    // messages (yours and Cache Keeper's), to tell an expiry while the agent waited from one after a pause
    const users = evs.filter(e => e.t === "user").map(e => ({ user: true, ts: e.ts, own: ownKind(e.text) }));
    const series = rebuilt ? rebuilt.series : [], timeline = users.filter(inside);
    let billedSeries = 0;
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
        billedSeries += rec.credits;
        timeline.push({ perMessage: true, own: ownKind(c.text), ts: c.ts, end: c.end, ctx: rec.ctx, credits: rec.credits,
                        cold: c.coldFirst, ttl, r });
        if (!ttl) { unknownLifetime.add(rec.model); continue; }   // no data: not judged
        for (const x of rebuilt.misses.get(c) || []) {
          misses.push({ ...rec, ctx: x.ctx, pause: x.gap, ttl, expired: x.cold === "pause", waited: x.cold === "wait", extra: x.extra });
          mine.misses++; mine.missCredits += x.extra;
        }
        continue;
      }
      if (!isAgent) continue;
      // a miss: most of a large prompt sent again uncached, after an earlier call of this chat
      const prev = prevAgent;
      prevAgent = c;
      const ttl = lifetime(c, rec.model, measured, ttlOverrides), r = callRates(c, rec.sheet);
      let cold = null, pause = 0;
      if (prev && rec.ctx >= MISS_MIN_CTX && rec.cached < MISS_CACHED_BELOW * rec.ctx) {
        pause = (c.ts - prev.ts) / 1000;     // the cache is refreshed when a request starts
        if (!ttl) unknownLifetime.add(rec.model);
        const extra = r ? Math.max(0, rec.ctx - rec.cached - TYPICAL_NEW) * Math.max(0, r.write - r.read) : 0;
        const expired = !!ttl && pause >= ttl - 5;
        // expired with no message in between: the agent itself waited (an approval, a long command)
        const waited = expired && users.length > 0 && !users.some(u => u.ts > prev.ts && u.ts <= c.ts);
        cold = waited ? "wait" : expired ? "pause" : "other";
        misses.push({ ...rec, pause, ttl, expired: expired && !waited, waited, extra });
        mine.misses++; mine.missCredits += extra;
      }
      if (it.role !== "agent" || !rec.ctx || !r) continue;
      const mi = users.filter(u => !u.own && u.ts <= c.ts).length, last = series[series.length - 1];
      series.push({ mi, k: !last || last.mi !== mi ? 0 : 1, ts: c.ts, ctx: rec.ctx,
                    new: cold && last ? Math.max(0, rec.ctx - last.ctx) : Math.max(0, rec.ctx - rec.cached), out: rec.out,
                    cold, gap: pause, ttl, sheet: rec.sheet, fixed: c.rates ? r : null });
      billedSeries += rec.credits;
      timeline.push({ ts: c.ts, ctx: rec.ctx, credits: rec.credits, cold, ttl, r });
    }
    if (mine.calls) perChat.push(mine);
    if (series.length) whatIfEntries.push({ chat: mine, series, billed: billedSeries });
    // a message before the calls it caused, at the same time
    keptWarm(timeline.map((e, i) => [e, i]).sort((x, y) => x[0].ts - y[0].ts || (y[0].user ? 1 : 0) - (x[0].user ? 1 : 0) || x[1] - y[1]).map(x => x[0]), kept);
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
  const expired = misses.filter(m => m.expired), waited = misses.filter(m => m.waited), other = misses.filter(m => !m.expired && !m.waited);
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
      { name: "Expired caches while the agent waited", credits: sum(waited), count: waited.length,
        what: "Calls that re-sent their whole context in the middle of a turn: the agent waited longer than the cache lifetime " +
          "for a tool approval or a long command. Keeping warm cannot help here: nothing can be sent while the agent works.",
        todo: "Approve tools quickly or auto-approve the safe ones; run long builds and tests in the background or in a terminal of your own, then tell the agent the result." },
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
    whatIf: whatIf(whatIfEntries), kept,
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
    const wi = a.whatIf, kp = a.kept;
    if (wi.rows.length) {
      const pc = x => `${cr(x)} (${Math.round(100 * x / Math.max(wi.billed, 1e-9))}%)`;
      const pr = (x, r) => x > 0.005 ? `${cr(x)} (${Math.round(100 * x / r.billed)}%)` : "-";
      L.push("", "## What Cache Keeper and shorter chats would have saved", "",
        `Your ${wi.rows.length} costliest chats (${cr(wi.billed)} credits), priced again call by call. ` +
        `Expired caches cost ${pc(wi.coldPause)} after pauses and ${pc(wi.coldWait)} while the agent waited.`, "",
        `- **Kept warm** by Cache Keeper (keep-alives paid, within its 2 h limit and its cap): **${pc(wi.keeper)}** saved.`,
        `- **Split** into at most ${MAX_CHATS} chats with a handoff summary, at the best of your messages: ${pc(wi.split)} saved.`,
        `- **Both: ${pc(wi.both)}** saved.`);
      if (wi.window) L.push(`- A ${WINDOW / 1000}k context window (it compacts earlier), kept warm: ${pc(wi.window)} saved, on the chats that went past it.`);
      L.push("", "These are alternatives for the same chats: don't add them up.", "",
        `| Start | Chat | Harness | Credits | Max context | Expired: pauses | Expired: agent waited | Kept warm | Split | Both | In chats | ${WINDOW / 1000}k window |`,
        "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
      for (const r of wi.rows.slice(0, 15)) L.push(`| ${day(r.start)} | ${cell(r.chat.title)} | ${KIND_NAME[r.chat.kind]} | ${cr(r.billed)} | ${k(r.maxCtx)} | ` +
        `${pr(r.coldPause, r)} | ${pr(r.coldWait, r)} | ${pr(r.keeper, r)} | ${pr(r.split, r)} | ${pr(r.both, r)} | ${r.chats} | ` +
        `${r.window !== null ? pr(r.window, r) : ""} |`);
      if (wi.skipped) L.push("", `${wi.skipped} chat(s) left out: the price sheet does not explain their bill well enough to simulate them.`);
    }
    if (kp.pings || kp.summaries) {
      const net = kp.avoidedCredits - kp.spent;
      L.push("", "## What Cache Keeper did so far", "",
        `${kp.pings} keep-alives cost ${cr(kp.spent)} credits and avoided ${kp.avoided} expired caches worth ${cr(kp.avoidedCredits)} credits: ` +
        `**${cr(Math.abs(net))} credits ${net >= 0 ? "saved" : "lost"}**. ${kp.summaries} summaries or compactions cost ` +
        `${cr(kp.summaryCredits)} credits (what the new chats saved is not counted).`);
    }
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
        `${m.ttl ? dur(m.ttl) : "unknown"} | ${cr(m.extra)}${m.expired ? "" : m.waited ? " (the agent waited)" : m.ttl ? " (not a pause)" : ""} |`);
    }
    L.push("", "## Costliest chats", "", "| Chat | Harness | Workspace | Calls | Credits | Misses | Max context | Last call |",
      "|---|---|---|---:|---:|---:|---:|---|");
    for (const c of a.topChats) L.push(`| ${cell(c.title)} | ${KIND_NAME[c.kind]} | ${cell(c.workspace)} | ${c.calls} | ${cr(c.credits)} | ` +
      `${c.misses ? `${c.misses} (${cr(c.missCredits)} cr)` : "0"} | ${k(c.maxCtx)} | ${day(c.last)} |`);
  }
  L.push("", "## How it is computed", "",
    "- Local, older chats: chats whose debug log VS Code has removed, read from VS Code's own chat files, one line per " +
    "message with the credits it was billed (all its model calls together). A cold send is read from the bill, not " +
    "guessed from the pause: the message's calls are priced warm from the price sheet (its tool-call rounds, the context " +
    "growing evenly up to the message's prompt); when it was billed about one full re-send more than that, one call was " +
    `cold: the one after the longest wait. A wait of at least ${Math.round(100 * NEAR_TTL)}% of the cache lifetime makes it an expiry ` +
    "(before the message: a pause; between two of its calls: the agent waited). Pauses are measured from the start of the " +
    "previous message's last call, as the cache lifetime is. Extra credits: what was billed beyond the warm price.",
    "- Expired while the agent waited: a miss after the cache lifetime with no message between the two calls.",
    `- What-ifs: each chat as its series of calls, priced by the price sheet and scaled to its bill; chats the model misses by ` +
    `more than ${Math.round(100 * FIT_RANGE[0])}%-${Math.round(100 * FIT_RANGE[1])}% are left out. Kept warm: every expiry after a pause of at most ` +
    `${KEEP_MAX / 3600} h costs its keep-alives instead (one per cache lifetime, a read of the whole context each), unless they would ` +
    `cost more than ${Math.round(100 * KEEP_CAP)}% of the expiry. Split: a new chat at the best one or two of your messages; each pays a summary ` +
    `(${SUMMARY_OUT} tokens written), its first prompt, ${REREAD / 1000}k tokens of files read again and ${EXTRA_CALLS} extra calls. ` +
    `${WINDOW / 1000}k window: a compaction (to ${Math.round(100 * WINDOW_AFTER)}% of the window) each time the context passes it. ` +
    "What a summary or compaction loses is not priced.",
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
// billed. Kept after the chat's debug log is gone, so older chats still count.

/** The chat's requests, replayed from the op log. */
function chatFileRequests(text) {
  let reqs = [];
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
 * in) are merged by the caller: pass all their texts.
 */
function chatFileMessages(texts) {
  const best = new Map();
  let title = "";
  for (const text of texts) {
    const reqs = chatFileRequests(text);
    let prevEnd = null;
    reqs.forEach((q, i) => {
      const ts = q.timestamp || 0, el = q.elapsedMs, msg = q.message && typeof q.message === "object" ? q.message.text || "" : "";
      if (!title && msg) title = msg.trim().split("\n")[0].slice(0, 80);
      // each model call of the message ("round") with the time its answer ended: the message really ends with
      // the last one (elapsedMs leaves out the time spent waiting for you to approve a tool)
      const raw = (((q.result || {}).metadata || {}).toolCallRounds) || [];
      let rounds = raw.map(r => parseInt(r && r.timestamp, 10)).filter(Number.isFinite);
      if (rounds.length !== raw.length) rounds = [];
      const end = ts && el ? Math.max(ts + el, ...rounds) : null;
      if (ts && q.copilotCredits !== undefined && q.copilotCredits !== null && el && Number(q.copilotCredits) > 0) {
        const tools = (q.promptTokenDetails || []).find(d => d && d.label === "Tool Definitions");
        const m = { t: "call", ts, end, model: String(q.modelId || "?").split("/").pop(), input: Number(q.promptTokens) || 0,
                    cached: 0, out: Number(q.completionTokens) || 0, credits: Number(q.copilotCredits),
                    gap: prevEnd ? (ts - prevEnd) / 1000 : null, ours: core.isOwnMessage(msg), text: msg.slice(0, 200),
                    rounds, nrounds: raw.length,
                    effort: (q.modelConfiguration || {}).reasoningEffort || undefined,
                    toolShare: tools && tools.percentageOfPrompt ? tools.percentageOfPrompt / 100 : undefined };
        const k = `${ts}|${i}`, old = best.get(k);
        if (!old || m.credits > old.credits) best.set(k, m);   // the most complete copy
      }
      if (end) prevEnd = end;
    });
  }
  return { title, events: [...best.values()].sort((a, b) => a.ts - b.ts) };
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

// _sim: the call-by-call model itself, for the figures of the guide (docs/make-figures.js) and for tests
module.exports = { _sim: { modelCost, simTotal, simReshape, bestSplit, ratesOf }, analyzeSpend, spendMarkdown, liveInsight, tierMax, callCredits, chatFileRequests, chatFileMessages, mcpFraction, subagentCalls, mergeChatEvents,
  sdkSessionTotal };
