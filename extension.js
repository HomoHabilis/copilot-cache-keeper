// Copilot Cache Keeper: warns before a chat's prompt cache expires and offers to keep it warm
// or to write a handoff summary. Reads Copilot's Agent Debug Logs (Local chats) and Copilot SDK chat
// logs; never acts on its own below the configured threshold, and always sends into the intended chat.
"use strict";

const vscode = require("vscode");
const path = require("path");
const core = require("./core");
const sqlite = require("./sqlite");
const harnesses = require("./harnesses");

const READ_MS = 5000;          // re-read the logs
const DECIDE_MS = 1000;        // decide and redraw the countdown
const SUMMARY_LEAD = 15;       // seconds before expiry for an automatic summary
const QUEUED_AFTER_MS = 8000;  // our message not in the log by then: it was queued
const NOT_LANDED_MS = 90000;   // our message still not in the log: stop waiting for it
const REPLY_MAX_MS = 30 * 60000; // landed, but the reply never logged its end: clean up anyway
// Automatic actions only for chats seen active since this window started: after a reload the
// Chat view may show another chat, and a brand-new chat leaves no trace in the logs.
const startedAt = Date.now();

let statusItem;
let all = [];                  // sessions from the last log read, newest first
const sessions = new Map();    // id -> per-chat state

function cfg(key) { return vscode.workspace.getConfiguration("cacheKeeper").get(key); }
function lead() {
  // configured lead, plus a margin while the clock offset to the remote machine is still unknown
  // (a local window reads its logs on the same clock: no margin needed)
  return Math.max(2, cfg("keepAliveLeadSeconds") || 5) + (clockOffset === null && remote ? UNMEASURED_MARGIN : 0);
}

function stateFor(id) {
  if (!sessions.has(id)) sessions.set(id, { mode: "ask", spent: 0, cap: null });
  return sessions.get(id);
}

/** cacheKeeper.keepAliveJitterPercent (default 5, 0 = off). */
function jitterPercent() {
  const p = cfg("keepAliveJitterPercent");
  return p === undefined || p === null ? 5 : Number(p);
}

/**
 * Lead for this chat's keep-alive in this cache window: the safety lead plus a random extra, drawn
 * once per window, so keep-alives are never later than the lead but never on a fixed beat either.
 */
function keepAliveLead(st, s) {
  if (st.jitterFor !== s.cacheFrom) {
    st.jitterFor = s.cacheFrom;
    st.jitter = core.keepAliveJitter(s.ttl, jitterPercent());
  }
  return lead() + st.jitter;
}

/** Auto keep warm's cap, as a percentage of what an expiry would add (setting, default 50). */
function capPercent() {
  const p = Number(cfg("autoKeepWarmCapPercent"));
  return p > 0 ? p : 50;
}

const MAX_WARM_MINUTES = 120;  // hard cap on keep-warm time: the setting can only lower it

/** cacheKeeper.autoKeepWarmMaxMinutes in ms: 1 to 120 min, 120 when unset or invalid. */
function maxWarmMs() {
  const n = Number(cfg("autoKeepWarmMaxMinutes"));
  return (n > 0 ? Math.min(MAX_WARM_MINUTES, n) : MAX_WARM_MINUTES) * 60000;
}

/** "45 min", "2 h", "1 h 10 min". */
function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000)), h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
}

/**
 * Keep-warm time: how long Cache Keeper has kept this chat warm in a row, Keep warm once and Auto
 * keep warm alike. It starts at the first keep-warm choice and ends when the cache expires, when
 * you pick another option (default, Ignore, Summarize, Stop) or close the warning. Your own
 * message in the chat starts it again from then.
 */
function warmMs(st) { return st.warmSince ? Date.now() - st.warmSince : 0; }

/** Whether one more keep-alive keeps the chat warm within the keep-warm time limit. */
function warmFits(st, s) { return !st.warmSince || warmMs(st) + s.ttl * 1000 <= maxWarmMs(); }

/** What stops auto keep warm before the next keep-alive: its time limit or its spending cap; null if neither. */
function autoLimit(st, s) {
  if (!warmFits(st, s)) return `${fmtDuration(maxWarmMs())} limit`;
  if (!core.canAffordHeartbeat(s, st.spent, st.cap, closing(s) ? closingCost(s) : 0)) return `${capPercent()}% cap`;
  return null;
}

/** Switch a chat's mode. Starting auto keep warm fixes its spending cap from the cost right now. */
function setMode(st, s, mode) {
  if (mode === "once" || mode === "auto") {
    // keep-warm time keeps counting from earlier keep-warm choices; picking Auto keep warm again
    // once the time limit is reached starts a new period
    if (!st.warmSince || (mode === "auto" && !warmFits(st, s))) st.warmSince = Date.now();
  } else st.warmSince = null;
  st.mode = mode;
  // any new choice replaces the summary still due after an earlier Keep warm once (Back to default,
  // Ignore, Summarize, Stop: no summary you didn't ask for; Keep warm again: due after that one)
  st.summaryDueFor = undefined;
  if (mode === "auto") { st.spent = 0; st.cap = core.autoCap(s, capPercent()); }
}

// Warnings for a chat go quiet once one is closed or left unanswered, until you write in that chat
// again. Answering one (Keep warm, ...) keeps them coming on later timeouts.
function quiet(st, s) { return st.quietFor !== undefined && st.quietFor === s.lastRealUserTs; }
function goQuiet(st, s, why) {
  if (!quiet(st, s)) logx(`warnings for ${s.id.slice(0, 8)} off until you write in it again: ${why}`);
  st.quietFor = s.lastRealUserTs;
}

// ---------------------------------------------------------------- reading the logs, wherever they are

// The extension runs on the Windows (UI) side, so one install covers every window: local, WSL,
// SSH, dev containers, SSH + container. Copilot's debug logs live where its extension runs (the
// remote side), so they are read through VS Code's own remote file access (workspace.fs).

let remote = null;             // { authority } for a remote window, null for a local one
let logRootPath = null;        // debug-logs folder of this workspace (a path on the remote side)
let remoteHome = null;         // home folder on the remote side (Copilot SDK chats, cache lifetimes)
let remoteServer = null;       // VS Code server folder on the remote side (agent-host.db)
const fileCache = new Map();   // "side|path" -> { mtime, text }: re-read a log only when it changed

/**
 * File access on one side: `remoteSide` true reads where the window's workspace is (WSL, SSH,
 * container) when the window is remote; false always reads the Windows (UI) side.
 */
function makeIo(remoteSide) {
  const isRemote = () => remoteSide && !!remote;
  const toUri = p => isRemote() ? vscode.Uri.from({ scheme: "vscode-remote", authority: remote.authority, path: p }) : vscode.Uri.file(p);
  const self = {
    toUri,
    join: (...parts) => isRemote() ? path.posix.join(...parts) : path.join(...parts),
    async stat(p) {
      try { const st = await vscode.workspace.fs.stat(toUri(p)); return { mtime: st.mtime, size: st.size }; } catch { return null; }
    },
    async readBytes(p) {
      try { return Buffer.from(await vscode.workspace.fs.readFile(toUri(p))); } catch { return null; }
    },
    async readText(p) {
      const st = await self.stat(p);
      if (!st) return null;
      const key = `${isRemote() ? "r" : "l"}|${p}`;
      // modification time and size: a log appended within the same millisecond keeps its mtime
      const hit = fileCache.get(key);
      if (hit && hit.mtime === st.mtime && hit.size === st.size) return hit.text;
      const b = await self.readBytes(p);
      if (!b) return null;
      const text = b.toString("utf8");
      fileCache.set(key, { mtime: st.mtime, size: st.size, text });
      return text;
    },
    async list(d) {
      try { return (await vscode.workspace.fs.readDirectory(toUri(d))).map(([name]) => name); } catch { return []; }
    },
  };
  return self;
}
const io = makeIo(true);       // the window's side: Copilot's logs and the workspace
const localIo = makeIo(false); // Windows side: Copilot CLI sessions there, our own lock files
function toUri(p) { return io.toUri(p); }

/**
 * Find this workspace's Copilot debug-logs folder. Local window: next to our own storage.
 * Remote window: in the VS Code server's data folder on the remote side, under the same
 * workspace id as our (local) storage folder. The server sometimes moves to a sibling folder
 * with a suffix (<id>-1, <id>-2, ...: e.g. when it restarts while the old one is still locked),
 * so all of them are candidates and the one with the latest chat activity wins.
 */
async function locateLogs(context) {
  if (!context.storageUri) return null;
  const wsId = path.basename(path.dirname(context.storageUri.fsPath));
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const authority = (folder && folder.uri.scheme === "vscode-remote" && folder.uri.authority) ||
    (vscode.workspace.workspaceFile && vscode.workspace.workspaceFile.authority) || null;
  if (!vscode.env.remoteName || !authority) {
    remote = null;
    return path.join(path.dirname(context.storageUri.fsPath), "GitHub.copilot-chat", "debug-logs");
  }
  remote = { authority };
  const homes = ["/root", ...(await io.list("/home")).map(h => `/home/${h}`)];
  const servers = homes.flatMap(h => [`${h}/.vscode-server`, `${h}/.vscode-server-insiders`])
    .concat(["/vscode/vscode-server", "/vscode/vscode-server-insiders"]);
  let best = null;
  for (const server of servers) {
    const storage = `${server}/data/User/workspaceStorage`;
    const ids = (await io.list(storage)).filter(n => n === wsId || new RegExp(`^${wsId}-\\d+$`).test(n));
    for (const id of ids) {
      const dir = `${storage}/${id}/GitHub.copilot-chat/debug-logs`;
      if (!(await io.stat(dir))) continue;
      const latest = await latestActivity(dir);
      if (!best || latest > best.latest) best = { dir, latest, server };
    }
  }
  if (!best) return null;      // no Local Copilot chat in this workspace yet: try again later
  remoteServer = best.server;
  remoteHome = best.server.startsWith("/vscode/") ? remoteHome : best.server.replace(/\/\.vscode-server(-insiders)?$/, "");
  return best.dir;
}

/**
 * Where Copilot SDK chats of this window are: ~/.copilot/session-state on the window's side (the
 * Agent Host runs there: WSL, SSH host, container, or Windows for a local window), and that side's
 * agent-host.db, which says how VS Code names each chat. Found even before any Local chat exists.
 */
async function locateSdk(context) {
  if (!remote) {
    // globalStorageUri: <data>/User/globalStorage/<extension>; agentSessionData sits in <data>
    const g = context.globalStorageUri && path.dirname(context.globalStorageUri.fsPath);
    return { home: require("os").homedir(), db: g ? path.join(g, "agent-host.db") : null,
             data: g ? path.dirname(path.dirname(g)) : null };
  }
  let home = remoteHome, server = remoteServer;
  if (!home) {
    // the home folder whose agent state changed last (the server runs as that user)
    let best = null;
    for (const h of ["/root", ...(await io.list("/home")).map(n => `/home/${n}`)]) {
      for (const sub of [".copilot/session-state", ".vscode-server/data/User/globalStorage"]) {
        const st = await io.stat(`${h}/${sub}`);
        if (st && (!best || st.mtime > best.mtime)) best = { h, mtime: st.mtime };
      }
    }
    home = best && best.h;
  }
  if (!home) return null;
  if (!server) {
    for (const s of [`${home}/.vscode-server`, `${home}/.vscode-server-insiders`, "/vscode/vscode-server", "/vscode/vscode-server-insiders"]) {
      if (await io.stat(`${s}/data/User/globalStorage`)) { server = s; break; }
    }
  }
  return { home, db: server ? `${server}/data/User/globalStorage/agent-host.db` : null, data: server ? `${server}/data` : null };
}

/** Newest chat log change in a debug-logs folder (0 if none). */
async function latestActivity(dir) {
  let latest = 0;
  for (const n of await io.list(dir)) {
    const st = await io.stat(io.join(dir, n, "main.jsonl"));
    if (st && st.mtime > latest) latest = st.mtime;
  }
  return latest;
}

const RELOCATE_MS = 60000;     // look again for a newer sibling storage folder this often
let locatedAt = 0;

let sdkLoc = null;             // { home, db } for this window's Copilot SDK chats
function lookbackMs() { return Math.max(1, Number(cfg("lookbackHours")) || 48) * 3600 * 1000; }

