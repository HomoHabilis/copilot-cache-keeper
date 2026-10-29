// Copilot Cache Keeper: warns before a chat's prompt cache expires and offers to keep it warm
// or to write a handoff summary. Reads Copilot's Agent Debug Logs; never acts on its own below
// the configured threshold, and only ever sends into the chat shown in the Chat view.
"use strict";

const vscode = require("vscode");
const path = require("path");
const core = require("./core");

const HEARTBEAT = `${core.MARKER} Keep-alive while I'm away. Reply with only: OK. Do not use any tools.`;
const READ_MS = 5000;          // re-read the logs
const DECIDE_MS = 1000;        // decide and redraw the countdown
const SUMMARY_LEAD = 15;       // seconds before expiry for an automatic summary
// Automatic actions only for chats seen active since this window started: after a reload the
// Chat view may show another chat, and a brand-new chat leaves no trace in the logs.
const startedAt = Date.now();

let statusItem;
let all = [];                  // sessions from the last log read, newest first
const sessions = new Map();    // id -> per-chat state

function cfg(key) { return vscode.workspace.getConfiguration("cacheKeeper").get(key); }
function lead() {
  // configured lead, plus a margin while the clock offset to the remote machine is still unknown
  return Math.max(2, cfg("keepAliveLeadSeconds") || 5) + (clockOffset === null ? UNMEASURED_MARGIN : 0);
}

function stateFor(id) {
  if (!sessions.has(id)) sessions.set(id, { mode: "ask", spent: 0 });
  return sessions.get(id);
}

// ---------------------------------------------------------------- reading the logs, wherever they are

// The extension runs on the Windows (UI) side, so one install covers every window: local, WSL,
// SSH, dev containers, SSH + container. Copilot's debug logs live where its extension runs (the
// remote side), so they are read through VS Code's own remote file access (workspace.fs).

let remote = null;             // { authority } for a remote window, null for a local one
let logRootPath = null;        // debug-logs folder of this workspace (a path on the remote side)
let remoteHome = null;         // home folder on the remote side (for Copilot CLI cache lifetimes)
const fileCache = new Map();   // path -> { mtime, text }: re-read a log only when it changed

function toUri(p) {
  return remote ? vscode.Uri.from({ scheme: "vscode-remote", authority: remote.authority, path: p }) : vscode.Uri.file(p);
}

const io = {
  join: (...parts) => remote ? path.posix.join(...parts) : path.join(...parts),
  async stat(p) {
    try { const st = await vscode.workspace.fs.stat(toUri(p)); return { mtime: st.mtime }; } catch { return null; }
  },
  async readText(p) {
    const st = await io.stat(p);
    if (!st) return null;
    const hit = fileCache.get(p);
    if (hit && hit.mtime === st.mtime) return hit.text;
    try {
      const text = Buffer.from(await vscode.workspace.fs.readFile(toUri(p))).toString("utf8");
      fileCache.set(p, { mtime: st.mtime, text });
      return text;
    } catch { return null; }
  },
  async list(d) {
    try { return (await vscode.workspace.fs.readDirectory(toUri(d))).map(([name]) => name); } catch { return []; }
  },
};

