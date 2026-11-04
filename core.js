// Pure logic: read a Copilot Agent Debug Log session and price the cache options.
// No VS Code API here. File access goes through an `io` object, so the same code reads local
// files (tests, node) or remote ones through VS Code (the extension runs on the Windows side and
// reads logs inside WSL, containers or SSH hosts).
//
//   io = { join(...parts), readText(path) -> Promise<string|null>,
//          stat(path) -> Promise<{mtime}|null>, list(dir) -> Promise<string[]> }
"use strict";

const path = require("path");
const harnesses = require("./harnesses");

// Older versions started every message they sent with this tag; still recognised in old logs.
const MARKER = "[cache-keeper]";
// Keep-alive wordings, one picked at random each time so they don't all read the same, in the
// language you write in that chat. All short (about the same tokens as before) and all ask for a
// bare "OK" with no tools. Cache Keeper knows its own keep-alives by exact match against these
// lists, so it still tells them apart from what you type, even after a restart. Only add to the
// lists: removing a wording would make its past uses in old logs look like your own messages.
const KEEPALIVES_BY_LANG = {
  en: [
    "Stepping away for a few minutes. Just reply OK, no tools needed.",
    "Back shortly. Please reply with only OK and don't run any tools.",
    "Taking a short break. Reply OK only, no tools.",
    "Away for a moment. Answer with just OK, without using tools.",
    "Pausing here for a bit. Only reply OK, no tool calls.",
    "Be right back. Reply with OK and nothing else, no tools.",
    "Quick break, I'll continue soon. Just say OK, don't use tools.",
    "Hold on, I'm away for a few minutes. Reply only OK, no tools.",
    "Give me a moment. Please answer just OK, no tools.",
    "I'll be back in a bit. Reply OK, nothing more, no tools.",
    "Short pause on my side. Just OK please, no tools.",
    "One moment, I'm stepping out. Reply only with OK, no tools.",
  ],
  it: [
    "Mi allontano qualche minuto. Rispondi solo OK, senza usare strumenti.",
    "Torno subito. Rispondi soltanto OK e non usare strumenti.",
    "Faccio una breve pausa. Rispondi solo OK, niente strumenti.",
    "Un attimo, sono via per poco. Scrivi solo OK, senza strumenti.",
    "Pausa veloce, poi riprendo. Rispondi OK e basta, niente strumenti.",
    "Arrivo tra poco. Solo OK per favore, senza usare strumenti.",
  ],
  fr: [
    "Je m'absente quelques minutes. Réponds juste OK, sans outils.",
    "Je reviens vite. Réponds seulement OK et n'utilise aucun outil.",
    "Petite pause. Réponds uniquement OK, pas d'outils.",
    "Un instant, je m'éloigne. Écris juste OK, sans outils.",
    "Courte pause, je reprends bientôt. Juste OK, sans outils.",
    "Je reviens dans un moment. Réponds OK, rien d'autre, sans outils.",
  ],
  es: [
    "Me ausento unos minutos. Responde solo OK, sin usar herramientas.",
    "Vuelvo enseguida. Responde únicamente OK y no uses herramientas.",
    "Hago una pausa corta. Solo OK, sin herramientas.",
    "Un momento, me alejo un poco. Escribe solo OK, sin herramientas.",
    "Pausa rápida, sigo pronto. Responde OK y nada más, sin herramientas.",
    "Vuelvo en un rato. Solo OK por favor, sin herramientas.",
  ],
  de: [
    "Ich bin ein paar Minuten weg. Antworte nur mit OK, ohne Tools.",
    "Bin gleich zurück. Bitte nur OK antworten und keine Tools nutzen.",
    "Kurze Pause. Antworte nur OK, keine Tools.",
    "Einen Moment, ich bin kurz weg. Schreib nur OK, ohne Tools.",
    "Kurze Unterbrechung, gleich geht es weiter. Nur OK, keine Tools.",
    "Ich melde mich gleich wieder. Antworte OK, sonst nichts, ohne Tools.",
  ],
};
const KEEPALIVES = KEEPALIVES_BY_LANG.en;
const KEEPALIVE_SET = new Set(Object.values(KEEPALIVES_BY_LANG).flat());

// Common short words per language, to guess which one you write in, including the ones short chat
// messages are made of (greetings, "what", "now", "new"). A word in two lists counts for both.
const LANG_WORDS = {
  en: "the and is are you this that with for not what can please should would it's i'm don't of to in " +
      "hi hello thanks yes how why where my me we there here now new",
  it: "il lo gli che non per una della delle sono questo questa come anche più perché grazie puoi fare devi è ho " +
      "ciao di su cosa c'è sì ancora adesso ora nuovo fammi dimmi nel nella del sul mi ti ci va bene allora",
  fr: "le les des est une pour pas que qui dans avec sur je tu nous vous cette sont mais fais peux merci c'est " +
      "bonjour salut oui du au aux ce ça quoi moi mon ton il y nouveau maintenant encore où",
  es: "el los las una para por que del con como pero está esto esta puedes hacer gracias también más es " +
      "hola sí qué cómo dónde muy ya hay lo nuevo ahora todavía aquí",
  de: "der die das und ist nicht ein eine mit für auf ich du wir sie bitte kannst auch noch dass sich " +
      "hallo ja nein was wie wo den dem im zu mir mal gibt neu jetzt hier",
};
const LANG_SETS = Object.fromEntries(Object.entries(LANG_WORDS).map(([k, v]) => [k, new Set(v.split(" "))]));