async function readAll(context) {
  // once a minute, also while nothing is found yet (a remote window with no Local chat): each look
  // lists home and server folders on the remote side
  if (!locatedAt || Date.now() - locatedAt > RELOCATE_MS) {
    locatedAt = Date.now();
    const found = await locateLogs(context);
    if (found && found !== logRootPath) {
      logx(`reading Copilot Local chat logs at ${remote ? remote.authority + ":" : ""}${found}`);
      logRootPath = found;
      baseline.local = null;   // "seen active since start" is judged afresh in the new folder
      scanEvidence();
    }
    const loc = await locateSdk(context);
    if (loc && (!sdkLoc || loc.home !== sdkLoc.home || loc.db !== sdkLoc.db)) {
      sdkLoc = loc;
      logx(`reading Agent Host chats (Copilot SDK, Claude, Codex) for ${remote ? remote.authority + ":" : ""}${loc.home}` +
        (loc.db ? `, chat list and names from ${loc.db}` : ", agent-host.db not found"));
      learnLifetimes();
    }
  }
  const skipped = [], ttls = cfg("ttlSeconds") || {};
  const local = logRootPath ? await core.readSessions(io, logRootPath, Date.now(), lookbackMs(), ttls, skipped) : [];
  const sdkAll = sdkLoc ? await core.readSdkSessions(io, sdkLoc.home, Date.now(), lookbackMs(), ttls, skipped) : [];
  await refreshPrices(context).catch(e => logx("prices: " + e.message));
  let agentAll = [];
  try { agentAll = await readAgentChats(skipped); } catch (e) { logx("Claude/Codex chats: " + e.message); }
  const agent = [];
  for (const s of [...sdkAll, ...agentAll]) {
    const why = await agentNotMine(s);
    if (why) noteWhy(s.id, why); else agent.push(s);
  }
  noteEvidence([...local, ...agent]);
  for (const s of [...local, ...agent]) noteHit(s);
  // Say once (and again when it changes) why a chat is not in the list.
  for (const k of skipped) noteWhy(k.id, k.why);
  for (const s of [...local, ...agent]) noteWhy(s.id, unmanagedWhy(s));
  return [...local, ...agent].sort((x, y) => y.lastEnd - x.lastEnd);
}

// ---------------------------------------------------------------- which window acts on an SDK chat
// Local chats are stored per workspace, so only the window that owns them sees them. Copilot SDK
// chats are stored per machine: every window on that machine reads all of them. A chat started in a
// folder belongs to the window that has the folder open. A chat started without a folder can be
// opened from any of those windows, so exactly one of them takes it: the first to write a small
// claim file next to our global storage (shared by all windows), refreshed on every read. A window
// closed or reloaded stops refreshing it and another one takes over 20 s later.
const windowId = Math.random().toString(36).slice(2, 10);
const CLAIM_STALE_MS = 20000;
let claimDir = null;

function windowFolders() {
  return (vscode.workspace.workspaceFolders || []).map(f => f.uri.scheme === "file" ? f.uri.fsPath : f.uri.path);
}

/** Why this window leaves an Agent Host chat (Copilot SDK, Claude, Codex) alone ("" = it is ours). */
async function agentNotMine(s) {
  const label = KIND_LABEL[s.kind] || s.kind;
  const owner = core.sdkChatOwner(s, windowFolders(), !remote && process.platform === "win32");
  if (owner === "window") return "";
  if (owner === "") return `${label} chat in ${s.cwd || "another folder"}, not open in this window`;
  if (!claimDir) return "";
  const f = path.join(claimDir, s.id);
  const now = Date.now();
  const b = await localIo.readBytes(f);   // never from the cache: other windows rewrite it within the same second
  const text = b && b.toString("utf8");
  const [who, at] = String(text || "").split(" ");
  if (who && who !== windowId && now - Number(at) < CLAIM_STALE_MS) return `${label} chat without a folder, handled by another window`;
  try { await vscode.workspace.fs.writeFile(vscode.Uri.file(f), Buffer.from(`${windowId} ${now}`)); } catch { return ""; }
  return "";
}

// ---------------------------------------------------------------- Claude and Codex harness chats
// VS Code's Claude and Codex harnesses run in the same Agent Host as Copilot SDK chats. Generic
// part (any harness): agent-host.db lists the chats (table sessions: "<harness>:/<VS Code id>",
// who created it, last change), and each chat's agentSessionData/<VS Code id>/session.db has its
// metadata: the link to the harness's own log, its folder, how it is billed (model
// "@provider=copilot:..." or "vscode-proxy:..." = through Copilot) and, for Claude, the credits
// Copilot billed per turn. Per harness: where its log is, and its translator (harnesses.js).
// Only chats VS Code created are read (registration "explicit"): the Claude harness also lists
// your own Claude Code sessions ("discovered"), which are not billed through Copilot.

/** "file:///home/u/x" -> "/home/u/x" (a Windows path for a local window). */
function uriPath(u) {
  if (!u) return "";
  try { const x = vscode.Uri.parse(String(u)); return x.scheme === "file" && !remote ? x.fsPath : x.path; } catch { return String(u); }
}
const jsonOr = (v, d) => { try { return JSON.parse(v); } catch { return d; } };

const AGENT_HARNESSES = {
  claude: {
    label: "Claude",
    link: m => jsonOr(m.defaultChatProviderData, {}).sdkSessionId,
    model: m => (jsonOr(m["claude.model"], {}) || {}).id,
    cwd: m => uriPath((jsonOr(m["claude.workingDirectories"], []) || [])[0]),
    translate: harnesses.claudeTrace,
    // ~/.claude/projects/<folder>/<link>.jsonl: which folder isn't recorded. Claude names it after
    // the working folder (every character but letters and digits becomes "-"): look there first,
    // then (`wide`) in each folder.
    async locate(home, link, startedAt, cwd, wide) {
      const root = io.join(home, ".claude", "projects");
      if (cwd) {
        const f = io.join(root, String(cwd).replace(/[^a-zA-Z0-9]/g, "-"), `${link}.jsonl`);
        if (await io.stat(f)) return f;
      }
      if (!wide) return null;
      for (const d of await io.list(root)) {
        const f = io.join(root, d, `${link}.jsonl`);
        if (await io.stat(f)) return f;
      }
      return null;
    },
  },
  codex: {
    label: "Codex",
    link: m => m["codex.threadId"],
    model: m => m["codex.model"],
    cwd: m => uriPath(m["codex.cwd"]),
    translate: harnesses.codexTrace,
    // ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<link>.jsonl, dated from the chat's start (UTC or local)
    async locate(home, link, startedAt, cwd, wide) {
      const root = io.join(home, ".codex", "sessions"), seen = new Set(), now = Date.now();
      // the log stays in the folder of the day the chat started: that day and its neighbours first,
      // then (`wide`) every day since (never later than today, at most 400 days back)
      const from = Math.max(Math.min(startedAt || now, now), now - 400 * 86400000);
      const to = wide ? now + 86400000 : Math.min(from + 86400000, now + 86400000);
      for (let t = from - 86400000; t <= to; t += 86400000) {
        for (const d of [new Date(t)]) {
          for (const [y, mo, da] of [[d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()], [d.getFullYear(), d.getMonth() + 1, d.getDate()]]) {
            const dir = io.join(root, String(y), String(mo).padStart(2, "0"), String(da).padStart(2, "0"));
            if (seen.has(dir)) continue;
            seen.add(dir);
            const n = (await io.list(dir)).find(x => x.endsWith(`-${link}.jsonl`));
            if (n) return io.join(dir, n);
          }
        }
      }
      return null;
    },
  },
};
const KIND_LABEL = { local: "Local", sdk: "Copilot SDK", claude: "Claude", codex: "Codex" };

/** Rows of a table in an SQLite file on the window's side, re-read only when the file changes. */
const dbCache = new Map();     // path -> { key, tables }
async function dbTable(file, table) {
  const [a, b] = [await io.stat(file), await io.stat(file + "-wal")];
  if (!a) return null;
  const key = `${a.mtime}|${a.size}|${b && b.mtime}|${b && b.size}`;
  let hit = dbCache.get(file);
  if (!hit || hit.key !== key) {
    hit = { key, tables: {}, db: await io.readBytes(file), wal: b ? await io.readBytes(file + "-wal") : null };
    dbCache.set(file, hit);
  }
  if (!(table in hit.tables)) hit.tables[table] = hit.db ? sqlite.readTable(hit.db, hit.wal, table) : null;
  return hit.tables[table];
}

/** A harness chat's session.db: metadata (key -> value) and credits Copilot billed (null if unknown). */
async function chatMeta(vscId) {
  const f = io.join(sdkLoc.data, "agentSessionData", vscId, "session.db");
  const rows = await dbTable(f, "session_metadata");
  if (!rows) return null;
  const meta = Object.fromEntries(rows.map(r => [r.key, r.value]));
  let credits = null;
  for (const r of (await dbTable(f, "turn_usage")) || []) {
    const nano = (((jsonOr(r.usage, {}) || {})._meta || {}).copilotUsage || {}).totalNanoAiu;
    if (typeof nano === "number") credits = (credits || 0) + nano / 1e9;
  }
  return { meta, credits };
}

const logPaths = new Map();    // "<harness>:<link>" -> log path (found once)
const logMisses = new Map();   // "<harness>:<link>" -> { first, last }: when the wide search failed
const WIDE_SEARCH_MS = 60000;  // a log still not found after a while: the wide search (many folders) at most this often
const WIDE_EAGER_MS = 120000;  // ... but on every read in the first minutes (a new chat's log may just be late)

/**
 * Claude and Codex chats VS Code created on this window's side, active within the lookback, as
 * sessions (same shape as Local ones). `skipped` gets { id, why } for the others.
 */