/**
 * Find this workspace's Copilot debug-logs folder. Local window: next to our own storage.
 * Remote window: in the VS Code server's data folder on the remote side, under the same
 * workspace id as our (local) storage folder.
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
  for (const server of servers) {
    const dir = `${server}/data/User/workspaceStorage/${wsId}/GitHub.copilot-chat/debug-logs`;
    if (await io.stat(dir)) {
      remoteHome = server.startsWith("/vscode/") ? null : server.replace(/\/\.vscode-server(-insiders)?$/, "");
      return dir;
    }
  }
  return null;                 // no Copilot chat in this workspace yet: try again later
}

async function readAll(context) {
  if (!logRootPath) {
    logRootPath = await locateLogs(context);
    if (logRootPath) {
      logx(`reading Copilot logs at ${remote ? remote.authority + ":" : ""}${logRootPath}`);
      core.learnTtls(io, remoteHome || require("os").homedir()).catch(() => {});
    }
  }
  return logRootPath ? core.readSessions(io, logRootPath, Date.now(), 3 * 3600 * 1000, cfg("ttlSeconds") || {}) : [];
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
let baseline = null;           // id -> cacheFrom at our first read
function seenLive(s) {
  if (!baseline) return false;
  return !baseline.has(s.id) || baseline.get(s.id) !== s.cacheFrom;
}
function setAll(r) {
  if (!baseline && logRootPath) baseline = new Map(r.map(x => [x.id, x.cacheFrom]));
  all = r;
}
function aboveThreshold(s) { return !!s.cost && s.cost.missExtra >= cfg("thresholdCredits"); }
function managed(s) {
  return s.lastRealUserTs && !(s.cost && s.cost.missExtra < cfg("minCredits"));
}

// ---------------------------------------------------------------- sending into a given chat

// VS Code has no "send to chat X" command, and what the Chat view shows can't be read reliably.
// So the target chat is opened explicitly as an editor tab ("Open as Editor"), which focuses it,
// and the message is submitted into the focused chat. Same prompt as in the Chat view, so the
// cache is still hit. A tab Cache Keeper opened is closed again once the reply is in.

const sleep = ms => new Promise(r => setTimeout(r, ms));
let out;
function logx(msg) { if (out) out.appendLine(`${new Date().toTimeString().slice(0, 8)} ${msg}`); }

function sessionUri(id) {
  return vscode.Uri.from({ scheme: "vscode-chat-session", authority: "local", path: "/" + Buffer.from(id).toString("base64") });
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

async function trySend(context, s, text, label) {
  if (sending) { logx(`${label} for ${s.id.slice(0, 8)} waits: another chat is being handled`); return false; }
  return withUi(() => sendNow(context, s, text, label));
}

async function sendNow(context, s, text, label) {
  // timed from the decision, so the measured offset includes opening the tab, submitting and the
  // network: the countdown then shifts earlier by the whole delay
  const decidedAt = Date.now();
  const st = stateFor(s.id);
  const fresh = (await core.readSession(io, s.dir, Date.now(), cfg("ttlSeconds") || {})) || s;
  if (fresh.busy || fresh.cacheFrom !== s.cacheFrom) {             // you or the agent moved on
    logx(`${label} for ${s.id.slice(0, 8)} not sent: ${fresh.busy ? "agent working" : "a newer call refreshed the cache"}`);
    return false;
  }
  try {
    const before = allTabKeys();
    await vscode.commands.executeCommand("workbench.action.chat.openSessionInEditorGroup", { resource: sessionUri(s.id) });
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
    if (live(s) < 1.5) logx(`warning: ${label} for ${s.id.slice(0, 8)} sent with only ${live(s).toFixed(1)} s left`);
    st.pending = { sentAt: decidedAt, label, expectId: s.id, tab: opened, restore, sessionId: s.id, before: lastMsgs };
    // No mode or model change: either would invalidate the cache we are trying to keep.
    await vscode.commands.executeCommand("workbench.action.chat.submit", { inputValue: text });
    logx(`${label} sent to ${s.id.slice(0, 8)} (${describe(s)})${opened ? ", in a tab opened for it" : ""}`);
    return true;
  } catch (e) {
    logx(`${label} for ${s.id.slice(0, 8)} failed: ${e.message}`);
    st.pending = null;
    return false;
  }
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
      await vscode.commands.executeCommand("workbench.action.chat.openSessionInEditorGroup", { resource: sessionUri(p.sessionId) });
      await sleep(400);
      await vscode.commands.executeCommand("workbench.action.chat.openInSidebar");
      await sleep(400);
      const still = vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.label === p.tab.label);
      if (still) await vscode.window.tabGroups.close(still, true);
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
    const freshTarget = target && await core.readSession(io, target.dir, Date.now(), cfg("ttlSeconds") || {});
    const pool = freshTarget ? [freshTarget, ...all.filter(x => x.id !== p.expectId)] : all;
    if (freshTarget) all = all.map(x => x.id === freshTarget.id ? freshTarget : x);   // don't wait for the next full read
    // landed = a new Cache Keeper message in some chat since we sent (no clock comparison needed)
    const landed = pool.find(x => x.lastUserTs > (p.before.get(x.id) || 0) && x.lastUserText.startsWith(core.MARKER));
    if (landed && !p.landed) {
      p.landed = landed.id;
      noteOffset(landed.lastUserTs - p.sentAt);
      if (landed.id !== p.expectId) {
        st.mode = "done";
        vscode.window.showErrorMessage(`Cache Keeper: the ${p.label} went to another chat than intended. ` +
          "Stopped acting on the original chat.");
      }
    }
    const done = p.landed && !(pool.find(x => x.id === p.landed) || {}).busy;
    if (done || Date.now() - p.sentAt > 90000) {
      if (!p.landed) vscode.window.showWarningMessage(`Cache Keeper: could not confirm the ${p.label} was sent.`);
      if (p.tab) withUi(() => finishTab(p));
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

/** Keep handoff files out of git without touching the repo's .gitignore. */
async function excludeFromGit() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder || !(await exists(vscode.Uri.joinPath(folder.uri, ".git", "info")))) return;
  const exclude = vscode.Uri.joinPath(folder.uri, ".git", "info", "exclude");
  try {
    let text = "";
    try { text = Buffer.from(await vscode.workspace.fs.readFile(exclude)).toString("utf8"); } catch { /* new file */ }
    if (!text.includes(".copilot-handoff/")) {
      await vscode.workspace.fs.writeFile(exclude, Buffer.from(text + "\n.copilot-handoff/\n"));
    }
  } catch { /* not writable */ }
}