/**
 * The language of your messages, from common words: one of the keep-alive languages, English when
 * unsure (too few hits, or no clear winner).
 */
function detectLanguage(texts) {
  const words = texts.join(" ").toLowerCase().replace(/```[\s\S]*?```|`[^`]*`|https?:\S+/g, " ")
    .match(/[a-zà-öø-ÿ']+/g) || [];
  const score = Object.fromEntries(Object.keys(LANG_SETS).map(k => [k, 0]));
  for (const w of words) for (const k in LANG_SETS) if (LANG_SETS[k].has(w)) score[k]++;
  const ranked = Object.entries(score).sort((x, y) => y[1] - x[1]);
  const [best, n] = ranked[0], second = ranked[1][1];
  // short chats ("Ciao", "che c'è di nuovo?") give few hits, so 2 is enough when clearly ahead
  return n >= 2 && n >= 1.5 * second ? best : "en";
}

/** A keep-alive wording in `lang` (English if not covered), never the same as `previous`. */
function keepAliveText(previous, rand = Math.random, lang = "en") {
  const pool = (KEEPALIVES_BY_LANG[lang] || KEEPALIVES).filter(t => t !== previous);
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}
function isKeepAlive(text) { return KEEPALIVE_SET.has(String(text || "").trim()); }
// The handoff summary request varies (file name, sizes), so it can't be matched exactly: it starts
// with a short tag in the chat's language instead. Only add tags, for the same reason as above.
const SUMMARY_TAGS = { en: "[summary]", it: "[riepilogo]", fr: "[résumé]", es: "[resumen]", de: "[Zusammenfassung]" };
const OWN_PREFIXES = [MARKER, ...Object.values(SUMMARY_TAGS)];

/**
 * The handoff summary request, in `lang` (English if not covered). `x`: { rel, turns, compactions,
 * files, ctxK, words }. Each asks for that one file only and a reply of DONE.
 */
function summaryPrompt(lang, x) {
  const t = {
    en: `${SUMMARY_TAGS.en} I'm pausing and this chat's cache is about to expire. ` +
      `Create the file \`${x.rel}\` with a handoff summary so a fresh chat can continue: goal, what is done, ` +
      "current state, decisions and why, files changed, open problems, exact next steps, useful commands. " +
      `This chat has ${x.turns} message(s) from me, ${x.compactions} compaction(s), ${x.files} file(s) edited ` +
      `and ${x.ctxK}k tokens of context: aim for about ${x.words} words. ` +
      "Create only that file, change nothing else, then reply DONE.",
    it: `${SUMMARY_TAGS.it} Faccio una pausa e la cache di questa chat sta per scadere. ` +
      `Crea il file \`${x.rel}\` con un riepilogo di passaggio, così una nuova chat può continuare: obiettivo, cosa è fatto, ` +
      "stato attuale, decisioni e motivi, file modificati, problemi aperti, prossimi passi precisi, comandi utili. " +
      `Questa chat ha ${x.turns} messaggi miei, ${x.compactions} compattazioni, ${x.files} file modificati ` +
      `e ${x.ctxK}k token di contesto: punta a circa ${x.words} parole. ` +
      "Crea solo quel file, non modificare nient'altro, poi rispondi DONE.",
    fr: `${SUMMARY_TAGS.fr} Je fais une pause et le cache de cette conversation va expirer. ` +
      `Crée le fichier \`${x.rel}\` avec un résumé de passation pour qu'une nouvelle conversation puisse reprendre : objectif, ce qui est fait, ` +
      "état actuel, décisions et pourquoi, fichiers modifiés, problèmes ouverts, prochaines étapes précises, commandes utiles. " +
      `Cette conversation contient ${x.turns} message(s) de ma part, ${x.compactions} compaction(s), ${x.files} fichier(s) modifié(s) ` +
      `et ${x.ctxK}k tokens de contexte : vise environ ${x.words} mots. ` +
      "Crée uniquement ce fichier, ne modifie rien d'autre, puis réponds DONE.",
    es: `${SUMMARY_TAGS.es} Hago una pausa y la caché de este chat está a punto de caducar. ` +
      `Crea el archivo \`${x.rel}\` con un resumen de traspaso para que un chat nuevo pueda continuar: objetivo, qué está hecho, ` +
      "estado actual, decisiones y por qué, archivos cambiados, problemas abiertos, próximos pasos exactos, comandos útiles. " +
      `Este chat tiene ${x.turns} mensaje(s) míos, ${x.compactions} compactación(es), ${x.files} archivo(s) editado(s) ` +
      `y ${x.ctxK}k tokens de contexto: apunta a unas ${x.words} palabras. ` +
      "Crea solo ese archivo, no cambies nada más y luego responde DONE.",
    de: `${SUMMARY_TAGS.de} Ich mache eine Pause und der Cache dieses Chats läuft gleich ab. ` +
      `Erstelle die Datei \`${x.rel}\` mit einer Übergabe-Zusammenfassung, damit ein neuer Chat weitermachen kann: Ziel, was erledigt ist, ` +
      "aktueller Stand, Entscheidungen und Gründe, geänderte Dateien, offene Probleme, genaue nächste Schritte, nützliche Befehle. " +
      `Dieser Chat hat ${x.turns} Nachricht(en) von mir, ${x.compactions} Komprimierung(en), ${x.files} bearbeitete Datei(en) ` +
      `und ${x.ctxK}k Tokens Kontext: ziele auf etwa ${x.words} Wörter. ` +
      "Erstelle nur diese Datei, ändere sonst nichts und antworte dann DONE.",
  };
  return t[lang] || t.en;
}