async function readAgentChats(skipped, now = Date.now()) {
  if (!sdkLoc || !sdkLoc.db || !sdkLoc.data) return [];
  const rows = (await dbTable(sdkLoc.db, "sessions")) || [];
  const out = [];
  for (const row of rows) {
    const m = /^([a-z]+):\/+([^/?#]+)$/.exec(String(row.session_uri || ""));
    const h = m && AGENT_HARNESSES[m[1]];
    if (!h || now - Number(row.modified_time || 0) > lookbackMs()) continue;
    const [kind, vscId] = [m[1], m[2]];
    const s = await readAgentChat(kind, vscId, row, now, skipped);
    if (s) out.push(s);
  }
  return out;
}

async function readAgentChat(kind, vscId, row, now = Date.now(), skipped = null) {
  const h = AGENT_HARNESSES[kind];
  const why = w => { if (skipped) skipped.push({ id: vscId, why: `${h.label} chat: ${w}` }); return null; };
  if (row.registration_source !== "explicit") return why("not created in VS Code (for example a Claude Code session VS Code found)");
  const cm = await chatMeta(vscId);
  if (!cm) return why("no session.db yet");
  const route = /^@provider=([^:]+):/.exec(h.model(cm.meta) || "");
  if (route && !["copilot", "vscode-proxy"].includes(route[1])) return why(`billed to your own ${route[1]} account, not through Copilot`);
  const link = h.link(cm.meta);
  if (!link) return why("no message sent yet");
  const key = `${kind}:${link}`;
  let file = logPaths.get(key);
  if (!file || !(await io.stat(file))) {
    const miss = logMisses.get(key), t = Date.now();
    const wide = !miss || t - miss.first < WIDE_EAGER_MS || t - miss.last >= WIDE_SEARCH_MS;
    file = await h.locate(sdkLoc.home, link, Number(row.start_time) || 0, h.cwd(cm.meta), wide);
    if (!file) {
      if (wide) logMisses.set(key, { first: miss ? miss.first : t, last: t });
      return why(`its log (${link.slice(0, 8)}) was not found`);
    }
    logMisses.delete(key);
    logPaths.set(key, file);
  }
  const s = core.analyzeTrace(kind, file, core.cachedTrace(`${kind}|${file}`, await io.readText(file), h.translate), {
    now, ttlOverrides: cfg("ttlSeconds") || {}, priceFor, credits: cm.credits === null ? undefined : cm.credits });
  if (!s) return why("no model call yet");
  return Object.assign(s, { id: vscId, vscId, logPath: file, cwd: h.cwd(cm.meta) || s.cwd,
    workspaceless: cm.meta["agentHost.workspaceless"] === "true", agentRow: row });
}

// ---------------------------------------------------------------- Copilot prices for any chat
// Local chats carry Copilot's price sheet (models.json); Claude and Codex logs carry no prices. The
// newest models.json of this window's side serves them (same sheet for every chat), re-found every
// 30 min: this workspace's Local chats first, else the most recently used workspaces.
let priceBook = { text: null, at: 0, from: "", wideAt: 0 };
const PRICE_WIDE_MS = 60000;   // no price sheet yet: other workspaces are searched at most this often
async function refreshPrices(context) {
  if (Date.now() - priceBook.at < 30 * 60 * 1000 && priceBook.text) return;
  priceBook.at = Date.now();
  const newest = async dirs => {
    let best = null;
    for (const dl of dirs) {
      for (const n of await io.list(dl)) {
        const f = io.join(dl, n, "models.json");
        const st = await io.stat(f);
        if (st && (!best || st.mtime > best.mtime)) best = { f, mtime: st.mtime };
      }
    }
    return best;
  };
  let best = logRootPath ? await newest([logRootPath]) : null;
  // other workspaces: every workspaceStorage folder, so not on every read while none has prices
  if (!best && Date.now() - priceBook.wideAt >= PRICE_WIDE_MS) {
    priceBook.wideAt = Date.now();
    const ws = remote ? (remoteServer || (sdkLoc && `${sdkLoc.home}/.vscode-server`)) + "/data/User/workspaceStorage"
      : context.storageUri ? path.dirname(path.dirname(context.storageUri.fsPath)) : null;
    if (ws) {
      const dirs = [];
      for (const w of await io.list(ws)) {
        const dl = io.join(ws, w, "GitHub.copilot-chat", "debug-logs");
        const st = await io.stat(dl);
        if (st) dirs.push({ dl, mtime: st.mtime });
      }
      best = await newest(dirs.sort((a, b) => b.mtime - a.mtime).slice(0, 5).map(d => d.dl));
    }
  }
  if (best) {
    const text = await io.readText(best.f);
    if (text) { priceBook = { ...priceBook, text, from: best.f }; }
  }
}
function priceFor(model) { return priceBook.text ? core.priceSheetFrom(priceBook.text, model) : null; }

// ---------------------------------------------------------------- cache lifetimes

// Cache lifetimes learned from Copilot CLI and Copilot SDK logs, on both sides (the Windows side and
// the window's remote side). Logged when they change, so the Output panel says where each
// countdown's length comes from.
let lifetimesShown = null;
async function learnLifetimes() {
  try {
    const sources = [{ io: localIo, home: require("os").homedir() }];
    if (remote && sdkLoc) sources.push({ io, home: sdkLoc.home });
    const r = await core.learnTtls(sources, undefined, 30, maxAgeDays());
    const line = lifetimesLine(r);
    if (line !== lifetimesShown) { lifetimesShown = line; logx(line); }
  } catch (e) { logx("cache lifetimes: " + e.message); }
}
/** How old a lifetime value may be (Copilot logs and Local measurements), cacheKeeper.lifetimeMaxAgeDays. */
function maxAgeDays() {
  const d = Number(cfg("lifetimeMaxAgeDays"));
  return d > 0 ? d : core.LIFETIME_MAX_AGE_DAYS;
}
function ago(ms) { return ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))} min` : ms < 2 * 86400000 ? `${Math.round(ms / 3600000)} h` : `${Math.round(ms / 86400000)} d`; }
function lifetimesLine(r) {
  const known = Object.entries(r.ttls).map(([m, t]) => `${m} ${t} s (${ago(r.ages[m])} ago)`).join(", ");
  const measured = Object.entries(core.setMeasuredTtls(evidenceGaps())).map(([m, t]) => `${m} ≥${t} s`).join(", ");
  return `cache lifetimes from Copilot CLI/SDK logs of the last ${maxAgeDays()} days (${r.files} sessions in ${r.dir}): ` +
    (known || "none") + (measured ? `; measured in your Local chats: ${measured}` : "") +
    "; otherwise defaults (Claude 300 s, Sol 6.1 1800 s, other 300 s); cacheKeeper.ttlSeconds overrides";
}

// Local chat logs don't record cache lifetimes, but a cache hit after a long pause proves a minimum
// (see core.provenGaps). The longest proof per model is kept across windows and restarts (global
// state, cacheKeeper.lifetimeMaxAgeDays) and lengthens the default for models no Copilot log or setting covers.
const EVIDENCE_KEY = "measuredCacheGaps";
let globalState = null;
function evidence() {
  const all = (globalState && globalState.get(EVIDENCE_KEY)) || {};
  const fresh = {};
  for (const [m, v] of Object.entries(all)) if (v && Date.now() - v.at < maxAgeDays() * 86400000) fresh[m] = v;
  return fresh;
}
function evidenceGaps() { return Object.fromEntries(Object.entries(evidence()).map(([m, v]) => [m, v.gap])); }
function noteEvidence(list) {
  const ev = evidence();
  let changed = false;
  for (const s of list) {
    for (const [m, gap] of Object.entries(s.hitGaps || {})) {
      // a longer proof replaces the old one; the same proof seen again keeps it from ageing out
      if (!ev[m] || gap > ev[m].gap || (gap === ev[m].gap && Date.now() - ev[m].at > 86400000)) {
        ev[m] = { gap, at: Date.now() }; changed = true;
      }
    }
  }
  if (!changed) return;
  if (globalState) globalState.update(EVIDENCE_KEY, ev);
  core.setMeasuredTtls(evidenceGaps());
  learnLifetimes();            // logs the lifetimes line again if it changed
}
/** Once per log folder: look for that evidence in every Local chat of the workspace, not just recent ones. */
async function scanEvidence() {
  if (!logRootPath) return;
  const list = [];
  for (const n of (await io.list(logRootPath)).slice(-300)) {
    const b = await io.readBytes(io.join(logRootPath, n, "main.jsonl"));   // not cached: read once
    if (b) list.push({ hitGaps: core.gapsFromLog(b.toString("utf8")) });
  }
  noteEvidence(list);
}

// Whether the cache was still warm when a message arrived: the cached share of the call that
// answered it, logged once per message, with the gap since the previous call measured from its
// start and from its end (which of the two the cache lifetime runs from is still an open question).
// Cache Keeper's own messages are counted too, for diagnostics.
const hitStats = { warm: 0, cold: 0, last: [] };
function noteHit(s) {
  const h = s.lastMsgCall, st = stateFor(s.id);
  if (!h || st.hitFor === h.at) return;
  st.hitFor = h.at;
  if (h.at + (clockOffset || 0) < startedAt) return;          // from before this window started
  const pct = h.input ? Math.round(100 * h.cached / h.input) : 0;
  const warm = pct >= 50;
  if (h.own) {
    hitStats[warm ? "warm" : "cold"]++;
    hitStats.last = [...hitStats.last, `${s.id.slice(0, 8)} ${pct}% after ${h.sinceStart} s`].slice(-5);
  }
  logx(`cache ${warm ? "hit" : "MISS"} for ${h.own ? "Cache Keeper's message" : "your message"} in ${s.id.slice(0, 8)}: ` +
    `${pct}% cached (${Math.round(h.cached / 1000)}k of ${Math.round(h.input / 1000)}k), ` +
    `${h.sinceStart} s after the previous call started (${h.sinceEnd} s after it ended), lifetime ${s.ttl} s`);
}

const whyShown = new Map();    // chat id -> reason last logged for not listing it ("" = listed)
function noteWhy(id, why) {
  if ((whyShown.get(id) || "") === why) return;
  whyShown.set(id, why);
  logx(why ? `chat ${id.slice(0, 8)} not listed: ${why}` : `chat ${id.slice(0, 8)} listed`);
}
function unmanagedWhy(s) {
  if (!s.lastRealUserTs) return "no message from you in its log";
  if (s.cost && s.cost.missExtra < cfg("minCredits")) {
    return `an expiry would add only ${core.fmt(s.cost.missExtra)} cr (below cacheKeeper.minCredits ${cfg("minCredits")}); ` +
      "rechecked on every read as the context grows";
  }
  return "";
}

/** Output panel: every chat folder of this workspace and whether it is tracked. */
async function diagnose(context) {
  out.show(true);
  const where = p => (remote ? remote.authority + ":" : "") + p;
  lifetimesShown = null;
  await learnLifetimes();
  const now = Date.now(), ttls = cfg("ttlSeconds") || {};
  const lookback = Math.round(lookbackMs() / 3600000);
  const line = (s, age) => `${describe(s)}, cache lifetime ${s.ttl} s (${s.ttlFrom}), ` +
    `${s.cost ? `expiry +${core.fmt(s.cost.missExtra)} cr` : "no price"}, language ${s.lang}, ` +
    (age > lookback * 60 ? `not listed: last active more than cacheKeeper.lookbackHours (${lookback} h) ago`
      : unmanagedWhy(s) ? `not listed: ${unmanagedWhy(s)}` : "listed");
  logx(`--- Cache Keeper's own messages since this window started: ${hitStats.warm} landed warm, ${hitStats.cold} cold` +
    (hitStats.last.length ? ` (latest: ${hitStats.last.join("; ")})` : ""));
  logx(`--- diagnostics: Local chats (Agent Debug Log) at ${logRootPath ? where(logRootPath) : "(none in this workspace yet)"}`);
  if (logRootPath) {
    for (const n of await io.list(logRootPath)) {
      const dir = io.join(logRootPath, n);
      const st = await io.stat(io.join(dir, "main.jsonl"));
      const age = st ? Math.round((now - st.mtime) / 60000) : 0;
      const s = st && await core.readSession(io, dir, now, ttls);
      const text = st && !s ? await io.readText(io.join(dir, "main.jsonl")) : null;
      logx(`${n.slice(0, 8)} Local (log changed ${st ? age + " min ago" : "never"}): ` + (s ? line(s, age)
        : st ? `not tracked: ${core.describeLog(text)}` : "not tracked: no main.jsonl"));
    }
  }
  const sdkRoot = sdkLoc && io.join(sdkLoc.home, ".copilot", "session-state");
  logx(`--- Copilot SDK chats at ${sdkRoot ? where(sdkRoot) : "(not found)"}` +
    (sdkLoc ? `, chat names from ${sdkLoc.db || "(agent-host.db not found)"}` : ""));
  if (!sdkRoot) return;
  const ids = await sdkIds(true);
  for (const n of await io.list(sdkRoot)) {
    const dir = io.join(sdkRoot, n);
    const st = await io.stat(io.join(dir, "events.jsonl"));
    if (!st) continue;
    const yaml = core.parseYamlFlat(await io.readText(io.join(dir, "workspace.yaml")));
    if (yaml.client_name !== "vscode-agent-host") continue;    // Copilot CLI session
    const age = Math.round((now - st.mtime) / 60000);
    if (age > 7 * 24 * 60) continue;                           // keep the list readable
    const s = await core.readSdkSession(io, dir, now, ttls);
    const mine = s ? await agentNotMine(s) : "";
    const name = s ? sdkVsCodeId(s, ids) : null;
    logx(`${n.slice(0, 8)} SDK (log changed ${age} min ago, folder ${yaml.cwd || "?"}): ` + (!s ? "no model call yet"
      : mine ? `not listed: ${mine}` : line(s, age) + (name ? `, opens as agent-host-copilotcli:/${name.slice(0, 8)}` : ", VS Code's name for it not found: can't send into it")));
  }
  logx(`--- Claude and Codex chats, listed in ${sdkLoc.db || "(agent-host.db not found)"}; Copilot prices from ${priceBook.from || "(no models.json found: no costs)"}`);
  for (const row of (sdkLoc.db && await dbTable(sdkLoc.db, "sessions")) || []) {
    const m = /^([a-z]+):\/+([^/?#]+)$/.exec(String(row.session_uri || ""));
    if (!m || !AGENT_HARNESSES[m[1]]) continue;
    const age = Math.round((now - Number(row.modified_time || 0)) / 60000);
    if (age > 7 * 24 * 60) continue;
    const skipped = [];
    const s = await readAgentChat(m[1], m[2], row, now, skipped);
    const mine = s ? await agentNotMine(s) : "";
    logx(`${m[2].slice(0, 8)} ${AGENT_HARNESSES[m[1]].label} (changed ${age} min ago): ` + (!s ? `not tracked: ${skipped.map(k => k.why).join("; ")}`
      : mine ? `not listed: ${mine}` : line(s, age) + `, log ${s.logPath}, credits ${s.creditsEstimated ? "estimated" : "as billed"}, opens as agent-host-${m[1]}:/${m[2].slice(0, 8)}`));
  }
}

// Log timestamps come from the machine where Copilot runs (WSL, SSH host, container); the
// countdown runs on the Windows clock. The offset between the two (plus network delay) is measured
// on every message Cache Keeper sends: Windows send time vs the time the remote log recorded.
// The largest recent value is used, so any error makes the countdown end early, not late.
const offsets = [];            // remote log time - local send time, ms
let clockOffset = null;        // null until measured
const UNMEASURED_MARGIN = 3;   // extra seconds of lead until the offset is known

function noteOffset(ms) {
  offsets.push(ms);
  if (offsets.length > 5) offsets.shift();
  const prev = clockOffset;
  // only ever correct towards an earlier countdown: a remote clock behind Windows already
  // makes it end early, which is the safe side
  clockOffset = Math.max(0, ...offsets);
  if (prev === null || Math.abs(clockOffset - prev) > 1000) {
    logx(`clock offset (remote log - Windows, incl. network): ${(clockOffset / 1000).toFixed(1)} s`);
  }
}

function live(s) {             // remaining seconds, on the remote clock, computed now
  return s.ttl - (Date.now() + (clockOffset || 0) - s.cacheFrom) / 1000;
}

function describe(s) {
  return (s.title ? `"${s.title}", ` : "") + `${s.model}, ${Math.round(s.ctx / 1000)}k context`;
}

// "Seen active since this window started", without comparing clocks: the chat's last call changed
// after our first read of the logs, or the chat appeared after it.
// Kept per kind of chat: Local chats are judged afresh when their log folder moves, SDK chats not.
let baseline = {};             // kind -> (id -> cacheFrom at our first read)
function seenLive(s) {
  const b = baseline[s.kind || "local"];
  if (!b) return false;
  return !b.has(s.id) || b.get(s.id) !== s.cacheFrom;
}
function setAll(r) {
  for (const kind of Object.keys(KIND_LABEL)) {
    const ready = kind === "local" ? !!logRootPath : !!sdkLoc;
    if (!baseline[kind] && ready) baseline[kind] = new Map(r.filter(x => x.kind === kind).map(x => [x.id, x.cacheFrom]));
  }
  all = r;
}
/** This chat's state read again from its own log (Local or SDK). */
async function reread(s) {
  const ttls = cfg("ttlSeconds") || {};
  if (AGENT_HARNESSES[s.kind]) return readAgentChat(s.kind, s.vscId, s.agentRow);
  return s.kind === "sdk" ? core.readSdkSession(io, s.dir, Date.now(), ttls) : core.readSession(io, s.dir, Date.now(), ttls);
}
// Thresholds are in context tokens: an expiry costs about context x the model's price, so one value
// fits cheap and expensive models. Acting on its own still needs a known price.
// Not in the Settings UI (no reason to change them), but still read from settings.json if set
// there: keepAliveLeadSeconds, keepAliveJitterPercent, lifetimeMaxAgeDays.
/** From this context size a chat is expensive to let expire (cacheKeeper.thresholdTokens, default 100k). */
function thresholdTokens() {
  const v = cfg("thresholdTokens");
  return typeof v === "number" && v >= 0 ? v : 100000;
}
function aboveThreshold(s) { return !!s.cost && s.ctx >= thresholdTokens(); }
/**
 * The chat you are most likely looking at: the one where you last typed. (Not the latest model call:
 * Cache Keeper's own keep-alives and summaries, or another chat's agent, make those newer.)
 */
function currentChat() {
  const list = all.filter(managed);
  return list.reduce((best, s) => !best || (s.lastRealUserTs || 0) > (best.lastRealUserTs || 0) ? s : best, null);
}
function managed(s) {
  // minCredits filters everything (list, warnings, actions, orange status): a cheap expiry isn't worth a word
  return s.lastRealUserTs && !(s.cost && s.cost.missExtra < cfg("minCredits"));
}

// ---------------------------------------------------------------- sending into a given chat

// VS Code has no "send to chat X" command, and what the Chat view shows can't be read reliably.
// So the target chat is opened explicitly as an editor tab ("Open as Editor"), which focuses it,
// and the message is submitted into the focused chat. Same prompt as in the Chat view, so the
// cache is still hit. A tab Cache Keeper opened is closed again once the reply is in.

const sleep = ms => new Promise(r => setTimeout(r, ms));
let out;
function logx(msg) {
  const line = `${new Date().toTimeString().slice(0, 8)} ${msg}`;
  if (out) out.appendLine(line);
  // for live tests: a copy of the log in a local file (setting not shown in the Settings UI)
  const f = cfg("debugLogFile");
  if (f) try { require("fs").appendFileSync(f, line + "\n"); } catch { /* ignore */ }
}

// A Local chat opens as vscode-chat-session://local/<base64 of its log id>. A Copilot SDK chat
// opens as agent-host-copilotcli:/<id>, where <id> is VS Code's own id for it, not the id of its
// log folder: the two are linked in agent-host.db (chats_v2.provider_data.sdkSessionId). A chat
// started without a folder also carries VS Code's id in its working folder (~/.copilot/chats/<id>).
// (Tested: VS Code 1.142, local and WSL windows; the scheme is the same for both, since the window's
// own Agent Host is the "ambient" one.)
let idCache = { key: "", map: new Map() };
async function sdkIds(force = false) {
  if (!sdkLoc || !sdkLoc.db) return idCache.map;
  const [a, b] = [await io.stat(sdkLoc.db), await io.stat(sdkLoc.db + "-wal")];
  const key = `${sdkLoc.db}|${a && a.mtime}|${a && a.size}|${b && b.mtime}|${b && b.size}`;
  if (!force && key === idCache.key) return idCache.map;
  const db = await io.readBytes(sdkLoc.db);
  const map = db ? sqlite.sdkChatIds(db, b ? await io.readBytes(sdkLoc.db + "-wal") : null) : new Map();
  idCache = { key, map };
  return map;
}
function sdkVsCodeId(s, ids) {
  if (ids.has(s.id)) return ids.get(s.id);
  const m = /[\\/]\.copilot[\\/]chats[\\/]([^\\/]+)$/.exec(s.cwd || "");
  return m ? m[1] : null;
}
/** The URI VS Code opens this chat by, or null when it can't be told (SDK chat not in agent-host.db). */
async function chatUri(s) {
  if (AGENT_HARNESSES[s.kind]) return vscode.Uri.from({ scheme: `agent-host-${s.kind}`, path: "/" + s.vscId });
  if (s.kind !== "sdk") return vscode.Uri.from({ scheme: "vscode-chat-session", authority: "local", path: "/" + Buffer.from(s.id).toString("base64") });
  let id = sdkVsCodeId(s, await sdkIds());
  if (!id) id = sdkVsCodeId(s, await sdkIds(true));
  return id ? vscode.Uri.from({ scheme: "agent-host-copilotcli", path: "/" + id }) : null;
}
function tabKey(t, gi) { return `${gi}|${t.label}|${t.input && t.input.constructor ? t.input.constructor.name : ""}`; }
function allTabKeys() {
  const keys = new Set();
  vscode.window.tabGroups.all.forEach((g, gi) => g.tabs.forEach(t => keys.add(tabKey(t, gi))));
  return keys;
}

// One UI action at a time (open a chat, send, move it back): they all move focus, and two
// interleaved would send into whichever chat happens to be focused.
let sending = false;
let uiQueue = Promise.resolve();
function withUi(fn) {
  const run = uiQueue.then(async () => { sending = true; try { return await fn(); } finally { sending = false; } });
  uiQueue = run.catch(() => {});
  return run;
}

async function trySend(context, s, text, label, opts = {}) {
  if (sending) { logx(`${label} for ${s.id.slice(0, 8)} waits: another chat is being handled`); return false; }
  return withUi(() => sendNow(context, s, text, label, opts));
}

// Never let a message land on an expired cache: it would re-send the whole context. Last check
// just before submitting: the chat must be idle, on the same cache window, with this much left.
const MIN_LEFT_S = 1.5;

/** Is it still safe to send into this chat now? Returns why not, or "". */
async function unsafeToSend(s, opts) {
  const fresh = (await reread(s)) || s;
  if (fresh.busy) return "agent working (it would be queued and could run after the cache expired)";
  if (fresh.cacheFrom !== s.cacheFrom) return "a newer call refreshed the cache";
  if (!opts.allowCold && live(s) < MIN_LEFT_S) return `only ${live(s).toFixed(1)} s left, too late to be sure it lands warm`;
  return "";
}

async function sendNow(context, s, text, label, opts = {}) {
  // timed from the decision, so the measured offset includes opening the tab, submitting and the
  // network: the countdown then shifts earlier by the whole delay
  const decidedAt = Date.now();
  const st = stateFor(s.id);
  const why = await unsafeToSend(s, opts);
  if (why) { logx(`${label} for ${s.id.slice(0, 8)} not sent: ${why}`); return false; }
  const uri = await chatUri(s);
  if (!uri) {
    logx(`${label} for ${s.id.slice(0, 8)} not sent: VS Code's name for this Copilot SDK chat is not in agent-host.db yet`);
    return false;
  }
  try {
    const before = allTabKeys();
    await vscode.commands.executeCommand("workbench.action.chat.openSessionInEditorGroup", { resource: uri });
    await sleep(600);
    const g = vscode.window.tabGroups.activeTabGroup, tab = g.activeTab;
    const gi = vscode.window.tabGroups.all.indexOf(g);
    const opened = tab && !before.has(tabKey(tab, gi)) ? tab : null;   // ours to close later
    // "Open as Editor" moves a chat out of the Chat view if it was shown there. The chat you were
    // working in (your most recent message in this window) is normally that one: put it back
    // there afterwards instead of just closing the tab.
    const latestReal = Math.max(0, ...all.map(x => x.lastRealUserTs || 0));
    const restore = !!opened && s.lastRealUserTs === latestReal;
    // remember each chat's last message time (remote clock) to recognise ours when it lands
    const lastMsgs = new Map(all.map(x => [x.id, x.lastUserTs || 0]));
    // a /compact may not be logged as a message, only as the compaction it runs
    const lastCompactions = new Map(all.map(x => [x.id, x.compactedAt || 0]));
    // opening the tab took time: check again right before submitting
    const late = await unsafeToSend(s, opts);
    if (late) {
      logx(`${label} for ${s.id.slice(0, 8)} not sent: ${late}`);
      if (opened) await finishTab({ tab: opened, restore, sessionId: s.id, uri });
      return false;
    }
    st.pending = { sentAt: decidedAt, label, expectId: s.id, tab: opened, restore, sessionId: s.id, uri, before: lastMsgs,
                   beforeCompaction: lastCompactions,
                   miss: s.cost ? s.cost.missExtra : null };
    // No mode or model change: either would invalidate the cache we are trying to keep.
    st.pending.draft = await submitKeepingDraft(text);
    logx(`${label} sent to ${s.id.slice(0, 8)} (${describe(s)})${opened ? ", in a tab opened for it" : ""}` +
      (label === "keep-alive" ? `: "${text}"` : ""));
    return true;
  } catch (e) {
    logx(`${label} for ${s.id.slice(0, 8)} failed: ${e.message}`);
    st.pending = null;
    return false;
  }
}

// ---------------------------------------------------------------- what you typed or attached, not sent yet
// A plain submit sends whatever is in the chat's input box, attachments and the implicit context (the
// active file) included, then empties it: your unsent text and attachments would go out with our
// keep-alive, and be gone. So our message is sent with VS Code's preserveInput option (what VS Code
// itself uses to send /compact): only our text is sent, no attachments, no implicit context, and the
// input box is left as it was. Fallback, should a VS Code version ignore the option: a chat's input
// box is a document extensions can read and edit (chatSessionInput:input-N, one per chat widget), and
// VS Code moves the draft along when the chat moves between a tab and the Chat view. So: note the
// text of every input box, submit, and if our submit emptied the target chat's box, the text is
// written back once the reply is in, before the tab is closed or moved back. (Tested in VS Code 1.142.)

function chatInputs() { return vscode.workspace.textDocuments.filter(d => d.uri.scheme === "chatSessionInput"); }

/** Submit `text` into the focused chat; returns { doc, text } of the draft it wiped, or null. */
async function submitKeepingDraft(text) {
  const before = new Map(chatInputs().map(d => [d.uri.toString(), d.getText()]));
  const hit = new Set();
  const sub = vscode.workspace.onDidChangeTextDocument(e => {
    if (e.document.uri.scheme === "chatSessionInput" && before.get(e.document.uri.toString())) hit.add(e.document);
  });
  try {
    await vscode.commands.executeCommand("workbench.action.chat.submit",
      { inputValue: text, acceptInputOptions: { preserveInput: true, storeToHistory: false } });
    await sleep(300);
  } finally { sub.dispose(); }
  const doc = [...hit].find(d => d.getText() !== before.get(d.uri.toString()));
  const draft = doc && before.get(doc.uri.toString());
  if (!draft || draft === text) return null;
  logx(`kept your unsent text in that chat (${draft.length} characters) to put it back after the reply`);
  return { doc, text: draft };
}

/** Put the draft back, unless you have typed something there in the meantime. */
async function restoreDraft(p) {
  const d = p.draft;
  if (!d) return;
  p.draft = null;
  try {
    if (d.doc.isClosed || d.doc.getText().trim()) { logx("unsent text not put back: that input box is gone or not empty"); return; }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(d.doc.uri, new vscode.Range(0, 0, d.doc.lineCount, 0), d.text);
    if (await vscode.workspace.applyEdit(edit)) { logx("your unsent text is back in that chat's input box"); await sleep(300); }
  } catch (e) { logx("unsent text: " + e.message); }
}

/**
 * After the reply, depending on cacheKeeper.afterSend:
 *  "restoreLastTyped" (default): the chat where you last typed goes back into the Chat view
 *    (it was probably taken out of it); other chats' tabs are closed.
 *  "closeTab": just close the tab (the Chat view may be left on the sessions list).
 *  "keepTab": leave the tab open.
 */
async function finishTab(p) {
  const policy = cfg("afterSend") || "restoreLastTyped";
  if (policy === "keepTab") return;
  try {
    if (p.restore && policy === "restoreLastTyped") {
      // focus its tab again, then "Move Chat into Side Bar" (back into the Chat view)
      await vscode.commands.executeCommand("workbench.action.chat.openSessionInEditorGroup", { resource: p.uri });
      await sleep(400);
      await vscode.commands.executeCommand("workbench.action.chat.openInSidebar");
      await sleep(400);
      // a tab left behind with the chat's title: closed only if it is the only one (two chats can
      // share a title, and closing the other one would be wrong)
      const same = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.label === p.tab.label);
      if (same.length === 1) await vscode.window.tabGroups.close(same[0], true);
      else if (same.length > 1) logx(`tab cleanup: ${same.length} tabs named "${p.tab.label}", none closed`);
      logx(`moved ${p.sessionId.slice(0, 8)} back into the Chat view`);
    } else {
      await vscode.window.tabGroups.close(p.tab, true);
    }
  } catch (e) { logx(`tab cleanup: ${e.message}`); }
}