async function summary(context, s, why) {
  const st = stateFor(s.id);
  if (st.handoff && await exists(st.handoff) && st.handoffCovers === s.lastRealUserTs) {
    st.mode = "done";            // a handoff written since your last message still covers this chat
    vscode.window.showInformationMessage(`Cache Keeper: ${path.posix.basename(st.handoff.path)} is still up to date; no new summary.`);
    return true;
  }
  const file = handoffUri(s);
  if (!file) return false;
  await excludeFromGit();
  const rel = path.posix.relative(vscode.workspace.workspaceFolders[0].uri.path, file.path);
  const prompt = `${core.MARKER} I'm pausing and this chat's cache is about to expire. ` +
    `Create the file \`${rel}\` with a handoff summary so a fresh chat can continue: goal, what is done, ` +
    "current state, decisions and why, files changed, open problems, exact next steps, useful commands. " +
    `This chat has ${s.stats.turns} message(s) from me, ${s.stats.compactions} compaction(s), ${s.stats.files} file(s) edited ` +
    `and ${Math.round(s.ctx / 1000)}k tokens of context: aim for about ${s.summaryWords} words. ` +
    "Create only that file, change nothing else, then reply DONE.";
  if (!(await trySend(context, s, prompt, "summary request"))) return false;
  st.mode = "done";
  st.handoff = file;
  st.handoffCovers = s.lastRealUserTs;
  vscode.window.showInformationMessage(`Cache Keeper: writing handoff summary (${why}) to ${rel}.`);
  return true;
}

async function keepAlive(context, s) {
  const ok = await trySend(context, s, HEARTBEAT, "keep-alive");
  if (ok) stateFor(s.id).spent += s.cost ? s.cost.heartbeat : 0;
  return ok;
}

// ---------------------------------------------------------------- choices

// No click = default ("ask"): the cache expires, after a handoff summary if the summary rule applies.
const CHOICES = {
  "Keep warm": "once", "Auto keep warm": "auto", "Summarize": "summarize", "Ignore": "ignore",
};
const DEFAULT_CHOICE = "Back to default";

async function choose(context, s, pick) {
  const st = stateFor(s.id);
  if (!pick) return;
  st.mode = CHOICES[pick] || "ask";      // DEFAULT_CHOICE -> "ask"
  if (st.mode === "once" || st.mode === "auto") {
    vscode.window.showInformationMessage(`Cache Keeper: will send a keep-alive ${lead()}s before the cache expires` +
      (st.mode === "auto" ? ", each time, while it stays worth it." : "."));
  }
  // "summarize" goes out on the next decision tick (now if the chat is on screen).
}

async function offer(context, s) {
  const st = stateFor(s.id);
  if (st.offerOpen) return;      // one warning per chat at a time
  st.offerOpen = true;
  const c = s.cost;
  const autoSum = aboveThreshold(s) && cfg("autoSummary") && seenLive(s);
  const head = `Copilot cache expires in ${Math.max(0, Math.round(live(s)))}s (${describe(s)}). `;
  const msg = !c
    ? head + "No price for this model in Copilot's price sheet: nothing happens automatically."
    : head + `Keep warm: ~${core.fmt(c.heartbeat)} cr. Letting it expire adds ~${core.fmt(c.missExtra)} cr to your next message. ` +
      (autoSum ? `If you don't click, it expires and a handoff summary (~${core.fmt(c.summary)} cr) is written first.`
       : !seenLive(s) ? "If you don't click, it just expires (last active before VS Code restarted, so nothing automatic)."
       : "If you don't click, it just expires (below your summary threshold).");
  const buttons = c ? Object.keys(CHOICES) : ["Keep warm", "Summarize", "Ignore"];
  try {
    await choose(context, s, await vscode.window.showWarningMessage(msg, ...buttons));
  } finally {
    st.offerOpen = false;
  }
}