/** The first message of a new chat from a handoff file (you finish and send it), in `lang`. */
function handoffStart(lang) {
  return { en: "Continue from the attached handoff summary. ", it: "Continua dal riepilogo di passaggio allegato. ",
           fr: "Reprends à partir du résumé de passation joint. ", es: "Continúa desde el resumen de traspaso adjunto. ",
           de: "Mach mit der angehängten Übergabe-Zusammenfassung weiter. " }[lang] ||
    "Continue from the attached handoff summary. ";
}

/** Sent by Cache Keeper, not typed by you: a keep-alive, a summary request, or an old tagged message. */
function isOwnMessage(text) {
  const t = String(text || "").trim();
  return KEEPALIVE_SET.has(t) || OWN_PREFIXES.some(p => t.startsWith(p));
}
// Cache lifetimes are not in Copilot's price sheet. Copilot CLI logs them (cacheTtlSeconds);
// these defaults are what it reported, used when nothing better is known.
const DEFAULT_TTLS = [["claude", 300], ["gpt-6.1-sol", 1800]];
const UNKNOWN_TTL = 300;       // assume the short lifetime for other models
const KEEPALIVE_MIN_NEW = 400; // never assume a keep-alive adds fewer uncached tokens than this
const KEEPALIVE_NEW = 600;     // tokens a keep-alive adds uncached besides the agent's last reply
                               // (VS Code's per-message context block + our one-line message)
const BUSY_CAP_MS = 6 * 3600 * 1000; // an open turn this quiet is taken as one that never logged its end
const HEARTBEAT_OUT = 30;      // "OK"
const SUMMARY_CALLS = 2;       // write the file, then confirm
const TOKENS_PER_WORD = 1.4;
// A summary is written (output price) and read back (uncached); on a small context with a long
// history that could cost more than the expiry it is meant to avoid. Keep it to this share.
const SUMMARY_MAX_SHARE = 1 / 3;
// Only write one automatically when it, plus starting a new chat from it, costs at most this share
// of continuing the chat cold: the margin pays for the cases where you continue the old chat anyway.
const SUMMARY_PAYS_SHARE = 0.75;

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
 * compactions (VS Code summarized the history) and files edited. Between 150 and 1500, and at
 * most `max` (what keeps its cost within SUMMARY_MAX_SHARE of an expiry), but never below 150.
 */
function summaryWords(stats, max = Infinity) {
  const w = 120 + 2 * stats.ctx / 1000 + 30 * stats.turns + 150 * stats.compactions + 10 * stats.files;
  return Math.max(150, Math.min(Math.round(Math.min(1500, w) / 50) * 50, Math.floor(max / 50) * 50));
}

let learnedTtls = {};          // model id -> { ttl, at }: newest value from Copilot CLI / Copilot SDK logs
let measuredTtls = {};         // model id -> seconds the cache was seen to last, from Local chat logs
const DAY_MS = 86400000;
const LIFETIME_MAX_AGE_DAYS = 60;

/** Every (model, cacheTtlSeconds) a parsed log line carries, wherever it sits in the event. */
function ttlsInEvent(e, out = []) {
  if (!e || typeof e !== "object") return out;
  const model = e.modelId || e.model;
  if (typeof e.cacheTtlSeconds === "number" && typeof model === "string") out.push([model, e.cacheTtlSeconds]);
  for (const v of Object.values(e)) if (v && typeof v === "object") ttlsInEvent(v, out);
  return out;
}

/**
 * Read cacheTtlSeconds per model from the newest `maxFiles` sessions under ~/.copilot/session-state
 * of each source ({ io, home }): Copilot CLI sessions and VS Code's Copilot SDK chats both log it,
 * on every model call and at each idle checkpoint. These are exact values from Copilot's backend,
 * the same one Local chats use, so they apply to Local chats too. The newest value per model wins
 * (by the event's own time), shorter or longer. Values older than `maxAgeDays` are dropped, also
 * ones learned earlier: Copilot can change a lifetime server side.
 * Returns { ttls, ages, dirs, files }: model -> seconds, model -> age in ms, where it looked, logs read.
 * (Older signature learnTtls(io, home, maxFiles) still works.)
 */