/** Check in the logs that our message landed in the intended chat; close the tab we opened. */
async function verifyPending() {
  for (const st of sessions.values()) {
    if (!st.pending) continue;
    const p = st.pending;
    // read the target chat's log directly (every second), not the 5 s snapshot: faster cleanup
    const target = all.find(x => x.id === p.expectId);
    const freshTarget = target && await reread(target);
    const pool = freshTarget ? [freshTarget, ...all.filter(x => x.id !== p.expectId)] : all;
    if (freshTarget) all = all.map(x => x.id === freshTarget.id ? freshTarget : x);   // don't wait for the next full read
    // landed = a new Cache Keeper message in some chat since we sent (no clock comparison needed)
    let landed = pool.find(x => x.lastUserTs > (p.before.get(x.id) || 0) && core.isOwnMessage(x.lastUserText));
    let landedAt = landed && landed.lastUserTs;
    if (!landed && p.label === "compaction" && p.beforeCompaction) {
      // only the target chat: another chat may compact on its own meanwhile
      landed = pool.find(x => x.id === p.expectId && (x.compactedAt || 0) > (p.beforeCompaction.get(x.id) || 0));
      landedAt = landed && landed.compactedAt;
    }
    if (landed && !p.landed) {
      p.landed = landed.id;
      if (p.label !== "compaction" || landedAt === landed.lastUserTs) noteOffset(landedAt - p.sentAt);
      if (landed.id !== p.expectId) {
        st.mode = "done";
        vscode.window.showErrorMessage(`Cache Keeper: the ${p.label} went to another chat than intended. ` +
          "Stopped acting on the original chat.");
      }
    }
    // Not in the log a few seconds after submitting: Copilot queued it behind work that started in
    // the meantime. It cannot be taken back from here, and it may run on an expired cache.
    if (!p.landed && !p.queuedWarned && Date.now() - p.sentAt > QUEUED_AFTER_MS) {
      p.queuedWarned = true;
      logx(`${p.label} for ${p.expectId.slice(0, 8)} not started after ${QUEUED_AFTER_MS / 1000} s: probably queued`);
      vscode.window.showWarningMessage(`Cache Keeper: the ${p.label} did not start; the chat is probably busy and ` +
        "it is queued. If it runs after the cache expires it re-sends the whole context" +
        (p.miss ? ` (~${core.fmt(p.miss)} cr extra)` : "") + ". Remove it from the chat's queue if you don't want that.");
    }
    const done = p.landed && !(pool.find(x => x.id === p.landed) || {}).busy;
    // a summary is done when the agent is, and then its file must be there
    if (done && p.label === "summary request" && !p.fileChecked) { p.fileChecked = true; checkHandoffWritten(st); }
    // Not landed after 90 s: give up. Landed: wait for the reply, however long (a handoff summary on
    // a large context can take minutes), so its tab is not closed or moved while the agent writes;
    // the busy cap still ends a turn that never logs its end.
    const age = Date.now() - p.sentAt;
    if (done || (!p.landed && age > NOT_LANDED_MS) || age > REPLY_MAX_MS) {
      if (!p.landed && !p.queuedWarned) vscode.window.showWarningMessage(`Cache Keeper: could not confirm the ${p.label} was sent.`);
      if (p.tab || p.draft) withUi(async () => { await restoreDraft(p); if (p.tab) await finishTab(p); });
      st.pending = null;
    }
  }
}

