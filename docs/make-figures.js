// The guide's charts (README, "A day with and without Cache Keeper"), drawn from docs/example-day.js.
// Writes one HTML page per figure in docs/img/_html/; docs/render.sh photographs them into docs/img/*.png
// with a headless browser. Static pictures, because a README cannot run a chart: no hover layer.
// Run: node docs/make-figures.js
"use strict";
const fs = require("fs");
const path = require("path");
const { exampleDay } = require("./example-day");

// Dark chart surface (the extension's own screenshots are dark), palette slots 1 and 2, status red for a paid expiry.
const C = { surface: "#1a1a19", plane: "#0d0d0d", ink: "#f0efec", ink2: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", axis: "#383835",
            s1: "#3987e5", s2: "#d95926", critical: "#d03b3b", band: "#262624", ring: "rgba(255,255,255,0.10)" };
const FONT = `system-ui, -apple-system, "Segoe UI", sans-serif`;
const d = exampleDay(), T = d.totals;
const usd = (x, dec = 2) => "$" + (x / 100).toFixed(dec);
const pct = x => Math.round(100 * x / T.credits) + "%";
const hhmm = ts => new Date(ts).toISOString().slice(11, 16);
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

const t0 = d.calls[0].ts - 4 * 60000, t1 = d.calls[d.calls.length - 1].ts + 6 * 60000;
const hours = []; for (let h = Math.ceil(t0 / 3600000) * 3600000; h <= t1; h += 3600000) hours.push(h);

