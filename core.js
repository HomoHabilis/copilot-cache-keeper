// Pure logic: read a Copilot Agent Debug Log session and price the cache options.
// No VS Code API here. File access goes through an `io` object, so the same code reads local
// files (tests, node) or remote ones through VS Code (the extension runs on the Windows side and
// reads logs inside WSL, containers or SSH hosts).
//
//   io = { join(...parts), readText(path) -> Promise<string|null>,
//          stat(path) -> Promise<{mtime}|null>, list(dir) -> Promise<string[]> }
"use strict";

const path = require("path");

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

/** The text of one of Copilot's answers in the log (whichever text fields it carries). */
function replyText(e) {
  const a = e.attrs || {};
  return Object.values(a).filter(v => typeof v === "string" && v.length > 1).join(" ").slice(0, 4000);
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
 * compactions (VS Code summarized the history) and files edited. Between 150 and 1500, and at
 * most `max` (what keeps its cost within SUMMARY_MAX_SHARE of an expiry), but never below 150.
 */
function summaryWords(stats, max = Infinity) {
  const w = 120 + 2 * stats.ctx / 1000 + 30 * stats.turns + 150 * stats.compactions + 10 * stats.files;
  return Math.max(150, Math.min(Math.round(Math.min(1500, w) / 50) * 50, Math.floor(max / 50) * 50));
}

let learnedTtls = {};          // model id -> seconds, from Copilot CLI logs

/**
 * Read cacheTtlSeconds per model from the newest `maxFiles` Copilot CLI sessions under `home`.
 * A newer session wins for the same model. Values learned earlier stay until a session says
 * otherwise, so a model doesn't fall back to the default when its session gets old.
 * Returns { ttls, dir, files }: what is known now, where it looked, and how many logs it read.
 */
async function learnTtls(io = nodeIo, home = require("os").homedir(), maxFiles = 30) {
  const dir = io.join(home, ".copilot", "session-state");
  const re = /"modelId":"([^"]+)","cacheExpiresAt":"[^"]*","cacheTtlSeconds":(\d+)/g;
  const logs = [];
  for (const n of await io.list(dir)) {
    const f = io.join(dir, n, "events.jsonl");
    const st = await io.stat(f);
    if (st) logs.push({ f, mtime: st.mtime });
  }
  logs.sort((a, b) => a.mtime - b.mtime);     // oldest first: newer sessions overwrite older ones
  const found = {};
  for (const { f } of logs.slice(-maxFiles)) {
    const text = await io.readText(f);
    if (text) for (const m of text.matchAll(re)) found[m[1]] = Number(m[2]);
  }
  learnedTtls = { ...learnedTtls, ...found };
  return { ttls: { ...learnedTtls }, dir, files: Math.min(logs.length, maxFiles) };
}