/** Handoff file in the workspace (a remote URI in a remote window). */
function handoffUri(s) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) return null;
  const d = new Date(), pad = n => String(n).padStart(2, "0");   // local time, as you read it
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return vscode.Uri.joinPath(folder.uri, ".copilot-handoff", `${stamp}-${s.id.slice(0, 8)}.md`);
}

async function exists(uri) {
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

/**
 * Is this chat's handoff file there? In a multi-root workspace the agent may have written it in
 * another folder's .copilot-handoff/ than the first one: look in every workspace folder, and
 * remember where it was found.
 */
async function findHandoff(st) {
  if (!st.handoff) return false;
  if (await exists(st.handoff)) return true;
  const name = path.posix.basename(st.handoff.path);
  for (const f of vscode.workspace.workspaceFolders || []) {
    const u = vscode.Uri.joinPath(f.uri, ".copilot-handoff", name);
    if (await exists(u)) { st.handoff = u; return true; }
  }
  return false;
}

/**
 * The git folder whose info/exclude applies to a workspace folder: .git itself, or for a worktree or
 * submodule (.git is a file, "gitdir: <path>") the folder it points to, and from a worktree's own
 * folder its main repository's (commondir). Null if not a git repository.
 */
async function gitDirOf(folderUri) {
  const dotGit = vscode.Uri.joinPath(folderUri, ".git");
  if (!(await exists(dotGit))) return null;
  const read = async u => { try { return Buffer.from(await vscode.workspace.fs.readFile(u)).toString("utf8").trim(); } catch { return null; } };
  const text = await read(dotGit);           // a folder can't be read as a file
  if (text === null) return dotGit;
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return null;
  const resolve = (base, p) => p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p)
    ? folderUri.with({ path: (/^[a-zA-Z]:/.test(p) ? "/" : "") + p.replace(/\\/g, "/") })
    : vscode.Uri.joinPath(base, p);
  const gitDir = resolve(folderUri, m[1]);
  const common = await read(vscode.Uri.joinPath(gitDir, "commondir"));
  return common ? resolve(gitDir, common) : gitDir;
}

/**
 * After a summary request's reply: is the handoff file there? The agent may have written it under
 * another folder: look for its name in the workspace and use it from there. Not found: say so, since
 * the chat then has no summary to continue from.
 */
async function checkHandoffWritten(st) {
  if (!st.handoff) return;
  if (await findHandoff(st)) { cleanupHandoffs(); return; }
  const name = path.posix.basename(st.handoff.path);
  try {
    const found = vscode.workspace.findFiles ? await vscode.workspace.findFiles(`**/${name}`, null, 1) : [];
    if (found && found.length) {
      st.handoff = found[0];
      logx(`handoff summary ${name} found at ${found[0].path}, not where it was asked for`);
      return;
    }
  } catch { /* search not available */ }
  logx(`handoff summary ${name} not written: the agent finished without creating it`);
  vscode.window.showWarningMessage(`Cache Keeper: the agent finished but did not write ${name}. ` +
    "Check the chat, or choose Summarize again from the status bar.");
}

/** cacheKeeper.handoffMaxAgeDays (default 7; 0 = never delete) and cacheKeeper.handoffKeep (default 5). */
function handoffLimits() {
  const days = Number(cfg("handoffMaxAgeDays")), keep = Number(cfg("handoffKeep"));
  return { days: Number.isFinite(days) && days >= 0 ? days : 7, keep: Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : 5 };
}
const HANDOFF_NAME = /^\d{8}-\d{4}-[^/\\]+\.md$/;   // <date>-<time>-<chat>.md: only files Cache Keeper names

/**
 * Old handoff summaries: in each workspace folder's .copilot-handoff/, the newest `keep` always
 * stay; of the others, those older than `days` days are deleted (to the trash where possible).
 * Only files named the way Cache Keeper names them.
 */
async function cleanupHandoffs() {
  const { days, keep } = handoffLimits();
  if (!days) return;
  const cutoff = Date.now() - days * 86400000;
  for (const f of vscode.workspace.workspaceFolders || []) {
    const dir = vscode.Uri.joinPath(f.uri, ".copilot-handoff");
    let names = [];
    try { names = (await vscode.workspace.fs.readDirectory(dir)).map(([n]) => n).filter(n => HANDOFF_NAME.test(n)); } catch { continue; }
    const files = [];
    for (const n of names) {
      const uri = vscode.Uri.joinPath(dir, n);
      try { files.push({ n, uri, mtime: (await vscode.workspace.fs.stat(uri)).mtime }); } catch { /* gone */ }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (const x of files.slice(keep).filter(x => x.mtime < cutoff)) {
      try {
        try { await vscode.workspace.fs.delete(x.uri, { useTrash: true }); }
        catch { await vscode.workspace.fs.delete(x.uri, { useTrash: false }); }
        logx(`deleted old handoff summary ${x.n} (older than ${days} days, beyond the newest ${keep})`);
      } catch (e) { logx(`handoff cleanup: ${x.n}: ${e.message}`); }
    }
  }
}

/** Keep handoff files out of git without touching the repos' .gitignore, in every workspace folder. */
async function excludeFromGit() {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const gitDir = await gitDirOf(folder.uri);
    if (gitDir) await excludeIn(gitDir);
  }
}
async function excludeIn(gitDir) {
  const exclude = vscode.Uri.joinPath(gitDir, "info", "exclude");
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(gitDir, "info"));
    let text = "";
    try { text = Buffer.from(await vscode.workspace.fs.readFile(exclude)).toString("utf8"); } catch { /* new file */ }
    if (!text.includes(".copilot-handoff/")) {
      await vscode.workspace.fs.writeFile(exclude, Buffer.from(text + "\n.copilot-handoff/\n"));
    }
  } catch { /* not writable */ }
}

async function summary(context, s, why, opts = {}) {
  const st = stateFor(s.id);
  if (await findHandoff(st) && st.handoffCovers === s.lastRealUserTs) {
    st.mode = "done";            // a handoff written since your last message still covers this chat
    vscode.window.showInformationMessage(`Cache Keeper: ${path.posix.basename(st.handoff.path)} is still up to date; no new summary.`);
    return true;
  }
  const file = handoffUri(s);
  if (!file) return false;
  await excludeFromGit();
  const rel = path.posix.relative(vscode.workspace.workspaceFolders[0].uri.path, file.path);
  // the full path, so the agent writes it where Cache Keeper looks, also in a multi-root workspace
  // (a relative path made it pick whichever repository it was working in)
  const full = file.scheme === "file" ? file.fsPath : file.path;
  const prompt = core.summaryPrompt(s.lang, { rel: full, turns: s.stats.turns, compactions: s.stats.compactions,
    files: s.stats.files, ctxK: Math.round(s.ctx / 1000), words: s.summaryWords });
  if (!(await trySend(context, s, prompt, "summary request", opts))) return false;
  st.mode = "done";
  st.handoff = file;
  st.handoffLang = s.lang;
  st.handoffKind = s.kind;
  st.handoffCovers = s.lastRealUserTs;
  vscode.window.showInformationMessage(`Cache Keeper: writing the handoff summary of ${chatName(s)} (${why}) to ${rel}.`);
  return true;
}

async function keepAlive(context, s, opts = {}) {
  const cold = live(s) <= 0;     // only possible from the command: the whole context is re-sent
  const st = stateFor(s.id);
  const text = core.keepAliveText(st.lastKeepAlive, Math.random, s.lang);
  const ok = await trySend(context, s, text, "keep-alive", opts);
  if (ok) st.lastKeepAlive = text;
  if (ok) st.spent += s.cost ? s.cost.heartbeat + (cold ? s.cost.missExtra : 0) : 0;
  return ok;
}

/** "Keep warm now" from the command palette: on an expired cache, say what it costs first. */
async function keepWarmNow(context, s) {
  if (!s.busy && live(s) <= 0) {
    const price = s.cost ? ` It re-sends the whole context: ~${core.fmt(s.cost.heartbeat + s.cost.missExtra)} cr ` +
      `instead of ~${core.fmt(s.cost.heartbeat)} cr for a warm one.` : " It re-sends the whole context at full price.";
    const go = await vscode.window.showWarningMessage(`Cache Keeper: the cache has already expired (${describe(s)}).` +
      price + " The cache is then warm again.", { modal: true }, "Send anyway");
    if (go !== "Send anyway") return;
  }
  if (await keepAlive(context, s, { allowCold: true })) {   // you chose to send it, cold or warm
    vscode.window.showInformationMessage(`Cache Keeper: keep-alive sent to ${chatName(s)}.`);
  }
}

/**
 * Summarize now, when you ask for it (status-bar list, warning, command). On an expired cache, say
 * what it costs first: the request re-sends the whole context, like Keep warm now. Declined: back to
 * the default, rather than a summary left waiting for a warm cache that won't come.
 */
async function summaryNow(context, s) {
  const st = stateFor(s.id);
  if (!s.busy && live(s) <= 0) {
    const price = s.cost ? ` The summary request re-sends the whole context: ~${core.fmt(s.cost.missExtra + s.cost.summary)} cr ` +
      `instead of ~${core.fmt(s.cost.summary)} cr while the cache is warm.` : " The summary request re-sends the whole context at full price.";
    const go = await vscode.window.showWarningMessage(`Cache Keeper: the cache has already expired (${describe(s)}).` + price,
      { modal: true }, "Write anyway");
    if (go !== "Write anyway") { setMode(st, s, "ask"); return false; }
    return summary(context, s, "on request", { allowCold: true });
  }
  return summary(context, s, "on request");
}

// ---------------------------------------------------------------- compaction
// Compact: the harness's own /compact command, with what to keep in the chat's language. It
// summarizes the older turns in place and keeps the recent ones, so you just go on in the same chat,
// and your next message re-sends only the compacted chat. It changes the chat and can't be undone,
// which is why a summary file stays the default for what happens with no click
// (cacheKeeper.autoAction).

/** The harnesses whose /compact Cache Keeper uses: Local (VS Code's documented command) unless set. */
function compactKinds() {
  const v = cfg("compactHarnesses");
  return Array.isArray(v) ? v : ["local"];
}
function canCompact(s) { return compactKinds().includes(s.kind); }

/**
 * What happens with no click, for a large chat: "summary" (default), "compact" or "off". An older
 * cacheKeeper.autoSummary false, set before autoAction existed, still means off.
 */
function autoAction() {
  const c = vscode.workspace.getConfiguration("cacheKeeper");
  const i = c.inspect ? c.inspect("autoAction") || {} : { globalValue: c.get("autoAction") };
  const set = [i.workspaceFolderValue, i.workspaceValue, i.globalValue].find(v => v !== undefined);
  if (set === undefined && c.get("autoSummary") === false) return "off";
  const v = set !== undefined ? set : c.get("autoAction");
  return ["summary", "compact", "off"].includes(v) ? v : "summary";
}