function page(name, w, h, body) {
  const html = `<!doctype html><meta charset="utf-8"><title>${name}</title>
<style>html,body{margin:0;background:${C.surface}}svg{display:block;font-family:${FONT}}
.t{fill:${C.ink};font-size:26px;font-weight:600}.s{fill:${C.ink2};font-size:17px}.a{fill:${C.muted};font-size:15px;font-variant-numeric:tabular-nums}
.l{fill:${C.ink};font-size:16px}.l2{fill:${C.ink2};font-size:15px}.v{fill:${C.ink};font-size:19px;font-weight:600}
.tile-v{fill:${C.ink};font-size:34px;font-weight:600}.tile-l{fill:${C.ink2};font-size:15px}</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  fs.mkdirSync(path.join(__dirname, "img", "_html"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "img", "_html", name + ".html"), html);
  return { name, w, h };
}
const figures = [];

// ---- 1. the session as it happened: context size through the day, pauses, paid expiries
{
  const W = 1200, H = 600, L = 78, R = 40, TOP = 228, B = 62, pw = W - L - R, ph = H - TOP - B;
  const x = ts => L + (ts - t0) / (t1 - t0) * pw, ymax = 700000, y = v => TOP + ph - v / ymax * ph;
  let g = `<text class="t" x="${L}" y="44">One chat, one working session</text>
<text class="s" x="${L}" y="72">${T.calls} model calls on Opus 5.5 · ${d.messages.length} messages of yours · every call re-reads the whole context</text>`;
  // stat tiles
  const tiles = [[usd(T.credits), "billed for the session"], [usd(T.coldPause + T.coldWait), `re-sending the context after ${d.misses.length} expired caches (${pct(T.coldPause + T.coldWait)})`],
                 [usd(T.read), `re-reading the context, call after call (${pct(T.read)})`], [Math.round(T.maxCtx / 1000) + "k", "tokens of context at the end"]];
  tiles.forEach(([v, l], i) => {
    const tx = L + i * (pw / 4);
    g += `<text class="tile-v" x="${tx}" y="130">${v}</text>`;
    const words = l.split(" "), lines = [""]; for (const wd of words) { if ((lines[lines.length - 1] + " " + wd).length > 30) lines.push(wd); else lines[lines.length - 1] += (lines[lines.length - 1] ? " " : "") + wd; }
    lines.forEach((ln, k) => { g += `<text class="tile-l" x="${tx}" y="${154 + k * 19}">${esc(ln)}</text>`; });
  });
  // pauses longer than the cache lifetime: bands, named
  const names = ["coffee", "code review", "lunch", "meeting", "a call", "waiting for CI"];
  let k = 0;
  d.misses.filter(m => !m.waited).forEach(m => {
    const from = m.ts - m.pause * 1000, bx = x(from), bw = Math.max(3, x(m.ts) - bx);
    g += `<rect x="${bx}" y="${TOP}" width="${bw}" height="${ph}" fill="${C.band}"/>`;
    k++;
  });
  // grid and axes
  for (const v of [0, 200000, 400000, 600000]) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v ? C.grid : C.axis}" stroke-width="1"/>
<text class="a" x="${L - 10}" y="${y(v) + 5}" text-anchor="end">${v / 1000}k</text>`;
  for (const hts of hours) g += `<text class="a" x="${x(hts)}" y="${H - B + 24}" text-anchor="middle">${hhmm(hts)}</text>`;
  g += `<text class="a" x="${L}" y="${TOP - 12}">context size (tokens)</text>`;
  // the line: one segment per message (the agent works), flat across pauses
  let pathD = "";
  d.calls.forEach((c, i) => { pathD += `${i ? "L" : "M"}${x(c.ts).toFixed(1)},${y(c.ctx).toFixed(1)}`; });
  g += `<path d="${pathD}" fill="none" stroke="${C.s1}" stroke-width="2.5" stroke-linejoin="round"/>`;
  // paid expiries: a ringed status marker, the amount beside it; the pause's name under the band
  k = 0;
  d.misses.forEach((m, i) => {
    const mx = x(m.ts), my = y(m.ctx);
    g += `<circle cx="${mx}" cy="${my}" r="7" fill="${C.critical}" stroke="${C.surface}" stroke-width="2"/>`;
    g += m.waited ? `<text class="l" x="${mx + 12}" y="${my + 24}">+${usd(m.extra)}</text><text class="l2" x="${mx + 12}" y="${my + 43}">the agent waited 7 min</text>`
      : `<text class="l" x="${mx - 12}" y="${my - 12}" text-anchor="end">+${usd(m.extra)}</text>`;
    if (!m.waited) {
      const from = m.ts - m.pause * 1000, cxm = (x(from) + mx) / 2;
      g += `<text class="l2" x="${cxm}" y="${TOP + ph - 10 - (k % 2) * 20}" text-anchor="middle">${names[k]} ${Math.round(m.pause / 60)} min</text>`;
      k++;
    }
  });
  // legend: what the marker and the band are (one series: named by the axis title)
  g += `<circle cx="${W - R - 388}" cy="${TOP - 17}" r="6" fill="${C.critical}" stroke="${C.surface}" stroke-width="2"/>
<text class="l2" x="${W - R - 376}" y="${TOP - 12}">cache expired: the whole context re-sent</text>
<rect x="${W - R - 86}" y="${TOP - 26}" width="16" height="16" fill="${C.band}" stroke="${C.axis}"/><text class="l2" x="${W - R - 64}" y="${TOP - 12}">a pause</text>`;
  figures.push(page("example-day", W, H, g));
}

// ---- 2. what it cost, and what it would have cost
{
  const rows = [["As it happened", T.credits, ""], ["Kept warm by Cache Keeper", T.credits - T.keeper, `${pct(T.keeper)} less`],
                [`Same work in ${T.chats} chats (handoff summaries)`, T.credits - T.split, `${pct(T.split)} less`],
                ["Both", T.credits - T.both, `${pct(T.both)} less`]];
  const W = 1200, rh = 62, TOP = 104, H = TOP + rows.length * rh + 34, L = 430, R = 210, pw = W - L - R;
  let g = `<text class="t" x="40" y="44">What the session cost, and what it would have cost</text>
<text class="s" x="40" y="72">The same ${T.calls} calls priced again, call by call, with Copilot's own prices</text>`;
  rows.forEach(([label, v, less], i) => {
    const yy = TOP + i * rh, bw = v / T.credits * pw;
    g += `<text class="l" x="${L - 16}" y="${yy + 27}" text-anchor="end">${esc(label)}</text>
<path d="M${L},${yy + 6} h${bw - 4} a4,4 0 0 1 4,4 v20 a4,4 0 0 1 -4,4 h${-(bw - 4)} z" fill="${C.s1}"/>
<text class="v" x="${L + bw + 12}" y="${yy + 28}">${usd(v)}</text>` + (less ? `<text class="l2" x="${L + bw + 86}" y="${yy + 28}">${less}</text>` : "");
  });
  g += `<line x1="${L}" x2="${L}" y1="${TOP - 4}" y2="${TOP + rows.length * rh - 16}" stroke="${C.axis}" stroke-width="1"/>`;
  figures.push(page("example-savings", W, H, g));
}

