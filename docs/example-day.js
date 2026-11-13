// The example day of the guide (README, "A day with and without Cache Keeper"): one made-up but
// representative chat, priced call by call with the same model as the spend report (report.js).
// Nothing here is measured from anyone's logs. Run: node docs/example-day.js  (prints the figures' data)
"use strict";
const path = require("path");
const report = require(path.join(__dirname, "..", "report.js"));
const { modelCost, simTotal, simReshape, bestSplit } = report._sim;

// Copilot's Opus 5.5 prices (credits per 1M tokens), as in its price sheet. 1 credit = $0.01.
const SHEET = { batch_size: 1e6,
  default: { input_price: 400, cache_write_price: 500, cache_read_price: 20, output_price: 2000, max_prompt_tokens: 200000 },
  long_context: { input_price: 400, cache_write_price: 500, cache_read_price: 20, output_price: 2000, max_prompt_tokens: 1000000 } };
const TTL = 300;                       // Opus 5.5: the cache lives 5 minutes
const at = (h, m) => Date.UTC(2026, 10, 12, h, m);   // times of day, shown as local time in the figures

// One working day on one feature, in one chat: [minutes since the agent finished the previous
// message, model calls, what you asked]. Most messages follow at once; six come after a pause longer
// than the cache lifetime: a coffee, a code review, lunch, a meeting, a call, a last check of CI.
const START = [10, 28];
const MESSAGES = [
  [0, 34, "Read the importer module and plan the refactoring"],
  [2, 46, "Start with the parser: split it in three files"],
  [1, 18, "Fix the failing tests"],
  [12, 52, "Now the CSV reader, same structure"],                // coffee
  [3, 9, "Why is the date test flaky?"],
  [2, 44, "Move the validation rules into their own module"],
  [8, 12, "Run the whole suite and fix what breaks"],            // a code review
  [58, 58, "Add the XLSX reader"],                               // lunch
  [2, 7, "Rename Row to Record everywhere"],
  [26, 49, "Write the migration for existing imports"],          // a meeting
  [3, 15, "Review comments: address the first three"],
  [17, 40, "Address the rest, then update the docs"],            // a call
  [2, 21, "Add the changelog entry and open the pull request"],
  [9, 11, "CI fails on Windows paths: fix"],                     // waiting for CI
];
// the agent itself waited longer than the cache lifetime inside this message (a long build, an approval left pending)
const WAIT_IN = { 7: 20 };             // message index -> before which of its calls
const FIRST = 42000, GROW = 1450, OUT = 620, CALL_S = 21;   // first prompt, tokens added and written per call, seconds per call

function build() {
  const events = [];
  let ctx = FIRST, prevCtx = 0, lastCall = 0, n = 0;
  const starts = [];
  let t = at(START[0], START[1]);
  MESSAGES.forEach(([after, calls, text], mi) => {
    t += after * 60000;
    starts.push(t);
    events.push({ t: "user", ts: t, text }, { t: "turn_start", ts: t + 5 });
    for (let i = 0; i < calls; i++) {
      t += CALL_S * 1000;
      if (WAIT_IN[mi] === i) t += 7 * 60000;
      ctx = n === 0 ? FIRST : ctx + GROW;
      const cold = n > 0 && (t - lastCall) / 1000 >= TTL;       // nothing kept it warm
      const cached = n === 0 || cold ? 0 : prevCtx;
      events.push({ t: "call", ts: t, end: t + 6000, model: "claude-opus-5.5", input: ctx, cached, out: OUT,
                    credits: (cached * 20 + (ctx - cached) * 500 + OUT * 2000) / 1e6 });
      prevCtx = ctx; lastCall = t; n++;
    }
    t += 7000;
    events.push({ t: "turn_end", ts: t });
  });
  return events;
}