async function learnTtls(sources = nodeIo, home = require("os").homedir(), maxFiles = 30, maxAgeDays = LIFETIME_MAX_AGE_DAYS, now = Date.now()) {
  if (!Array.isArray(sources)) sources = [{ io: sources, home }];
  const cutoff = now - Math.max(1, Number(maxAgeDays) || LIFETIME_MAX_AGE_DAYS) * DAY_MS;
  const logs = [], dirs = [];
  for (const { io, home: h } of sources) {
    const dir = io.join(h, ".copilot", "session-state");
    dirs.push(dir);
    for (const n of await io.list(dir)) {
      const f = io.join(dir, n, "events.jsonl");
      const st = await io.stat(f);
      if (st && st.mtime >= cutoff) logs.push({ io, f, mtime: st.mtime });
    }
  }
  logs.sort((a, b) => a.mtime - b.mtime);
  // keep what was learned before while it is recent enough; newer events replace it
  const found = Object.fromEntries(Object.entries(learnedTtls).filter(([, v]) => v.at >= cutoff));
  for (const { io, f, mtime } of logs.slice(-maxFiles)) {
    const text = await io.readText(f);
    if (!text) continue;
    for (const line of text.split("\n")) {
      if (!line.includes("cacheTtlSeconds")) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const at = Date.parse(e.timestamp || "") || mtime;    // a line without its own time: the file's
      if (at < cutoff) continue;
      for (const [model, ttl] of ttlsInEvent(e)) {
        if (ttl > 0 && (!found[model] || at >= found[model].at)) found[model] = { ttl, at };
      }
    }
  }
  learnedTtls = found;
  return {
    ttls: Object.fromEntries(Object.entries(found).map(([m, v]) => [m, v.ttl])),
    ages: Object.fromEntries(Object.entries(found).map(([m, v]) => [m, now - v.at])),
    dir: dirs.join(", "), dirs, files: Math.min(logs.length, maxFiles),
  };
}

/**
 * Lifetimes measured in Local chats: model -> longest gap (s) after which the cache was still hit.
 * Local chat logs don't say how long the cache lasts, but a hit after N seconds proves it lasts at
 * least N. Used only when no setting or Copilot log gives the exact value, and only to lengthen the
 * built-in default (rounded down to the minute): a miss proves nothing (compaction, a tool list
 * change, a different prefix), so it never shortens it.
 */
const MEASURED_MARGIN = 60;    // a hit must beat the default by this much (call latency adds a few s)
function setMeasuredTtls(gaps) {
  measuredTtls = {};
  for (const [model, gap] of Object.entries(gaps || {})) {
    if (gap > defaultTtl(model) + MEASURED_MARGIN) measuredTtls[model] = Math.floor(gap / 60) * 60;
  }
  return { ...measuredTtls };
}

function defaultTtl(model) {
  const hit = DEFAULT_TTLS.find(([prefix]) => (model || "").startsWith(prefix));
  return hit ? hit[1] : UNKNOWN_TTL;
}

/** Where a model's cache lifetime comes from. */
function ttlSource(model, overrides = {}) {
  model = model || "";
  if (overrides[model]) return "setting";
  if (learnedTtls[model]) return "Copilot CLI/SDK log";
  if (measuredTtls[model]) return "measured in your chats";
  return "default";
}

function ttlFor(model, overrides = {}) {
  model = model || "";
  if (overrides[model]) return overrides[model];
  if (learnedTtls[model]) return learnedTtls[model].ttl;
  if (measuredTtls[model]) return measuredTtls[model];
  return defaultTtl(model);
}

/**
 * Longest proven cache lifetime per model in one chat whose log doesn't state it (Local, Codex): the
 * gap between a model call and the previous call of the same model (any kind: title or summary
 * calls also refresh the cache, `refreshes`), when the cache still covered this chat's own
 * conversation, not just the shared system prompt and tools another chat may have kept warm: at
 * least 5k tokens of its own, and at least 80% of them cached. `calls`: the chat's "call" events.
 */