/** Chats for the list: all warm ones (soonest expiry first), plus the most recently expired. Max 10. */
function listChats() {
  const list = all.filter(managed);
  const warm = list.filter(s => s.busy || live(s) > 0).sort((x, y) => live(x) - live(y));
  const expired = list.filter(s => !s.busy && live(s) <= 0).sort((x, y) => y.cacheFrom - x.cacheFrom).slice(0, 1);
  return [...warm, ...expired].slice(0, 10);
}

function chatItem(s) {
  const r = live(s), st = stateFor(s.id);
  const when = s.busy ? "working" : r > 0 ? `${Math.floor(r / 60)}:${String(Math.floor(r % 60)).padStart(2, "0")}` : "expired";
  return {
    label: `${s.busy ? "$(sync~spin)" : r > 0 ? "$(flame)" : "$(circle-slash)"} ${when}  ${s.title || s.id.slice(0, 8)}`,
    description: `${s.model} · ${Math.round(s.ctx / 1000)}k` + (s.cost ? ` · expiry +${core.fmt(s.cost.missExtra)} cr` : ""),
    detail: modeLabel(st.mode) + (s.cost ? ` · keep-alive ~${core.fmt(s.cost.heartbeat)} cr · spent ${core.fmt(s.credits)} cr` : ""),
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
    qp.items = listChats().map(chatItem);
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
  const pick = await vscode.window.showQuickPick([
    { label: "Keep warm", detail: `One keep-alive ${lead()}s before expiry` },
    { label: "Auto keep warm", detail: "Keep-alives before each expiry while worth it, then summary or stop" },
    { label: "Summarize", detail: "Write the handoff summary now" },
    { label: "Ignore", detail: "Leave this chat alone: no summary, no warnings, until you write in it again" },
    { label: DEFAULT_CHOICE, detail: "Warn before expiry; if no click, it expires (after a summary if above your threshold)" },
  ], { placeHolder: `${describe(chat.s)}: what should happen before its cache expires?` });
  if (pick) await choose(context, chat.s, pick.label);
}

function modeLabel(m) {
  return { ask: "default", once: "keep warm once", auto: "auto keep warm", summarize: "summary waiting",
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
      if (!s.lastUserText.startsWith(core.MARKER) && ["ignore", "done"].includes(st.mode)) {
        st.mode = "ask"; st.spent = 0;
      }
    }
    const r = live(s);
    const actOnce = st.actedFor !== s.cacheFrom;
    // Several chats expiring within seconds of each other: the one expiring first goes earlier
    // (8 s per chat expiring within 10 s after it), so each round trip (open, send, reply, move
    // back) is done before the next chat's turn.
    const crowd = all.filter(x => x.id !== s.id && ["auto", "once"].includes(stateFor(x.id).mode) &&
      live(x) > r && live(x) - r < 10).length;
    const due = lead() + 8 * crowd;
    if ((st.mode === "auto" || st.mode === "once") && r > 0 && r <= due && st.diagFor !== s.cacheFrom) {
      st.diagFor = s.cacheFrom;
      logx(`keep-alive due for ${s.id.slice(0, 8)}: ${Math.round(r)}s left, mode ${st.mode}, ` +
        `seen since start ${seenLive(s)}, worth it ${core.canAffordHeartbeat(s, st.spent)}, ` +
        `already acted ${!actOnce}, sending lock ${sending}`);
    }
    const summaryRule = cfg("autoSummary") && aboveThreshold(s) && seenLive(s);

    if (st.mode === "summarize" && r > 0) {
      if (await summary(context, s, "on request")) st.actedFor = s.cacheFrom;
    } else if (st.mode === "once" && r > 0 && r <= due && actOnce) {
      if (await keepAlive(context, s)) { st.actedFor = s.cacheFrom; st.mode = "ask"; }
    } else if (st.mode === "auto" && r > 0 && r <= due && actOnce && seenLive(s)) {
      if (core.canAffordHeartbeat(s, st.spent)) {
        if (await keepAlive(context, s)) st.actedFor = s.cacheFrom;
      } else if (await summary(context, s, "keeping warm is no longer worth it")) {
        st.actedFor = s.cacheFrom;
      }
    } else if (st.mode === "ask" && r > 0 && r <= SUMMARY_LEAD && actOnce && summaryRule) {
      if (await summary(context, s, "no answer before expiry")) {
        st.actedFor = s.cacheFrom;
      }
    }
    if (st.mode === "ask" && r > 0 && r <= cfg("warnSeconds") && st.promptedFor !== s.cacheFrom) {
      st.promptedFor = s.cacheFrom;
      offer(context, s);         // not awaited: the notification stays while we keep deciding
    }
    if (r <= 0 && r > -120 && st.expiredFor !== s.cacheFrom && st.mode !== "ignore") {
      // confirm with the chat's own log: a keep-alive may have refreshed it since the last full read
      const fresh = await core.readSession(io, s.dir, Date.now(), cfg("ttlSeconds") || {});
      if (fresh && fresh.cacheFrom !== s.cacheFrom) { all = all.map(x => x.id === fresh.id ? fresh : x); continue; }
      st.expiredFor = s.cacheFrom;
      const actions = st.handoff && await exists(st.handoff) ? ["New chat from handoff"] : [];
      vscode.window.showInformationMessage(
        `Copilot cache expired (${describe(s)}). Your next message there re-sends the context` +
          (s.cost ? `: ~${core.fmt(s.cost.missExtra)} extra credits.` : "."),
        ...actions).then(a => { if (a) newChatFromHandoff(st.handoff); });
    }
  }
  updateStatus(context);
}