/** The automatic action for this chat: compact when chosen and its harness supports it, else a summary. */
function autoKind(s) { return autoAction() === "compact" && canCompact(s) ? "compact" : "summary"; }
function autoCost(s) { return !s.cost ? 0 : autoKind(s) === "compact" ? s.cost.compact : s.cost.summary; }
function autoPays(s) { return autoKind(s) === "compact" ? core.compactPays(s) : core.summaryPays(s); }
/** "a handoff summary (~2.1 cr)" or "a compaction (~1.4 cr)", for what happens with no click. */
function autoText(s) {
  return `${autoKind(s) === "compact" ? "a compaction" : "a handoff summary"}` + (s.cost ? ` (~${core.fmt(autoCost(s))} cr)` : "");
}
/** Run the automatic action (summary or compaction) for this chat. */
function autoRun(context, s, why) { return autoKind(s) === "compact" ? compact(context, s, why) : summary(context, s, why); }

async function compact(context, s, why, opts = {}) {
  const st = stateFor(s.id);
  if (!canCompact(s)) {
    logx(`compaction for ${s.id.slice(0, 8)} not sent: not used for ${KIND_LABEL[s.kind] || s.kind} chats (cacheKeeper.compactHarnesses)`);
    return false;
  }
  if (s.compactedIdle) {         // already compacted since the last call: nothing left to gain
    st.mode = "done";
    vscode.window.showInformationMessage(`Cache Keeper: ${chatName(s)} is already compacted; nothing to do.`);
    return true;
  }
  if (!(await trySend(context, s, core.compactPrompt(s.lang), "compaction", opts))) return false;
  st.mode = "done";
  vscode.window.showInformationMessage(`Cache Keeper: compacting ${chatName(s)} (${why}). You can go on in the same chat` +
    (s.cost ? `; your next message there re-sends about ${Math.round(s.cost.compacted / 1000)}k tokens instead of ${Math.round(s.ctx / 1000)}k.` : "."));
  return true;
}

/** Compact now, when you ask for it. On an expired cache, say what it costs first, like Summarize. */
async function compactNow(context, s) {
  const st = stateFor(s.id);
  if (!canCompact(s)) {
    vscode.window.showInformationMessage(`Cache Keeper: Compact is not used for ${KIND_LABEL[s.kind] || s.kind} chats yet ` +
      "(not tested there). Use Summarize instead.");
    return false;
  }
  if (!s.busy && live(s) <= 0) {
    const price = s.cost ? ` The compaction re-sends the whole context: ~${core.fmt(s.cost.missExtra + s.cost.compact)} cr ` +
      `instead of ~${core.fmt(s.cost.compact)} cr while the cache is warm.` : " The compaction re-sends the whole context at full price.";
    const go = await vscode.window.showWarningMessage(`Cache Keeper: the cache has already expired (${describe(s)}).` + price,
      { modal: true }, "Compact anyway");
    if (go !== "Compact anyway") { setMode(st, s, "ask"); return false; }
    return compact(context, s, "on request", { allowCold: true });
  }
  return compact(context, s, "on request");
}

// ---------------------------------------------------------------- choices

// No click = nothing kept warm: the cache expires (after a handoff summary if the summary rule
// applies), and warnings for that chat stop until you write in it again. Keeping warm, once or
// auto, always takes a click: it is never on by default.
const CHOICES = {
  "Keep warm": "once", "Auto keep warm": "auto", "Summarize": "summarize", "Compact": "compact", "Ignore": "ignore",
};
const KEEP_WARM_MODES = ["once", "auto"];
/** The choice a button or menu label stands for, without the cost it shows ("Keep warm (~1.1 cr)"). */
function choiceOf(label) { return String(label || "").replace(/\s*\(.*\)$/, ""); }
const DEFAULT_CHOICE = "Back to default";
const KEEP_WARM_NOW = "Keep warm now";
const NEW_FROM_HANDOFF = "New chat from handoff";

async function choose(context, s, pick) {
  const st = stateFor(s.id);
  if (!pick) return;
  pick = choiceOf(pick);
  // answered here (status-bar list) counts as answering this window's warning too
  if (st.offer && st.offer.for === s.cacheFrom) st.offer.answered = true;
  // Summarize on an expired cache: ask about the cost first, then write it. Otherwise it goes out on
  // the next decision tick (within a second), or once the agent is done (decide()).
  if (CHOICES[pick] === "summarize" && !s.busy && live(s) <= 0) { setMode(st, s, "ask"); await summaryNow(context, s); return; }
  if (CHOICES[pick] === "compact" && (!canCompact(s) || (!s.busy && live(s) <= 0))) { setMode(st, s, "ask"); await compactNow(context, s); return; }
  // Keeping warm is for a warm cache: on an expired one, Keep warm is a cold keep-alive now (asks,
  // with the cost), never one armed for the window after your next message.
  if (KEEP_WARM_MODES.includes(CHOICES[pick]) && !s.busy && live(s) <= 0) {
    setMode(st, s, "ask");
    if (CHOICES[pick] === "once") await keepWarmNow(context, s);
    else vscode.window.showInformationMessage("Cache Keeper: the cache has already expired, so there is nothing to keep warm. " +
      "Write in the chat (or use Keep warm now) and choose Auto keep warm while it is warm.");
    return;
  }
  // Auto keep warm needs a price for its spending cap
  if (CHOICES[pick] === "auto" && !s.cost) {
    vscode.window.showInformationMessage("Cache Keeper: no price for this model in Copilot's price sheet, so Auto keep warm " +
      "can't set its spending cap. Use Keep warm instead.");
    return;
  }
  setMode(st, s, CHOICES[pick] || "ask");      // DEFAULT_CHOICE -> "ask"
  if (st.mode === "once" || st.mode === "auto") {
    const extra = Math.round(core.keepAliveJitter(s.ttl, jitterPercent(), () => 1));
    vscode.window.showInformationMessage(`Cache Keeper: will send a keep-alive ` +
      (extra > 0 ? `${lead()} to ${lead() + extra}s (random)` : `${lead()}s`) + ` before the cache expires` +
      (st.mode === "auto" ? `, each time, ${capText(st, s)}.`
       : closing(s) ? `, then ${autoKind(s) === "compact" ? "a compaction" : "a handoff summary"} before the next expiry.` : "."));
  }
}

function capText(st, s) {
  const time = ` and for at most ${fmtDuration(maxWarmMs())} of keep-warm time`;
  return st.cap === null ? "while the price is known"
    : `until about ${core.fmt(st.cap)} cr is spent (${capPercent()}% of what an expiry would add when it started` +
      (closing(s) ? `, the closing ${autoKind(s) === "compact" ? "compaction" : "handoff summary"} included)` : ")") + time;
}

/**
 * When keeping warm ends (after Keep warm once, or at auto's cap), write a handoff summary, or
 * compact with cacheKeeper.autoAction "compact": when cacheKeeper.summaryAfterKeepWarm is on and it
 * pays off for this chat.
 */
function closing(s) { return cfg("summaryAfterKeepWarm") !== false && autoPays(s); }
/** What the closing action costs: the summary, or the compaction. */
function closingCost(s) { return autoCost(s); }

/** The closing summary of an earlier Keep warm once is due before this expiry (no message from you since). */
function summaryDue(st, s) {
  return closing(s) && st.summaryDueFor !== undefined && st.summaryDueFor === s.lastRealUserTs;
}

/** What happens to a chat in the default mode if nobody clicks, in a few words. */
function noClickText(st, s) {
  const c = s.cost;
  if (!c) return "it expires (no price for this model, so nothing automatic)";
  const on = autoAction() !== "off";
  if (summaryDue(st, s)) return `${autoText(s)} ends keeping warm, then it expires`;
  if (aboveThreshold(s) && on && seenLive(s) && autoPays(s)) return `${autoText(s)}, then it expires`;
  if (!seenLive(s)) return "it expires (idle since before VS Code started: nothing automatic)";
  if (s.compactedIdle) return "it expires (already compacted: your next message re-sends little)";
  if (aboveThreshold(s) && on) return `it expires (a ${autoKind(s) === "compact" ? "compaction" : "summary"} would not pay off here)`;
  return "it expires (below your summary threshold)";
}

/** A chat's name for messages: its title, quoted and short. */
function chatName(s) {
  const t = s.title || s.id.slice(0, 8);
  return `"${t.length > 30 ? t.slice(0, 29) + "…" : t}"`;
}

/** Button labels with what each costs, when the price is known. */
function costButtons(s, withAuto = true) {
  const c = s.cost;
  const compactBtn = canCompact(s) && !s.compactedIdle ? [c ? `Compact (~${core.fmt(c.compact)} cr)` : "Compact"] : [];
  if (!c) return ["Keep warm", "Summarize", ...compactBtn, "Ignore"];
  return [`Keep warm (~${core.fmt(c.heartbeat)} cr)`, ...(withAuto ? ["Auto keep warm"] : []),
          `Summarize (~${core.fmt(c.summary)} cr)`, ...compactBtn, "Ignore"];
}

async function offer(context, s) {
  const st = stateFor(s.id);
  // One warning per cache window. An older one still open counts as not answered (VS Code cannot
  // take a notification back), so it never blocks the warning for a later window.
  const o = st.offer = { for: s.cacheFrom, answered: false, timedOut: false };
  const c = s.cost;
  // Short: a toast cuts long text. The costs are on the buttons; the details are in the status-bar list.
  const msg = `Cache for ${chatName(s)} expires in ${Math.max(0, Math.round(live(s)))}s.` +
    (c ? ` Expiry adds ~${core.fmt(c.missExtra)} cr to your next message.` : " No price for this model.") +
    ` No click: ${noClickText(st, s)}.`;
  const pick = choiceOf(await vscode.window.showWarningMessage(msg, ...costButtons(s))) || undefined;
  o.answered = true;
  // Closed (X): a deliberate "not now", so the same as Ignore: nothing automatic, nothing spent,
  // no more warnings until you write in the chat again. (A warning that just slides into the
  // notification center is not closed: it stays unanswered, see decide().)
  if (!pick) { goQuiet(st, s, "warning closed"); setMode(st, s, "ignore"); return; }
  st.quietFor = undefined;
  // Clicked late, from the notification center: the warning's cache window may be over. A keep-warm
  // click then must not arm a later window you never chose it for.
  const cur = all.find(x => x.id === s.id) || s;
  if (KEEP_WARM_MODES.includes(CHOICES[pick]) && (cur.cacheFrom !== o.for || (!cur.busy && live(cur) <= 0))) {
    if (cur.cacheFrom === o.for && CHOICES[pick] === "once") { await keepWarmNow(context, cur); return; }   // asks, with the cost
    logx(`late "${pick}" for ${s.id.slice(0, 8)} ignored: that warning's cache window is over`);
    vscode.window.showInformationMessage(`Cache Keeper: that warning was for a cache window that is over ` +
      `(${describe(cur)}), so nothing was armed. Click the status bar to choose for this chat now.`);
    return;
  }
  await choose(context, cur, pick);
}

/**
 * Auto keep warm is about to reach its cap (the next keep-alive would not fit): warn once, so you
 * can choose again. No click: what the cap does anyway (summary, or just stop).
 */
async function offerAtCap(context, s) {
  const st = stateFor(s.id);
  const c = s.cost;
  const fresh = core.autoCap(s, capPercent());
  const timeUp = !warmFits(st, s);
  const msg = `Auto keep warm reached its ${autoLimit(st, s) || `${capPercent()}% cap`} for ${chatName(s)}: ` +
    `kept warm ${fmtDuration(warmMs(st))}, ${core.fmt(st.spent)} of ${st.cap === null ? "?" : core.fmt(st.cap)} cr spent. ` +
    `Expires in ${Math.max(0, Math.round(live(s)))}s; expiry adds ~${core.fmt(c.missExtra)} cr. ` +
    `No click: ${closing(s) ? `${autoText(s)}, then it expires` : "it expires"}.`;
  const [keep, ...rest] = costButtons(s, false);
  const again = `Auto keep warm (new cap ~${core.fmt(fresh)} cr${timeUp ? `, ${fmtDuration(maxWarmMs())}` : ""})`;
  const pick = await vscode.window.showWarningMessage(msg, keep, again, ...rest);
  if (pick) { st.quietFor = undefined; await choose(context, s, pick); }
}

/** How many expired chats the list keeps (cacheKeeper.expiredChats, default 5). */
function expiredShown() {
  const n = Number(cfg("expiredChats"));
  return Number.isFinite(n) && n >= 0 ? Math.min(50, Math.floor(n)) : 5;
}

/**
 * Chats for the list: all warm ones (soonest expiry first), plus the cacheKeeper.expiredChats most
 * recently expired, the chat where you last typed, and any expired one with a handoff summary to
 * start a new chat from. Only chats active within cacheKeeper.lookbackHours are read at all.
 */
function listChats() {
  const list = all.filter(managed);
  const expired = new Set(list.filter(s => !s.busy && live(s) <= 0).sort((x, y) => y.cacheFrom - x.cacheFrom)
    .slice(0, expiredShown()));
  const cur = currentChat();
  const shown = list.filter(s => s.busy || live(s) > 0 || expired.has(s) || s === cur || stateFor(s.id).handoff);
  // a chat whose warning waits for an answer in its last seconds goes first: the status bar points there
  const first = awaitingAnswer() || cur;
  return core.orderChats(shown, first && first.id, live).slice(0, 60);
}

const LAST_CHANCE_S = 30;      // the status bar asks for a choice this many seconds before expiry
/**
 * The chat whose expiry warning is still waiting for an answer in its last seconds, soonest first,
 * or null. The warning may have slid into the notification center unseen: the status bar asks too.
 */