function provenGaps(calls, refreshes = calls) {
  const out = {};
  if (calls.length < 2) return out;
  const base = calls[0].input || 0;
  const all = refreshes.filter(e => e.ts).sort((a, b) => a.ts - b.ts);
  for (let i = 1; i < calls.length; i++) {
    const a0 = calls[i - 1], a1 = calls[i], model = a1.model;
    if (!model || a0.model !== model) continue;
    const prev = a0.input || 0, cached = a1.cached || 0, own = prev - base;
    if (own < 5000 || cached < base + 0.8 * own || cached < 0.9 * prev) continue;
    let last = a0.ts;
    for (const e of all) {
      if (e.ts >= a1.ts) break;
      if (e.model === model) last = Math.max(last, e.ts);
    }
    const gap = Math.round((a1.ts - last) / 1000);
    if (gap > (out[model] || 0)) out[model] = gap;
  }
  return out;
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

const CALIBRATE_MIN_UNCACHED = 2000;  // only calls that sent at least this much uncached

/**
 * Credits per uncached prompt token as billed, from recent calls with a large uncached part:
 * (cost - cached * read price - output * output price) / uncached. Median of the last 5, or null
 * when there is no such call (then the price sheet's cache write price is used).
 */
function billedWriteRate(calls, sheet) {
  const samples = [];
  for (const c of calls) {
    const input = c.input || 0, cached = c.cached || 0, uncached = input - cached;
    if (!c.credits || uncached < CALIBRATE_MIN_UNCACHED) continue;
    const r = rates(sheet, input);
    const w = (c.credits - cached * r.read - (c.out || 0) * r.out) / uncached;
    if (w > 0) samples.push(w);
  }
  const recent = samples.slice(-5).sort((x, y) => x - y);
  return recent.length ? recent[Math.floor((recent.length - 1) / 2)] : null;
}

/**
 * The cost of each option for a chat, from its per-token rates (`r` at the current context size,
 * `fresh` for a new chat's first prompt). Also returns the handoff summary length it priced.
 */
function priceChat(r, fresh, ctx, firstCtx, heartbeatNew, stats) {
  let words = summaryWords(stats);
  const hit = ctx * r.read;
  const missExtra = ctx * r.write - hit;
  const perWord = TOKENS_PER_WORD * (r.out + r.write);
  if (perWord > 0) words = summaryWords(stats, (SUMMARY_MAX_SHARE * missExtra - SUMMARY_CALLS * hit) / perWord);
  return {
    words,
    cost: {
      heartbeat: hit + heartbeatNew * r.write + HEARTBEAT_OUT * r.out,
      missExtra,                                     // what letting the cache expire adds to the next message
      summary: SUMMARY_CALLS * hit + words * perWord,
      restart: (firstCtx + words * TOKENS_PER_WORD) * fresh.write, // first message of a new chat built from the summary
    },
  };
}

/**
 * Tokens a keep-alive adds uncached besides the agent's last reply, learned from this chat's
 * earlier keep-alives (`pairs`: [{ input, cached, prevOut }] for the call right after each one).
 */
function keepAliveFixedPart(pairs) {
  const fixedParts = [];
  for (const p of pairs) {
    // a keep-alive sent after the cache expired re-sent everything: says nothing about a warm one
    if (p.cached < p.input / 2) continue;
    fixedParts.push(Math.max(0, p.input - p.cached - p.prevOut));
  }
  const recent = fixedParts.slice(-5).sort((x, y) => x - y);
  // floor: the previous "reply" can include reasoning tokens that never enter the context, which
  // would make the learned fixed part look smaller than it is
  return recent.length ? Math.max(KEEPALIVE_MIN_NEW, recent[Math.floor(recent.length / 2)]) : KEEPALIVE_NEW;
}

/**
 * State of one chat from its shared event list (harnesses.js), the same for every harness, or null
 * without a model call yet. Pure. `kind`: "local", "sdk", "claude" or "codex". opts:
 *   now, ttlOverrides (cacheKeeper.ttlSeconds),
 *   priceFor(model) -> Copilot price sheet (token_prices) when the log carries no prices,
 *   credits: credits spent, when known from elsewhere (else summed from the calls, or estimated).
 */
function analyzeTrace(kind, dir, trace, opts = {}) {
  if (!trace) return null;
  const { events, info = {} } = trace;
  const now = opts.now === undefined ? Date.now() : opts.now, ttlOverrides = opts.ttlOverrides || {};
  const calls = events.filter(e => e.t === "call");
  if (!calls.length) return null;
  const last = calls[calls.length - 1];
  const model = last.model || "?";
  const ctx = last.input;                            // after any compaction: what a miss re-sends
  // Size of a fresh chat's first prompt: about the chat's first call, minus any big attachments in
  // that first message (capped).
  const firstCtx = Math.min(calls[0].input, 40000);
  const users = events.filter(e => e.t === "user");
  const isOurs = u => isOwnMessage(u.text);
  const real = users.filter(u => !isOurs(u));
  // Busy: a turn is still open. Turns nest (a subagent logs its own turn inside the agent's turn), so
  // count depth rather than comparing the last start with the last end; a message waiting for its
  // turn also counts. (Not "the log changed": VS Code also appends discovery lines to a Local chat's
  // log when another chat is opened.) Harnesses with one turn per model call (stepTurns) have a few
  // ms with no turn open between two steps of a request: right after a turn_end with no idle event
  // yet still counts as working.
  let depth = 0, pending = false, lastActivity = 0, lastTurnEnd = 0, settled = true;
  for (const e of events) {
    if (e.t === "turn_start") { depth++; pending = false; settled = false; }
    else if (e.t === "turn_end") { depth = Math.max(0, depth - 1); if (!depth) pending = false; lastTurnEnd = e.ts; }
    else if (e.t === "user" || e.t === "queued") { pending = true; settled = false; }
    else if (e.t === "abort") { depth = 0; pending = false; settled = true; }
    else if (e.t === "idle" && !depth) settled = true;
    if (e.t !== "reply" && e.t !== "edit" && e.t !== "compaction" && e.t !== "idle") lastActivity = Math.max(lastActivity, e.ts || 0, e.end || 0);
  }
  const between = !!info.stepTurns && !depth && !settled && now - lastTurnEnd < 3000;
  // A long tool run (tests, a push) logs nothing until it ends, so no short cap: only a turn quiet
  // for hours is taken as one that never logged its end.
  const busy = (depth > 0 || pending || between) && now - lastActivity < BUSY_CAP_MS;
  // Cache lifetime: a setting wins, then what the chat's own log says, then learned or default.
  const logTtl = [...calls].reverse().map(c => c.ttl).find(t => t > 0);
  const ttl = ttlOverrides[model] || logTtl || ttlFor(model, ttlOverrides);
  const ttlFrom = ttlOverrides[model] ? "setting" : logTtl ? "this chat's log" : ttlSource(model, ttlOverrides);
  // The cache is refreshed when a call starts (the prompt is read), not when its answer ends.
  const cacheFrom = last.expiresAt && last.ttl ? last.expiresAt - last.ttl * 1000 : last.ts;
  // What the chat contains, for sizing a handoff summary.
  const files = new Set(events.filter(e => e.t === "edit").flatMap(e => e.files || []));
  const compactions = Math.max(info.compactions || 0, events.filter(e => e.t === "compaction").length);
  const stats = { ctx, turns: real.length, compactions, files: files.size, calls: calls.length };
  // Tokens a keep-alive adds uncached: measured on this chat's earlier keep-alives when there are
  // any (exact); otherwise VS Code's context block + our message + the agent's last reply, which is
  // not cached yet. (Your own messages are a poor yardstick: they often bring files and tool output.)
  // Learn only the fixed part (what a keep-alive added minus the agent's reply just before it), then
  // add the current last reply: a keep-alive after a long answer adds more than one after "OK".
  const slack = info.stepTurns ? 1000 : 0;           // call starts derived from end - duration
  const pairs = [];
  for (const u of users.filter(isOurs)) {
    const i = calls.findIndex(c => c.ts >= u.ts - slack);
    if (i <= 0) continue;
    pairs.push({ input: calls[i].input || 0, cached: calls[i].cached || 0, prevOut: calls[i - 1].out || 0 });
  }
  const heartbeatNew = keepAliveFixedPart(pairs) + (last.out || 0);
  // Prices: what the log says this chat was billed per token (exact), else Copilot's price sheet,
  // with the write price corrected from what calls with a known cost were billed. Observed on Local
  // chats: a cold call is billed near the input price, below the sheet's cache_write_price, so the
  // sheet alone over-estimates an expiry by ~15%.
  const per = Object.assign({}, ...calls.map(c => c.rates || {}));
  const toR = p => p.cache_read === undefined && p.input === undefined ? null
    : { read: p.cache_read || 0, write: p.cache_write || p.input || 0, out: p.output || 0 };
  let r = toR(per), fresh = r && (toR({ ...per, ...(calls[0].rates || {}) }) || r);
  let billedWrite = r ? r.write : null, rateAt = () => r;
  if (!r) {
    const sheet = opts.priceFor ? opts.priceFor(model) : null;
    if (sheet) {
      billedWrite = billedWriteRate(calls, sheet);
      const scale = r0 => billedWrite === null ? r0 : { ...r0, write: billedWrite };
      r = scale(rates(sheet, ctx));                  // tier that applies at the current context size
      fresh = scale(rates(sheet, firstCtx));
      rateAt = c => scale(rates(sheet, c.input || 0));
    }
  }
  let cost = null, words = summaryWords(stats);      // cost null = price unknown for this model
  if (r) ({ cost, words } = priceChat(r, fresh, ctx, firstCtx, heartbeatNew, stats));
  // Credits spent: billed per call when the log says, otherwise estimated from the prices.
  let credits = 0, creditsEstimated = false;
  for (const c of calls) {
    if (c.credits !== undefined) { credits += c.credits; continue; }
    const rc = rateAt(c);
    if (rc) { credits += ((c.input || 0) - (c.cached || 0)) * rc.write + (c.cached || 0) * rc.read + (c.out || 0) * rc.out; creditsEstimated = true; }
  }
  if (typeof opts.credits === "number") { credits = opts.credits; creditsEstimated = false; }
  const firstReal = real[0];
  // The language for Cache Keeper's own messages: the agent's recent answers (it already answers in
  // your language, and says more than a short question does), plus your last few messages.
  const replies = events.filter(e => e.t === "reply").slice(-5).map(e => e.text || "");
  const lang = detectLanguage([...replies, ...real.slice(-10).map(u => u.text || "")]);
  const title = firstReal ? String(firstReal.text).replace(/\s+/g, " ").trim() : "";
  const lastUser = users[users.length - 1];
  const refreshes = events.filter(e => e.t === "call" || e.t === "aux");
  return {
    id: String(dir).split(/[\\/]/).filter(Boolean).pop(), kind, dir, model, ctx, ttl, ttlFrom,
    lastEnd: last.end || last.ts, busy, credits, creditsEstimated, cost, stats, summaryWords: words, billedWrite, lang,
    // lifetimes are only worth measuring where the log doesn't state them
    hitGaps: logTtl ? {} : provenGaps(calls, refreshes),
    cacheFrom,
    remaining: ttl - (now - cacheFrom) / 1000,
    lastUserText: lastUser ? String(lastUser.text || "") : "",
    lastUserTs: lastUser ? lastUser.ts : 0,
    title: title.length > 50 ? title.slice(0, 47) + "..." : title,   // which chat a warning is about
    // Last message you typed yourself (not one of ours): tells whether a handoff is still current.
    lastRealUserTs: Math.max(0, ...real.map(u => u.ts || 0)),
    cwd: info.cwd || "", gitRoot: info.gitRoot || "",
  };
}

/** State of one Local chat from its Agent Debug Log (main.jsonl + models.json). */
function analyze(dir, mainText, modelsText, now = Date.now(), ttlOverrides = {}) {
  return analyzeTrace("local", dir, harnesses.localTrace(mainText),
    { now, ttlOverrides, priceFor: m => modelsText ? priceSheetFrom(modelsText, m) : null });
}

/** provenGaps() of a whole Local chat log, without the rest of analyze(). */
function gapsFromLog(mainText) {
  const t = harnesses.localTrace(mainText);
  return t ? provenGaps(t.events.filter(e => e.t === "call"), t.events.filter(e => e.t === "call" || e.t === "aux")) : {};
}

async function readSession(io, dir, now = Date.now(), ttlOverrides = {}) {
  const main = await io.readText(io.join(dir, "main.jsonl"));
  if (main === null) return null;
  return analyze(dir, main, await io.readText(io.join(dir, "models.json")), now, ttlOverrides);
}

/**
 * Why a chat log gave no session: what model calls it has, so a log format Cache Keeper doesn't
 * recognise yet can be diagnosed from the output panel.
 */
function describeLog(mainText) {
  const events = parseJsonl(mainText);
  const llm = events.filter(e => e.type === "llm_request");
  const names = [...new Set(llm.map(e => String((e.attrs && e.attrs.debugName) || "?")))];
  const last = llm[llm.length - 1];
  const types = [...new Set(events.map(e => e.type))];
  return `${events.length} events (types: ${types.slice(0, 12).join(", ")}), ` +
    `${events.filter(e => e.type === "user_message").length} user messages, ${llm.length} model calls` +
    (llm.length ? ` (debugNames: ${names.slice(0, 8).join(", ")}; last call's fields: ` +
      `${Object.keys((last && last.attrs) || {}).join(", ")})` : "") +
    "; tracked calls need a debugName starting with panel/ and an inputTokens field";
}

/**
 * All chats under a debug-logs folder whose log changed in the last `maxAgeMs`. Chats skipped for
 * another reason are added to `skipped` ({ id, why }) when given.
 */
async function readSessions(io, root, now = Date.now(), maxAgeMs = 48 * 3600 * 1000, ttlOverrides = {}, skipped = null) {
  const out = [];
  for (const n of await io.list(root)) {
    const dir = io.join(root, n);
    const st = await io.stat(io.join(dir, "main.jsonl"));
    if (!st) { if (skipped) skipped.push({ id: n, why: "no main.jsonl in its folder" }); continue; }
    if (now - st.mtime > maxAgeMs) continue;
    const s = await readSession(io, dir, now, ttlOverrides);
    if (s) out.push(s);
    else if (skipped) skipped.push({ id: n, why: "no agent model call recognised: " + describeLog(await io.readText(io.join(dir, "main.jsonl"))) });
  }
  return out.sort((x, y) => y.lastEnd - x.lastEnd);
}

// ---------------------------------------------------------------- Copilot SDK chats
// VS Code's "Copilot" harness (Copilot SDK, run by the Agent Host) does not write the Agent Debug
// Log. Each chat has a folder ~/.copilot/session-state/<id>/ on the machine the window runs on
// (WSL, SSH host, container, or Windows for a local window), with events.jsonl (Copilot CLI's
// format) and workspace.yaml (client_name: vscode-agent-host). Copilot CLI sessions share the
// folder; they are not VS Code chats and are left out.

/** Simple `key: value` lines of workspace.yaml (enough for id, cwd, git_root, client_name, ...). */
function parseYamlFlat(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^([a-z_]+):\s?(.*)$/.exec(line);
    if (m && !/^[|>]/.test(m[2])) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1").trim();
  }
  return out;
}