// ---- 3. the bill through the day, as it happened and with Cache Keeper + the split
{
  const W = 1200, H = 520, L = 78, R = 250, TOP = 104, B = 62, pw = W - L - R, ph = H - TOP - B;
  const x = ts => L + (ts - t0) / (t1 - t0) * pw, ymax = Math.ceil(T.credits / 1000) * 1000, y = v => TOP + ph - v / ymax * ph;
  let g = `<text class="t" x="${L}" y="44">The bill through the session</text>
<text class="s" x="${L}" y="72">Each step up is a cache that expired; the slope is the context being re-read on every call</text>`;
  for (let v = 0; v <= ymax; v += 1000) g += `<line x1="${L}" x2="${L + pw}" y1="${y(v)}" y2="${y(v)}" stroke="${v ? C.grid : C.axis}" stroke-width="1"/>
<text class="a" x="${L - 10}" y="${y(v) + 5}" text-anchor="end">${usd(v, 0)}</text>`;
  for (const hts of hours) g += `<text class="a" x="${x(hts)}" y="${H - B + 24}" text-anchor="middle">${hhmm(hts)}</text>`;
  // where the work moved to a new chat
  d.cuts.forEach((ts, i) => {
    g += `<line x1="${x(ts)}" x2="${x(ts)}" y1="${TOP}" y2="${TOP + ph}" stroke="${C.axis}" stroke-width="1" stroke-dasharray="4 4"/>
<text class="l2" x="${x(ts) + 8}" y="${TOP + 16}">new chat ${i + 2}</text>`;
  });
  const line = (key, color) => `<path d="${d.calls.map((c, i) => `${i ? "L" : "M"}${x(c.ts).toFixed(1)},${y(c[key]).toFixed(1)}`).join("")}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`;
  g += line("asIs", C.s1) + line("withIt", C.s2);
  const last = d.calls[d.calls.length - 1], ex = x(last.ts);
  // direct labels at the line ends (and so a legend in place)
  g += `<circle cx="${ex}" cy="${y(last.asIs)}" r="5" fill="${C.s1}" stroke="${C.surface}" stroke-width="2"/>
<text class="v" x="${ex + 14}" y="${y(last.asIs) + 2}">${usd(last.asIs)}</text><text class="l2" x="${ex + 14}" y="${y(last.asIs) + 22}">as it happened</text>
<circle cx="${ex}" cy="${y(last.withIt)}" r="5" fill="${C.s2}" stroke="${C.surface}" stroke-width="2"/>
<text class="v" x="${ex + 14}" y="${y(last.withIt) + 2}">${usd(last.withIt)}</text><text class="l2" x="${ex + 14}" y="${y(last.withIt) + 22}">kept warm, in ${T.chats} chats</text>`;
  figures.push(page("example-bill", W, H, g));
}

fs.writeFileSync(path.join(__dirname, "img", "_html", "figures.json"), JSON.stringify(figures));
console.log(figures.map(f => `${f.name} ${f.w}x${f.h}`).join(", "));
console.log(JSON.stringify({ billed: usd(T.credits), expiries: usd(T.coldPause + T.coldWait), expiriesShare: pct(T.coldPause + T.coldWait), n: d.misses.length,
  read: usd(T.read), keeper: usd(T.keeper), keeperPct: pct(T.keeper), split: usd(T.split), splitPct: pct(T.split), both: usd(T.both), bothPct: pct(T.both),
  window: usd(T.window), windowPct: pct(T.window), chats: T.chats, calls: T.calls, maxCtx: Math.round(T.maxCtx / 1000) }));