/** Where a model's cache lifetime comes from: "setting", "Copilot CLI log" or "default". */
function ttlSource(model, overrides = {}) {
  model = model || "";
  if (overrides[model]) return "setting";
  if (learnedTtls[model]) return "Copilot CLI log";
  return "default";
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

const CALIBRATE_MIN_UNCACHED = 2000;  // only calls that sent at least this much uncached

/**
 * Credits per uncached prompt token as billed, from recent calls with a large uncached part:
 * (cost - cached * read price - output * output price) / uncached. Median of the last 5, or null
 * when there is no such call (then the price sheet's cache write price is used).
 */
function billedWriteRate(calls, sheet) {
  const samples = [];
  for (const c of calls) {
    const a = c.attrs, nano = a.copilotUsageNanoAiu;
    const input = a.inputTokens || 0, cached = a.cachedTokens || 0, uncached = input - cached;
    if (!nano || uncached < CALIBRATE_MIN_UNCACHED) continue;
    const r = rates(sheet, input);
    const w = (nano / 1e9 - cached * r.read - (a.outputTokens || 0) * r.out) / uncached;
    if (w > 0) samples.push(w);
  }
  const recent = samples.slice(-5).sort((x, y) => x - y);
  return recent.length ? recent[Math.floor((recent.length - 1) / 2)] : null;
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
  const isOurs = u => isOwnMessage(u.attrs && u.attrs.content);
  // Busy: a turn is still open. Turns nest (a subagent logs its own turn_start/turn_end inside the
  // agent's turn), so count depth rather than comparing the last start with the last end; a message
  // sent after everything closed also counts (its turn_start may not be logged yet). (Not "the log
  // changed": VS Code also appends discovery lines to a chat's log when another chat is opened.)
  let depth = 0, pendingMsg = false, lastActivity = 0;
  for (const e of [...events].sort((x, y) => (x.ts || 0) - (y.ts || 0))) {
    if (e.type === "turn_start") { depth++; pendingMsg = false; }
    else if (e.type === "turn_end") { depth = Math.max(0, depth - 1); if (!depth) pendingMsg = false; }
    // A new message ends whatever came before: Copilot leaves a turn open, with no turn_end, when
    // the request is stopped or when you send a message while a tool is still running.
    else if (e.type === "user_message") { depth = 0; pendingMsg = true; }
    if (/^(turn_start|turn_end|user_message|llm_request|tool_call)$/.test(e.type)) lastActivity = Math.max(lastActivity, e.ts || 0);
  }
  // A long tool run (tests, a push) logs nothing until it ends, so no short cap: only a turn quiet
  // for hours is taken as one that never logged its end.
  const busy = (depth > 0 || pendingMsg) && now - lastActivity < BUSY_CAP_MS;
  const ttl = ttlFor(model, ttlOverrides), ttlFrom = ttlSource(model, ttlOverrides);
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
  let words = summaryWords(stats);
  // Tokens a keep-alive adds uncached: measured on this chat's earlier keep-alives when there are
  // any (exact); otherwise VS Code's context block + our message + the agent's last reply, which is
  // not cached yet. (Your own messages are a poor yardstick: they often bring files and tool output.)
  // Learn only the fixed part (what a keep-alive added minus the agent's reply just before it), then
  // add the current last reply: a keep-alive after a long answer adds more than one after "OK".
  const fixedParts = [];
  for (const u of userMessages.filter(isOurs)) {
    const i = calls.findIndex(c => c.ts >= u.ts);
    if (i <= 0) continue;
    const input = calls[i].attrs.inputTokens || 0, cached = calls[i].attrs.cachedTokens || 0;
    // a keep-alive sent after the cache expired re-sent everything: says nothing about a warm one
    if (cached < input / 2) continue;
    const uncached = input - cached;
    fixedParts.push(Math.max(0, uncached - (calls[i - 1].attrs.outputTokens || 0)));
  }
  const recent = fixedParts.slice(-5).sort((x, y) => x - y);
  // floor: the previous "reply" can include reasoning tokens that never enter the context, which
  // would make the learned fixed part look smaller than it is
  const fixedNew = recent.length ? Math.max(KEEPALIVE_MIN_NEW, recent[Math.floor(recent.length / 2)]) : KEEPALIVE_NEW;
  const heartbeatNew = fixedNew + (a.outputTokens || 0);
  const sheet = modelsText ? priceSheetFrom(modelsText, model) : null;
  let cost = null;                                   // null = price unknown for this model
  let billedWrite = null;
  if (sheet) {
    // What Copilot actually billed per uncached prompt token, from this chat's own calls (the log
    // has each call's exact cost). Observed: a cold call is billed near the input price, below the
    // sheet's cache_write_price, so the sheet alone over-estimates an expiry by ~15%.
    billedWrite = billedWriteRate(calls, sheet);
    const scale = r0 => billedWrite === null ? r0 : { ...r0, write: billedWrite };
    const r = scale(rates(sheet, ctx));              // tier that applies at the current context size
    const fresh = scale(rates(sheet, firstCtx));
    const hit = ctx * r.read;
    const missExtra = ctx * r.write - hit;
    const perWord = TOKENS_PER_WORD * (r.out + r.write);
    if (perWord > 0) words = summaryWords(stats, (SUMMARY_MAX_SHARE * missExtra - SUMMARY_CALLS * hit) / perWord);
    cost = {
      heartbeat: hit + heartbeatNew * r.write + HEARTBEAT_OUT * r.out,
      missExtra,                                     // what letting the cache expire adds to the next message
      summary: SUMMARY_CALLS * hit + words * perWord,
      restart: (firstCtx + words * TOKENS_PER_WORD) * fresh.write, // first message of a new chat built from the summary
    };
  }
  const firstReal = userMessages.find(u => !isOurs(u));
  // The language for Cache Keeper's own messages: Copilot's recent answers (it already answers in
  // your language, and says more than a short question does), plus your last few messages.
  const replies = events.filter(e => e.type === "agent_response").slice(-5).map(replyText);
  const lang = detectLanguage([...replies,
    ...userMessages.filter(u => !isOurs(u)).slice(-10).map(u => String(u.attrs.content || ""))]);
  const title = firstReal ? String(firstReal.attrs.content).replace(/\s+/g, " ").trim() : "";
  return {
    id: String(dir).split(/[\\/]/).filter(Boolean).pop(), dir, model, ctx, ttl, ttlFrom, lastEnd, busy, credits,
    cost, stats, summaryWords: words, billedWrite, lang,
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
async function readSessions(io, root, now = Date.now(), maxAgeMs = 3 * 3600 * 1000, ttlOverrides = {}, skipped = null) {
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
  rates, priceSheetFrom, fmt, keepAliveJitter, summaryWords, describeLog,
};