/** State of one Copilot SDK chat from its events.jsonl, same shape as analyze(). Null without a call. */
function analyzeSdk(dir, eventsText, yaml = {}, now = Date.now(), ttlOverrides = {}) {
  return analyzeTrace("sdk", dir, harnesses.sdkTrace(eventsText, yaml), { now, ttlOverrides });
}

async function readSdkSession(io, dir, now = Date.now(), ttlOverrides = {}) {
  const yaml = parseYamlFlat(await io.readText(io.join(dir, "workspace.yaml")));
  if (yaml.client_name !== "vscode-agent-host") return null;
  const ev = await io.readText(io.join(dir, "events.jsonl"));
  return ev === null ? null : analyzeSdk(dir, ev, yaml, now, ttlOverrides);
}

/**
 * VS Code Copilot SDK chats under `home`/.copilot/session-state whose log changed in the last
 * `maxAgeMs`. Which of them belong to this window is decided by the caller (from their cwd).
 */
async function readSdkSessions(io, home, now = Date.now(), maxAgeMs = 48 * 3600 * 1000, ttlOverrides = {}, skipped = null) {
  const root = io.join(home, ".copilot", "session-state");
  const out = [];
  for (const n of await io.list(root)) {
    const dir = io.join(root, n);
    const st = await io.stat(io.join(dir, "events.jsonl"));
    if (!st || now - st.mtime > maxAgeMs) continue;
    const yaml = parseYamlFlat(await io.readText(io.join(dir, "workspace.yaml")));
    if (yaml.client_name !== "vscode-agent-host") continue;      // a Copilot CLI session
    const s = analyzeSdk(dir, await io.readText(io.join(dir, "events.jsonl")), yaml, now, ttlOverrides);
    if (s) out.push(s);
    else if (skipped) skipped.push({ id: n, why: "Copilot SDK chat with no model call yet" });
  }
  return out.sort((x, y) => y.lastEnd - x.lastEnd);
}