function exampleDay() {
  const events = build();
  const chat = { kind: "local", id: "example", title: MESSAGES[0][3], events, sheetFor: () => SHEET };
  const a = report.analyzeSpend([chat], { since: 0, now: at(23, 0) });
  const row = a.whatIf.rows[0];
  const calls = events.filter(e => e.t === "call");
  const misses = a.misses.map(m => ({ ts: m.ts, ctx: m.ctx, extra: m.extra, waited: !!m.waited, pause: m.pause }));
  // the same series the what-if prices, to draw the day call by call under each scenario
  const users = events.filter(e => e.t === "user");
  const series = calls.map((c, i) => {
    const miss = a.misses.find(m => m.ts === c.ts), prev = calls[i - 1];
    return { mi: users.filter(u => u.ts <= c.ts).length, ts: c.ts, ctx: c.input, out: c.out, ttl: TTL, sheet: SHEET, fixed: null,
             cold: miss ? (miss.waited ? "wait" : "pause") : null, gap: miss ? miss.pause : 0,
             new: miss && prev ? Math.max(0, c.input - prev.input) : Math.max(0, c.input - c.cached) };
  });
  const both = bestSplit(series, true), reshaped = simReshape(series, new Set(both.cuts));
  const cum = xs => { let s = 0; return xs.map(x => (s += x)); };
  const asIs = cum(series.map(c => modelCost(c)));
  // with Cache Keeper and the split: keep-alives instead of the expiries after pauses, the new chats' own costs at each cut
  const withIt = (() => {
    const out = []; let s = 0, prevMi = null;
    reshaped.series.forEach((c, i) => {
      const cut = both.cuts.includes(c.mi) && c.mi !== prevMi;
      prevMi = c.mi;
      const one = simTotal([c], true);
      s += one + (cut ? reshaped.over / both.cuts.length : 0);
      out.push(s);
    });
    return out;
  })();
  const total = a.total;
  // the model lands within a few percent of the bill: the curves are scaled to end on the billed figures
  const kA = total / asIs[asIs.length - 1], kW = (total - row.both) / withIt[withIt.length - 1];
  asIs.forEach((v, i) => { asIs[i] = v * kA; });
  withIt.forEach((v, i) => { withIt[i] = v * kW; });
  return {
    messages: users.map((u, i) => ({ ts: u.ts, calls: MESSAGES[i][1], text: u.text })),
    calls: calls.map((c, i) => ({ ts: c.ts, ctx: c.input, ctxSplit: reshaped.series[i].ctx, asIs: asIs[i], withIt: withIt[i] })),
    misses, cuts: both.cuts.map(mi => users[mi - 1].ts),
    totals: { credits: total, calls: calls.length, maxCtx: Math.max(...calls.map(c => c.input)),
              coldPause: row.coldPause, coldWait: row.coldWait, pauses: misses.filter(m => !m.waited).length,
              keeper: row.keeper, split: row.split, both: row.both, chats: row.chats, window: row.window,
              read: calls.reduce((s, c) => s + c.cached * 20e-6, 0), out: calls.reduce((s, c) => s + c.out * 2000e-6, 0) },
  };
}

module.exports = { exampleDay, SHEET, MESSAGES };
if (require.main === module) {
  const d = exampleDay(), t = d.totals, usd = x => "$" + (x / 100).toFixed(2), pc = x => Math.round(100 * x / t.credits) + "%";
  console.log(`${t.calls} calls, ${d.messages.length} messages, context up to ${Math.round(t.maxCtx / 1000)}k, billed ${usd(t.credits)}`);
  console.log(`expired after pauses: ${t.pauses} = ${usd(t.coldPause)} (${pc(t.coldPause)}); while the agent waited: ${usd(t.coldWait)} (${pc(t.coldWait)})`);
  console.log(`reading the context: ${usd(t.read)} (${pc(t.read)}); output: ${usd(t.out)} (${pc(t.out)})`);
  console.log(`kept warm -${usd(t.keeper)} (${pc(t.keeper)}); split in ${t.chats} -${usd(t.split)} (${pc(t.split)}); both -${usd(t.both)} (${pc(t.both)}); 200k window -${usd(t.window)} (${pc(t.window)})`);
  console.log("cuts at", d.cuts.map(x => new Date(x).toISOString().slice(11, 16)).join(", "), "| misses:", d.misses.map(m => `${new Date(m.ts).toISOString().slice(11, 16)} ${m.waited ? "wait" : "pause"} ${Math.round(m.pause / 60)}min +${usd(m.extra)}`).join("; "));
  console.log("cumulative end: as is", usd(d.calls[d.calls.length - 1].asIs), "with", usd(d.calls[d.calls.length - 1].withIt));
}