function awaitingAnswer() {
  let best = null;
  for (const s of all.filter(managed)) {
    const st = stateFor(s.id), r = live(s);
    if (s.busy || st.mode !== "ask" || !st.offer || st.offer.for !== s.cacheFrom || st.offer.answered || st.offer.timedOut) continue;
    if (r > 0 && r <= LAST_CHANCE_S && (!best || r < live(best))) best = s;
  }
  return best;
}

/** "3:12", or for a chat whose agent works past the cache lifetime, "possibly expired". */
function clockText(s) {
  const r = live(s);
  return r > 0 ? mmss(r) : s.busy ? "possibly expired" : "expired";
}

function chatItem(s, cur = currentChat()) {
  const r = live(s), st = stateFor(s.id);
  const clock = clockText(s);
  // while the agent works (a long tool run makes no model call), the cache can still run out
  const when = s.busy ? `working · cache ${clock}` : clock;
  return {
    label: `${s.busy ? "$(sync~spin)" : r > 0 ? "$(flame)" : "$(circle-slash)"} ${when}  ${s.title || s.id.slice(0, 8)}`,
    description: `${KIND_LABEL[s.kind] || s.kind} · ${s.model} · ${Math.round(s.ctx / 1000)}k` + (s.cost ? ` · expiry +${core.fmt(s.cost.missExtra)} cr` : ""),
    detail: modeLabel(st.mode) +
      (st.mode === "auto" && st.cap !== null ? ` (${core.fmt(st.spent)} of ${core.fmt(st.cap)} cr)` : "") +
      (st.warmSince ? ` · kept warm ${fmtDuration(warmMs(st))} of ${fmtDuration(maxWarmMs())}` : "") + (s.cost ? ` · keep-alive ~${core.fmt(s.cost.heartbeat)} cr · spent ${core.fmt(s.credits)} cr` : "") +
      (st.handoff ? " · handoff summary ready" : "") + (s.compactedIdle ? " · compacted" : "") +
      (cur && cur.id === s.id ? " · where you last typed" : ""),
    s,
  };
}

/** Status bar click: the chats in this window with live countdowns, then what to do with one. */
async function pickChat(context) {
  if (!listChats().length) return vscode.window.showInformationMessage("Cache Keeper: no Copilot agent chat to manage in this window.");
  const qp = vscode.window.createQuickPick();
  qp.placeholder = "Copilot chats in this window: pick one to manage";
  qp.matchOnDescription = true;
  const refresh = () => {
    const active = qp.activeItems[0] && qp.activeItems[0].s.id;
    qp.items = listChats().map(s => chatItem(s));
    const keep = qp.items.find(i => i.s.id === active);
    if (keep) qp.activeItems = [keep];
  };
  refresh();
  const timer = setInterval(refresh, 1000);
  const chat = await new Promise(resolve => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0] || qp.activeItems[0]));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  clearInterval(timer);
  qp.dispose();
  if (!chat) return;
  const st = stateFor(chat.s.id);
  // the expiry notice can slide into the notification center unseen: the same action lives here too
  const handoff = await findHandoff(st) ? [{ label: NEW_FROM_HANDOFF,
    detail: `Open a new chat with ${path.posix.basename(st.handoff.path)} attached` +
      (chat.s.cost ? ` (first message ≈ ${core.fmt(chat.s.cost.restart)} cr)` : "") }] : [];
  const cs = all.find(x => x.id === chat.s.id) || chat.s;   // the latest state: the list may have been open a while
  const pick = await vscode.window.showQuickPick([...handoff, ...choiceItems(st, cs)],
    { placeHolder: `${describe(cs)}: what should happen before its cache expires? (now: ${modeLabel(st.mode)})` });
  if (pick && pick.label === NEW_FROM_HANDOFF) await newChatFromHandoff(st.handoff, st.handoffLang, st.handoffKind || cs.kind);
  else if (pick && pick.label === KEEP_WARM_NOW) { setMode(st, cs, "ask"); await keepWarmNow(context, all.find(x => x.id === cs.id) || cs); }
  else if (pick) await choose(context, all.find(x => x.id === cs.id) || cs, pick.label);
}

/**
 * The per-chat menu: each choice with what it does and costs for this chat right now, the current
 * one marked. An expired chat gets Keep warm now (a cold keep-alive, asks first) instead of the
 * keep-warm choices, which need a warm cache.
 */
function choiceItems(st, s) {
  const c = s.cost, cr = x => `~${core.fmt(x)} cr`;
  const expired = !s.busy && live(s) <= 0;
  const extra = Math.round(core.keepAliveJitter(s.ttl, jitterPercent(), () => 1));
  const when = extra > 0 ? `${lead()}-${lead() + extra} s` : `${lead()} s`;
  const mark = mode => st.mode === mode ? "$(check) current" : undefined;
  const cap = c ? core.autoCap(s, capPercent()) : null;
  const keep = expired
    ? [{ label: KEEP_WARM_NOW, detail: "The cache has expired: one keep-alive now re-sends the whole context" +
        (c ? ` (${cr(c.heartbeat + c.missExtra)}); asks first` : "; asks first") }]
    : [{ label: "Keep warm", description: mark("once"),
         detail: `One keep-alive ${when} before expiry` + (c ? ` (${cr(c.heartbeat)})` : "") +
           (closing(s) ? `, then ${autoText(s)} before the next expiry` : "") },
       ...(c ? [{ label: "Auto keep warm", description: mark("auto"),
         detail: `A keep-alive (${cr(c.heartbeat)}) ${when} before each expiry, up to ${cr(cap)} ` +
           `(${capPercent()}% of the ${cr(c.missExtra)} an expiry adds) or ${fmtDuration(maxWarmMs())} of keep-warm time` +
           (closing(s) ? `, then ${autoKind(s) === "compact" ? "a compaction" : "a handoff summary"}` : "") }] : [])];
  return [
    ...keep,
    { label: "Summarize", description: mark("summarize"),
      detail: expired ? "Write the handoff summary now; the cache expired, so it re-sends the whole context" +
          (c ? ` (${cr(c.summary + c.missExtra)}); asks first` : "; asks first")
        : `Write the handoff summary now` + (c ? ` (${cr(c.summary)})` : "") + (s.busy ? ", once the agent is done" : "") },
    ...(canCompact(s) ? [{ label: "Compact", description: mark("compact"),
      detail: s.compactedIdle ? "Already compacted since the last message"
        : (expired ? "Compact the chat now (/compact); the cache expired, so it re-sends the whole context" +
            (c ? ` (${cr(c.compact + c.missExtra)}); asks first` : "; asks first")
          : `Compact the chat now (/compact)` + (c ? ` (${cr(c.compact)})` : "") + (s.busy ? ", once the agent is done" : "")) +
          (c ? `; your next message then re-sends ~${Math.round(c.compacted / 1000)}k tokens instead of ${Math.round(s.ctx / 1000)}k` : "") +
          ". Changes the chat in place, no undo" }] : []),
    { label: "Ignore", description: mark("ignore"), detail: "Leave this chat alone: no summary, no warnings, until you write in it again" },
    { label: DEFAULT_CHOICE, description: mark("ask"),
      detail: `Warn ${cfg("warnSeconds")} s before expiry; no click: ${noClickText(st, s)}` },
  ];
}

function modeLabel(m) {
  return { ask: "default", once: "keep warm once", auto: "auto keep warm", summarize: "summary waiting", compact: "compaction waiting",
           ignore: "ignored", done: "done" }[m] || m;
}

// ---------------------------------------------------------------- decisions

async function decide(context) {
  await verifyPending();
  for (const s of all) {
    const st = stateFor(s.id);
    if (!managed(s) || s.busy || st.pending) {
      // (a pending message is our own keep-alive still being answered: expected, not worth logging)
      if (!st.pending && (st.mode === "auto" || st.mode === "once") && live(s) > 0 && live(s) <= lead() && st.skipFor !== s.cacheFrom) {
        st.skipFor = s.cacheFrom;
        logx(`keep-alive for ${s.id.slice(0, 8)} skipped: ${!managed(s) ? "not managed" : s.busy ? "agent working" : "previous message still pending"}`);
      }
      continue;
    }
    // A new model call starts a new cache window. After "Ignore" or a summary, only a
    // real message from you (not one of ours) brings the default behaviour back.
    if (st.windowFor !== s.cacheFrom) {
      st.windowFor = s.cacheFrom;
      if (!core.isOwnMessage(s.lastUserText) && ["ignore", "done"].includes(st.mode)) {
        st.mode = "ask"; st.spent = 0;
      }
      // you wrote in the chat: keep-warm time counts again from now
      if (!core.isOwnMessage(s.lastUserText) && st.warmSince) {
        st.warmSince = ["once", "auto"].includes(st.mode) ? Date.now() : null;
      }
    }
    // auto keep warm started before the price was known: its cap is set once there is one
    if (st.mode === "auto" && st.cap === null && s.cost) st.cap = core.autoCap(s, capPercent());
    const r = live(s);
    const actOnce = st.actedFor !== s.cacheFrom;
    // Several chats expiring within seconds of each other: the one expiring first goes earlier
    // (8 s per chat expiring within 10 s after it), so each round trip (open, send, reply, move
    // back) is done before the next chat's turn.
    const crowd = all.filter(x => x.id !== s.id && ["auto", "once"].includes(stateFor(x.id).mode) &&
      live(x) > r && live(x) - r < 10).length;
    const due = lead() + 8 * crowd;
    // keep-alives (once and auto) go out a random bit earlier than that, never later
    const dueAlive = (st.mode === "auto" || st.mode === "once") ? Math.max(due, keepAliveLead(st, s) + 8 * crowd) : due;
    if ((st.mode === "auto" || st.mode === "once") && r > 0 && r <= dueAlive && st.diagFor !== s.cacheFrom) {
      st.diagFor = s.cacheFrom;
      logx(`keep-alive due for ${s.id.slice(0, 8)}: ${Math.round(r)}s left (lead ${lead()}s + ${Math.round(st.jitter || 0)}s random), mode ${st.mode}, ` +
        `seen since start ${seenLive(s)}, within cap ${core.canAffordHeartbeat(s, st.spent, st.cap)}, ` +
        `kept warm ${fmtDuration(warmMs(st))} (within limit ${warmFits(st, s)}), ` +
        `already acted ${!actOnce}, sending lock ${sending}`);
    }
    // This window's warning still unanswered when something automatic is about to happen: that
    // counts as ignored. Warnings go quiet; nothing is kept warm without a click.
    if (st.mode === "ask" && st.offer && st.offer.for === s.cacheFrom && !st.offer.answered && !st.offer.timedOut &&
        r > 0 && r <= Math.max(due, SUMMARY_LEAD)) {
      st.offer.timedOut = true;
      goQuiet(st, s, "warning not answered");
    }
    if (st.mode === "auto" && seenLive(s) && r > 0 && r <= cfg("warnSeconds") && st.capWarnFor !== s.cacheFrom &&
        s.cost && autoLimit(st, s)) {
      st.capWarnFor = s.cacheFrom;
      offerAtCap(context, s);    // not awaited, like the expiry warning
    }
    const autoRule = autoAction() !== "off" && aboveThreshold(s) && seenLive(s) && !s.compactedIdle && autoPays(s);
    const afterOnce = summaryDue(st, s);

    if (st.mode === "summarize" && r <= 0) {
      // asked for while the agent worked, and the cache expired meanwhile: ask about the cost now
      setMode(st, s, "ask");
      summaryNow(context, s);    // not awaited: the question stays while we keep deciding
    } else if (st.mode === "summarize" && r > 0) {
      if (await summary(context, s, "on request")) st.actedFor = s.cacheFrom;
    } else if (st.mode === "compact" && r <= 0) {
      setMode(st, s, "ask");
      compactNow(context, s);    // not awaited, like the summary above
    } else if (st.mode === "compact" && r > 0) {
      if (await compact(context, s, "on request")) st.actedFor = s.cacheFrom;
    } else if (st.mode === "once" && r > 0 && r <= dueAlive && actOnce) {
      if (await keepAlive(context, s)) {
        st.actedFor = s.cacheFrom; st.mode = "ask";
        // the summary follows before the next expiry, unless you write in the chat or keep it warm again
        if (closing(s)) st.summaryDueFor = s.lastRealUserTs;
      }
    } else if (st.mode === "auto" && r > 0 && r <= dueAlive && actOnce && seenLive(s)) {
      const limit = autoLimit(st, s);
      if (!limit) {
        if (await keepAlive(context, s)) st.actedFor = s.cacheFrom;
      } else if (!closing(s)) {
        st.actedFor = s.cacheFrom; st.mode = "done";
        logx(`auto keep warm for ${s.id.slice(0, 8)} reached its ${limit} after ${fmtDuration(warmMs(st))}: stopped, no summary`);
        vscode.window.showInformationMessage(`Cache Keeper: auto keep warm reached its ${limit}; ` +
          `the cache now expires (${describe(s)}).`);
      } else if (await autoRun(context, s, `auto keep warm reached its ${limit}`)) {
        st.actedFor = s.cacheFrom;
      }
    } else if (st.mode === "ask" && r > 0 && r <= SUMMARY_LEAD && actOnce && afterOnce) {
      if (await autoRun(context, s, "end of keep warm once")) {
        st.actedFor = s.cacheFrom; st.summaryDueFor = undefined;
      }
    } else if (st.mode === "ask" && r > 0 && r <= SUMMARY_LEAD && actOnce && autoRule) {
      if (await autoRun(context, s, "no answer before expiry")) {
        st.actedFor = s.cacheFrom;
      }
    }
    if (st.mode === "ask" && r > 0 && r <= cfg("warnSeconds") && st.promptedFor !== s.cacheFrom && !quiet(st, s)) {
      st.promptedFor = s.cacheFrom;
      offer(context, s);         // not awaited: the notification stays while we keep deciding
    }
    if (r <= 0 && r > -120 && st.expiredFor !== s.cacheFrom && st.mode !== "ignore") {
      // confirm with the chat's own log: a keep-alive may have refreshed it since the last full read
      const fresh = await reread(s);
      if (fresh && fresh.cacheFrom !== s.cacheFrom) { all = all.map(x => x.id === fresh.id ? fresh : x); continue; }
      st.expiredFor = s.cacheFrom;
      st.warmSince = null;       // keeping warm ended: keep-warm time starts over next time
      // a keep-warm choice that could not keep it warm (agent working, too late) ends here: it must
      // not send a keep-alive in the window after your next message without a new click
      if (KEEP_WARM_MODES.includes(st.mode)) {
        logx(`${modeLabel(st.mode)} for ${s.id.slice(0, 8)} ended: the cache expired`);
        st.mode = "ask";
      }
      if (st.offer && st.offer.for === s.cacheFrom && !st.offer.answered) goQuiet(st, s, "warning not answered");
      const actions = await findHandoff(st) ? [NEW_FROM_HANDOFF] : [];
      vscode.window.showInformationMessage(
        `Copilot cache expired (${describe(s)}). Your next message there re-sends the context` +
          (s.cost ? `: ~${core.fmt(s.cost.missExtra)} extra credits.` : "."),
        ...actions).then(a => { if (a) newChatFromHandoff(st.handoff, st.handoffLang, st.handoffKind || s.kind); });
    }
  }
  updateStatus(context);
}