/**
 * Does an Agent Host chat (Copilot SDK, Claude, Codex) belong to this window? Its working folder (or git root) is one of the window's
 * folders or inside one. Paths compared case-insensitively on Windows. Chats started without a
 * folder (cwd ~/.copilot/chats/<id>) return "workspaceless": any window on that machine shows them.
 */
function sdkChatOwner(s, folders, windows = false) {
  const norm = p => { let x = String(p || "").replace(/\\/g, "/").replace(/\/+$/, ""); return windows ? x.toLowerCase() : x; };
  if (s.workspaceless || /\/\.copilot\/chats\/[^/]+$/.test(norm(s.cwd))) return "workspaceless";
  for (const p of [s.cwd, s.gitRoot].map(norm).filter(Boolean)) {
    for (const f of folders.map(norm)) if (p === f || p.startsWith(f + "/")) return "window";
  }
  return "";
}

/**
 * Auto keep warm's spending cap: `percent` of what letting the cache expire would add to the next
 * message, priced when auto keep warm starts. Null when the model's price is unknown.
 */
function autoCap(session, percent) {
  return session.cost ? session.cost.missExtra * percent / 100 : null;
}

/**
 * Whether one more keep-alive still fits under the cap, counting what was already spent and,
 * with `withSummary`, the handoff summary written when keeping warm ends.
 */