async function newChatFromHandoff(uri) {
  await vscode.commands.executeCommand("workbench.action.chat.newChat");
  await vscode.commands.executeCommand("workbench.action.chat.open", {
    query: "Continue from the attached handoff summary. ", isPartialQuery: true, attachFiles: [uri],
  });
}

function updateStatus(context) {
  const list = all.filter(managed);
  const s = list[0];            // most recently active chat
  if (!s) { statusItem.hide(); return; }
  const st = stateFor(s.id), r = live(s);
  const shownInList = listChats().length;            // warm chats + the latest expired, max 10
  const others = shownInList > 1 ? ` +${shownInList - 1}` : "";
  if (s.busy) statusItem.text = `$(sync~spin) cache: agent working${others}`;
  else if (r > 0) {
    statusItem.text = `$(flame) cache ${Math.floor(r / 60)}:${String(Math.floor(r % 60)).padStart(2, "0")}` +
      (st.mode === "auto" ? " (keeping warm)" : st.mode === "once" ? " (keep-alive armed)" : "") + others;
  } else statusItem.text = "$(circle-slash) cache expired" + (s.cost ? `: next msg +${core.fmt(s.cost.missExtra)} cr` : "") + others;
  statusItem.tooltip = `${describe(s)}. ` + (s.cost
    ? `Keep-alive ~${core.fmt(s.cost.heartbeat)} cr, expiry adds ~${core.fmt(s.cost.missExtra)} cr, summary ~${core.fmt(s.cost.summary)} cr. ` +
      `Session so far ${core.fmt(s.credits)} cr. `
    : "No price for this model in Copilot's price sheet. ") +
    `Cache lifetime ${s.ttl}s. Click to manage the ${shownInList} chat(s) in the list.`;
  statusItem.backgroundColor = r > 0 && r <= cfg("warnSeconds") && !s.busy
    ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  statusItem.show();
}


let ctxRef;                    // for tests
function activate(context) {
  ctxRef = context;
  out = vscode.window.createOutputChannel("Cache Keeper");
  context.subscriptions.push(out);
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "cacheKeeper.options";
  context.subscriptions.push(statusItem);
  // cache lifetimes from Copilot CLI logs: learned once the logs are located, refreshed every 30 min
  const shownOrNewest = () => all.filter(managed)[0];
  context.subscriptions.push(
    vscode.commands.registerCommand("cacheKeeper.options", () => pickChat(context)),
    vscode.commands.registerCommand("cacheKeeper.keepWarmNow", async () => { const s = shownOrNewest(); if (s) await keepAlive(context, s); }),
    vscode.commands.registerCommand("cacheKeeper.summaryNow", async () => { const s = shownOrNewest(); if (s) await summary(context, s, "on request"); }),
    // Stop keeping warm: back to the default for every chat (expire, summary rule applies).
    vscode.commands.registerCommand("cacheKeeper.stop", () => {
      for (const st of sessions.values()) if (st.mode === "auto" || st.mode === "once") st.mode = "ask";
    }),
  );
  const timers = [
    setInterval(() => { readAll(context).then(setAll).catch(e => logx("read error: " + e.message)); }, READ_MS),
    setInterval(() => decide(context).catch(e => console.error("cache-keeper", e)), DECIDE_MS),
    setInterval(() => { if (logRootPath) core.learnTtls(io, remoteHome || require("os").homedir()).catch(() => {}); }, 30 * 60 * 1000),
  ];
  readAll(context).then(setAll).catch(e => logx("read error: " + e.message));
  context.subscriptions.push({ dispose: () => timers.forEach(clearInterval) });
}

function deactivate() {}

// for tests
module.exports = { activate, deactivate, _read: async (c) => { setAll(await readAll(c || ctxRef)); }, _decide: (c) => decide(c || ctxRef) };