// A new chat from a handoff opens in the same harness as the chat it came from (Claude, Codex,
// Copilot SDK), with VS Code's "new session" command for that session type when it has one. VS
// Code's command names for these are not documented API, so they are looked up among the
// registered commands; when none is found, the new chat is a Local one and you are told so.
const SESSION_TYPE = { sdk: "agent-host-copilotcli", claude: "agent-host-claude", codex: "agent-host-codex" };
async function newChatCommand(kind) {
  const type = SESSION_TYPE[kind];
  if (!type) return "workbench.action.chat.newChat";
  let cmds = [];
  try { cmds = vscode.commands.getCommands ? await vscode.commands.getCommands(true) : []; } catch { /* none */ }
  return [`workbench.action.chat.openNewSessionSidebar.${type}`, `workbench.action.chat.openNewSessionEditor.${type}`]
    .find(c => cmds.includes(c)) || cmds.find(c => /new.*session|session.*new/i.test(c) && c.endsWith("." + type)) || null;
}

async function newChatFromHandoff(uri, lang, kind = "local") {
  const cmd = await newChatCommand(kind);
  if (!cmd) {
    logx(`no command to start a new ${KIND_LABEL[kind] || kind} chat: the handoff opens in a Local chat`);
    vscode.window.showInformationMessage(`Cache Keeper: VS Code offers no command to start a new ${KIND_LABEL[kind] || kind} ` +
      "chat here, so the handoff opens in a new Local chat. Switch its agent before sending if you want the same one.");
  }
  await vscode.commands.executeCommand(cmd || "workbench.action.chat.newChat");
  await vscode.commands.executeCommand("workbench.action.chat.open", {
    query: core.handoffStart(lang), isPartialQuery: true, attachFiles: [uri],
  });
}

function mmss(r) { return `${Math.floor(r / 60)}:${String(Math.floor(r % 60)).padStart(2, "0")}`; }

function updateStatus(context) {
  const list = all.filter(managed);
  const s = currentChat();      // the chat where you last typed
  if (!s) { statusItem.hide(); return; }
  const st = stateFor(s.id), r = live(s);
  const shownInList = listChats().length;            // warm chats + the latest expired ones
  const others = shownInList > 1 ? ` +${shownInList - 1}` : "";
  // Auto keep warm spends credits on its own: say so on the status bar, louder than an expiry warning.
  const autoChats = list.filter(x => stateFor(x.id).mode === "auto");
  // Short text: the details are in the tooltip. Auto keep warm spends credits on its own, so it is
  // always on the bar (spent/cap here, a count for other chats) and the bar stays red (below).
  const autoHere = st.mode === "auto" && st.cap !== null ? ` · ${core.fmt(st.spent)}/${core.fmt(st.cap)} cr` : "";
  const autoElsewhere = autoChats.length && st.mode !== "auto" ? ` · $(zap)×${autoChats.length}` : "";
  const red = autoChats.length ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
  if (sending) {
    // a chat is being opened as a tab and sent to: typing in the Chat view now would go elsewhere
    statusItem.text = "$(loading~spin) sending… don't type";
    statusItem.tooltip = "Cache Keeper is sending into a chat it opened: what you type now could land there.";
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    statusItem.show();
    return;
  }
  // A warning still waiting for an answer in its last seconds (maybe unseen in the notification
  // center): the bar asks for a choice, for whichever chat it is.
  const asking = awaitingAnswer();
  if (asking) {
    statusItem.text = `$(bell) ${chatName(asking).slice(1, -1).slice(0, 20)} ${mmss(live(asking))} · click to choose${autoElsewhere}`;
    statusItem.tooltip = new vscode.MarkdownString(`**Cache expires in ${Math.round(live(asking))} s:** ${describe(asking).replace(/[\\`*_[\]<>]/g, "")}.  \n` +
      `No click: ${noClickText(stateFor(asking.id), asking)}. Click to keep it warm, summarize or ignore.`, true);
    statusItem.backgroundColor = red || new vscode.ThemeColor("statusBarItem.warningBackground");
    statusItem.show();
    return;
  }
  // Coming back to an expired chat: make an expensive next message stand out (orange). Measured in
  // context tokens, since a cold send costs about context x the model's input price: the same
  // setting then fits a cheap model and an expensive one.
  const costlyRestart = r <= 0 && !s.busy && s.ctx >= thresholdTokens();
  if (s.busy) statusItem.text = `$(sync~spin) working · ${clockText(s)}${autoElsewhere}${others}`;
  else if (r > 0) {
    statusItem.text = `${st.mode === "auto" ? "$(zap)" : "$(flame)"} ${mmss(r)}` +
      (autoHere || (st.mode === "once" ? " · armed" : "")) + autoElsewhere + others;
  } else statusItem.text = (costlyRestart ? "$(warning)" : "$(circle-slash)") + " expired" +
    (s.cost ? ` · +${core.fmt(s.cost.missExtra)} cr` : "") + autoElsewhere + others;
  // Tooltip: short Markdown lines rather than one long sentence.
  const md = [`**${s.title ? s.title.replace(/[\\`*_[\]<>]/g, "") : s.id.slice(0, 8)}**  `,
              `${s.model} · ${Math.round(s.ctx / 1000)}k context · cache lifetime ${s.ttl} s (${s.ttlFrom})`, ""];
  if (s.busy && r <= 0) md.push("**Agent working past the cache lifetime:** the cache has possibly expired. The countdown " +
    "runs from the last model call's start; a long answer can still leave it cached. The next call's cache hit is logged " +
    "in the Output panel (Cache Keeper).", "");
  if (st.mode === "once" && r > 0) md.push("Keep-alive armed: one is sent just before expiry.", "");
  if (costlyRestart) {
    md.push(`$(warning) **Cache expired.** Your next message here re-sends the whole ${Math.round(s.ctx / 1000)}k-token context` +
      (s.cost ? ` (**+${core.fmt(s.cost.missExtra)} cr**)` : "") + ".", "");
    md.push(st.handoff
      ? `Handoff summary ready: a new chat from it ≈ ${s.cost ? core.fmt(s.cost.restart) + " cr" : "a fraction of that"}. ` +
        "Click here, pick this chat, then *New chat from handoff*."
      : "Consider starting a new chat from a handoff summary instead.", "");
  }
  if (s.cost) {
    md.push("| | |", "|---|--:|",
      `| Keep-alive | ~${core.fmt(s.cost.heartbeat)} cr |`,
      `| Expiry adds | ~${core.fmt(s.cost.missExtra)} cr |`,
      `| Handoff summary | ~${core.fmt(s.cost.summary)} cr |`,
      `| Session so far | ${core.fmt(s.credits)} cr |`, "");
  } else md.push("No price for this model in Copilot's price sheet.", "");
  if (st.warmSince) md.push(`Kept warm ${fmtDuration(warmMs(st))} of ${fmtDuration(maxWarmMs())} (cacheKeeper.autoKeepWarmMaxMinutes).`, "");
  if (autoChats.length) md.push(`$(zap) Auto keep warm is on for ${autoChats.length} chat(s) and spends credits on its own: ` +
    "click to change it, or run *Cache Keeper: Stop keeping warm*.", "");
  if (costlyRestart) md.push(`*Orange: expired with at least ${Math.round(thresholdTokens() / 1000)}k tokens of context.*  `);
  md.push(`Click to manage the ${shownInList} chat(s) in the list.`);
  const tip = new vscode.MarkdownString(md.join("\n"), true);
  statusItem.tooltip = tip;
  statusItem.backgroundColor = red ||
    (costlyRestart || (r > 0 && r <= cfg("warnSeconds") && !s.busy) ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined);
  statusItem.show();
}


/** `fn` (returning a promise) as a timer callback that skips its turn while the previous run is going. */
const runningTicks = new Set();
function noOverlap(name, fn) {
  return () => {
    if (runningTicks.has(name)) return;
    runningTicks.add(name);
    Promise.resolve().then(fn).finally(() => runningTicks.delete(name));
  };
}

let ctxRef;                    // for tests
function activate(context) {
  ctxRef = context;
  out = vscode.window.createOutputChannel("Cache Keeper");
  context.subscriptions.push(out);
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "cacheKeeper.options";
  context.subscriptions.push(statusItem);
  globalState = context.globalState;
  core.setMeasuredTtls(evidenceGaps());     // lifetimes measured in earlier sessions, before the first read
  if (context.globalStorageUri) {
    claimDir = path.join(context.globalStorageUri.fsPath, "sdk-claims");
    Promise.resolve(vscode.workspace.fs.createDirectory(vscode.Uri.file(claimDir))).catch(() => { claimDir = null; });
  }
  // cache lifetimes from Copilot CLI/SDK logs: learned once the logs are located, refreshed every 30 min
  // With several chats, the commands ask which one (the one where you last typed first); with one,
  // they name it in what they report.
  const target = async what => {
    const list = listChats();
    if (list.length <= 1) return currentChat();
    const pick = await vscode.window.showQuickPick(list.map(s => chatItem(s)), { placeHolder: `${what}: which chat?` });
    return pick && (all.find(x => x.id === pick.s.id) || pick.s);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("cacheKeeper.options", () => pickChat(context)),
    vscode.commands.registerCommand("cacheKeeper.diagnose", () => diagnose(context).catch(e => logx("diagnostics: " + e.message))),
    vscode.commands.registerCommand("cacheKeeper.keepWarmNow", async () => { const s = await target("Keep warm now"); if (s) await keepWarmNow(context, s); }),
    vscode.commands.registerCommand("cacheKeeper.summaryNow", async () => { const s = await target("Write handoff summary now"); if (s) await summaryNow(context, s); }),
    vscode.commands.registerCommand("cacheKeeper.compactNow", async () => { const s = await target("Compact now"); if (s) await compactNow(context, s); }),
    // Stop keeping warm: back to the default for every chat (expire, summary rule applies).
    vscode.commands.registerCommand("cacheKeeper.stop", () => {
      let n = 0;
      for (const st of sessions.values()) {
        if (st.mode === "auto" || st.mode === "once" || st.summaryDueFor !== undefined) n++;
        if (st.mode === "auto" || st.mode === "once") st.mode = "ask";
        st.warmSince = null;
        st.summaryDueFor = undefined;   // the summary that follows Keep warm once is part of keeping warm
      }
      vscode.window.showInformationMessage(n ? `Cache Keeper: stopped keeping ${n} chat(s) warm.`
        : "Cache Keeper: no chat was being kept warm.");
    }),
  );
  // A tick that takes longer than its interval (slow remote reads, a send in progress) is not
  // overlapped by the next one: two decide() at once could show the same notice twice or clean up
  // the same tab twice, and an older read finishing late would replace a newer one.
  const timers = [
    setInterval(noOverlap("read", () => readAll(context).then(setAll).catch(e => logx("read error: " + e.message))), READ_MS),
    setInterval(noOverlap("decide", () => decide(context).catch(e => console.error("cache-keeper", e))), DECIDE_MS),
    setInterval(() => { if (logRootPath || sdkLoc) learnLifetimes(); }, 30 * 60 * 1000),
  ];
  readAll(context).then(setAll).catch(e => logx("read error: " + e.message));
  cleanupHandoffs().catch(e => logx("handoff cleanup: " + e.message));
  context.subscriptions.push({ dispose: () => timers.forEach(clearInterval) });
}

function deactivate() {}

// for tests
module.exports = { activate, deactivate, _noOverlap: noOverlap, _read: async (c) => { setAll(await readAll(c || ctxRef)); }, _decide: (c) => decide(c || ctxRef) };