function canAffordHeartbeat(session, spentSoFar, cap, withSummary = false) {
  const c = session.cost;
  if (!c || cap === null || cap === undefined) return false;
  return spentSoFar + c.heartbeat + (withSummary ? c.summary : 0) <= cap;
}

/**
 * Extra seconds of lead for one keep-alive, so they don't go out on a fixed beat. Picture a send
 * point `percent` of the cache lifetime ahead of the safety lead, varied by +/- `percent`: the
 * result is spread over [0, 2 x percent x ttl] and never negative, so a keep-alive is never sent
 * later than the configured lead (closer to expiry). `percent` is clamped to 0..20.
 */
function keepAliveJitter(ttl, percent, rand = Math.random) {
  const p = Math.min(20, Math.max(0, Number(percent) || 0)) / 100;
  return 2 * p * ttl * Math.min(1, Math.max(0, rand()));
}

/**
 * Whether a handoff summary is worth writing automatically: writing it and the first message of a
 * new chat built from it cost clearly less than continuing this chat after its cache expired. Not
 * so on a small context, where a new chat's own setup (system prompt, tools) costs about as much.
 */
function summaryPays(session) {
  const c = session.cost;
  return !!c && c.summary + c.restart <= SUMMARY_PAYS_SHARE * c.missExtra;
}

/**
 * Order of the status-bar list: the chat you last typed in first (the one you are most likely
 * thinking about), then the other warm or working chats by soonest expiry (the next one to need a
 * decision; this order holds still while the countdowns run), then expired ones, newest first.
 * `left(s)`: seconds until s expires.
 */
function orderChats(list, currentId, left) {
  const cur = list.filter(s => s.id === currentId);
  const rest = list.filter(s => s.id !== currentId);
  const warm = rest.filter(s => s.busy || left(s) > 0).sort((x, y) => left(x) - left(y));
  const expired = rest.filter(s => !s.busy && left(s) <= 0).sort((x, y) => y.cacheFrom - x.cacheFrom);
  return [...cur, ...warm, ...expired];
}

function fmt(credits) {
  return credits >= 10 ? credits.toFixed(0) : credits.toFixed(1);
}

module.exports = {
  summaryPays,
  orderChats, MARKER, SUMMARY_TAGS, summaryPrompt, handoffStart, KEEPALIVES, KEEPALIVES_BY_LANG, keepAliveText, detectLanguage, isKeepAlive, isOwnMessage, nodeIo, analyze, readSession, readSessions, canAffordHeartbeat, autoCap, ttlFor, ttlSource, learnTtls,
  LIFETIME_MAX_AGE_DAYS, rates, priceSheetFrom, fmt, keepAliveJitter, summaryWords, describeLog,
  analyzeSdk, readSdkSession, readSdkSessions, sdkChatOwner, parseYamlFlat, setMeasuredTtls, provenGaps, gapsFromLog, defaultTtl,
  analyzeTrace,
};
