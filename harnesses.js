// One small translator per chat harness: its log in, the shared event list out (see core.js,
// analyzeTrace). Everything about caches, costs and decisions lives in core.js and works the same
// for every harness. Adding a harness = a translator here + where its log is (extension.js).
//
// The shared event list, oldest first:
//   { t: "user", ts, text }       a message in the chat (yours or Cache Keeper's)
//   { t: "call", ts, model, input, cached, written, out, credits?, ttl?, expiresAt?, rates? }
//                                 a model call of the chat's own conversation. ts = when the request
//                                 started (the cache is refreshed then); input = whole prompt incl.
//                                 cached; written = tokens written to the cache; credits = billed;
//                                 ttl / expiresAt = cache lifetime and expiry, when the log says;
//                                 rates = { read, write, out } credits per token, when the log says
//   { t: "aux", ts, model }       another call that also refreshed the cache (title, summary, ...)
//   { t: "turn_start", ts }  { t: "turn_end", ts }  { t: "abort", ts }  { t: "idle", ts }
//   { t: "queued", ts }           a message is waiting for its turn (busy, but not a message yet)
//   { t: "activity", ts }         a tool ran: the agent is alive
//   { t: "reply", ts, text }      the agent's answer (for the language of our messages)
//   { t: "edit", ts, files }      files the agent edited (for the summary length)
//   { t: "compaction", ts }       the history was summarized
// Each translator takes the log's text, or its lines already parsed (an array), and returns { events, info } (info: cwd, gitRoot, stepTurns, compactions) or
// null when the log has no model call yet.
"use strict";

function parseJsonl(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line while being written */ }
  }
  return out;
}
/** A log's lines as objects: from its text, or already parsed (core.cachedTrace parses only what was appended). */
function entries(log) { return Array.isArray(log) ? log : parseJsonl(log); }
const time = s => Date.parse(s || "") || 0;
const byTime = list => list.sort((a, b) => a.ts - b.ts);
const done = (events, info = {}) => events.some(e => e.t === "call") ? { events: byTime(events), info } : null;

/** File paths in a tool call's arguments (JSON fields or an apply_patch body). */
function filesIn(args) {
  const s = typeof args === "string" ? args : JSON.stringify(args || {});
  const files = new Set();
  for (const m of s.matchAll(/"(?:filePath|file_path|path|file)"\s*:\s*"([^"]+)"/g)) files.add(m[1]);
  for (const m of s.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\\\n]+)/g)) files.add(m[1].trim());
  return [...files];
}

// ---------------------------------------------------------------- Local (VS Code's own agent)
// Agent Debug Log: workspaceStorage/<id>/GitHub.copilot-chat/debug-logs/<chat>/main.jsonl

const LOCAL_EDIT_TOOLS = /apply_patch|create_file|replace_string|insert_edit|edit_file|write_file|edit_notebook/i;

function localTrace(mainText) {
  const ev = [];
  for (const e of entries(mainText)) {
    const a = e.attrs || {}, ts = e.ts || 0;
    if (e.type === "user_message") {
      // Copilot leaves a turn open, with no turn_end, when the request is stopped or when you send a
      // message while a tool is still running: a new message ends whatever came before.
      ev.push({ t: "abort", ts }, { t: "user", ts, text: String(a.content || "") });
    } else if (e.type === "turn_start" || e.type === "turn_end") ev.push({ t: e.type, ts });
    else if (e.type === "llm_request") {
      const credits = a.copilotUsageNanoAiu ? a.copilotUsageNanoAiu / 1e9 : undefined;
      if (String(a.debugName || "").startsWith("panel/") && "inputTokens" in a) {
        ev.push({ t: "call", ts, end: ts + (e.dur || 0), model: a.model || "?", input: a.inputTokens || 0,
                  cached: a.cachedTokens || 0, out: a.outputTokens || 0, credits, effort: requestEffort(a) });
      } else {
        // another call (title, summary, check): its tokens and credits for the spend report
        const summary = /summarizeConversationHistory/.test(String(a.debugName || ""));
        ev.push({ t: "aux", ts, model: a.model, input: a.inputTokens || 0, cached: a.cachedTokens || 0, out: a.outputTokens || 0,
                  credits, summary });
        if (summary) ev.push({ t: "compaction", ts });
      }
    } else if (e.type === "tool_call") {
      ev.push({ t: "activity", ts });
      if (LOCAL_EDIT_TOOLS.test(e.name || "")) ev.push({ t: "edit", ts, files: filesIn(String(a.args || "")) });
    } else if (e.type === "agent_response") {
      ev.push({ t: "reply", ts, text: Object.values(a).filter(v => typeof v === "string" && v.length > 1).join(" ").slice(0, 4000) });
    }
  }
  return done(ev);
}

/** The reasoning effort a Local request asked for (requestOptions), or undefined. */
function requestEffort(a) {
  try {
    const o = JSON.parse(a.requestOptions || "{}");
    return (o.reasoning && o.reasoning.effort) || (o.output_config && o.output_config.effort) || undefined;
  } catch { return undefined; }
}

// ---------------------------------------------------------------- Copilot SDK ("Copilot" harness)
// ~/.copilot/session-state/<id>/events.jsonl (+ workspace.yaml), Copilot CLI's format.

const SDK_EDIT_TOOLS = /^(apply_patch|create|edit|str_replace|str_replace_editor|write|write_file|create_file|insert)$/i;

/** Per-token credits from a usage record's tokenDetails, or undefined when it carries none. */
function sdkRates(u) {
  const d = u && u.copilotUsage && u.copilotUsage.tokenDetails;
  if (!Array.isArray(d) || !d.length) return undefined;
  const per = {};
  for (const t of d) if (t.batchSize) per[t.tokenType] = t.costPerBatch / t.batchSize / 1e9;
  return per;
}

function sdkTrace(eventsText, yaml = {}) {
  const ev = [];
  let effort;                   // set at session start and on each model change
  let billedTotal;              // the session's total as billed (checkpoints, shutdown): it includes calls with no usage record
  for (const e of entries(eventsText)) {
    const d = e.data || {}, ts = time(e.timestamp);
    if (typeof d.reasoningEffort === "string") effort = d.reasoningEffort;
    if (e.type !== "session.usage_record" && typeof d.totalNanoAiu === "number") billedTotal = Math.max(billedTotal || 0, d.totalNanoAiu / 1e9);
    switch (e.type) {
      // a message sent while the agent works gets a <reminder> appended
      case "user.message": ev.push({ t: "user", ts, text: String(d.content || "").replace(/\n*<reminder>[\s\S]*$/, "").trim() }); break;
      case "assistant.turn_start": ev.push({ t: "turn_start", ts }); break;
      case "assistant.turn_end": ev.push({ t: "turn_end", ts }); break;
      case "abort": case "session.shutdown": ev.push({ t: "abort", ts }); break;
      case "session.usage_checkpoint": ev.push({ t: "idle", ts }); break;
      case "assistant.message": ev.push({ t: "reply", ts, text: String(d.content || "").slice(0, 4000) }); break;
      case "tool.execution_start":
        ev.push({ t: "activity", ts });
        if (SDK_EDIT_TOOLS.test(d.toolName || "")) ev.push({ t: "edit", ts, files: filesIn(d.arguments) });
        break;
      case "tool.execution_complete": ev.push({ t: "activity", ts }); break;
      case "session.usage_record": {
        const u = d.usage;
        if (!u || typeof u.inputTokens !== "number") break;
        const ttl = Number(u.cacheTtlSeconds) || undefined;
        ev.push({ t: "call", ts: ts - (u.duration || 0), end: ts, model: u.model || "?", input: u.inputTokens,
                  cached: u.cacheReadTokens || 0, written: u.cacheWriteTokens, out: u.outputTokens || 0,
                  credits: u.copilotUsage && u.copilotUsage.totalNanoAiu !== undefined ? u.copilotUsage.totalNanoAiu / 1e9 : undefined,
                  ttl, expiresAt: time(u.cacheExpiresAt) || undefined, rates: sdkRates(u), effort,
                  side: u.initiator !== undefined && u.initiator !== "user" && u.initiator !== "agent" });
        break;
      }
      default:
        if (/compaction_(complete|completed|end)$/.test(e.type || "")) ev.push({ t: "compaction", ts }, { t: "turn_end", ts });
        // logged at once (the end can come many seconds later): the compaction is running, the chat busy
        else if (/compaction_start(ed)?$/.test(e.type || "")) ev.push({ t: "compacting", ts }, { t: "turn_start", ts });
    }
  }
  // An SDK request is several turns (one per model call and its tools), with a few ms between them.
  return done(ev, { cwd: yaml.cwd || "", gitRoot: yaml.git_root || "", stepTurns: true,
                    compactions: Number(yaml.summary_count) || 0, billedTotal });
}

// ---------------------------------------------------------------- Claude harness (Claude Agent SDK)
// ~/.claude/projects/<folder>/<sdkSessionId>.jsonl. That folder also holds your own Claude Code
// sessions: only files VS Code names in its session database are read (see extension.js).

/** Anthropic model ids (claude-haiku-5-5) as Copilot names them (claude-haiku-5.5). */
function copilotModelId(m) { return String(m || "").replace(/-(\d+)-(\d+)$/, "-$1.$2"); }

const CLAUDE_EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit)$/;
const CLAUDE_TURN_DONE = /^(end_turn|stop_sequence|max_tokens|refusal)$/;

function claudeTrace(text) {
  const ev = [], starts = new Map(), calls = new Map();
  let cwd = "";
  for (const e of entries(text)) {
    const ts = time(e.timestamp), m = e.message && typeof e.message === "object" ? e.message : {};
    if (e.isSidechain) { if (ts) ev.push({ t: "activity", ts }); continue; }   // a subagent: alive, other cache
    if (e.cwd) cwd = e.cwd;
    if (e.type === "queue-operation" && e.operation === "enqueue") ev.push({ t: "queued", ts });
    else if (e.type === "api-request" && e.id) starts.set(e.id, ts);
    else if (e.type === "system" && e.subtype === "compact_boundary") ev.push({ t: "compaction", ts });
    else if (e.type === "user" && (e.isCompactSummary || e.isVisibleInTranscriptOnly)) {
      // the summary a compaction carries over ("This session is being continued..."): not a message
      ev.push({ t: "activity", ts });
    } else if (e.type === "user" && !e.isMeta) {
      const c = m.content;
      // a local command (/compact): logged as <command-name> + <command-args>, its output as
      // <local-command-stdout>, with no model turn of its own. One message; the output ends it.
      const raw = typeof c === "string" ? c : "";
      const cmd = /^\s*<command-name>([^<]*)<\/command-name>/.exec(raw);
      if (cmd) {
        const args = (/<command-args>([\s\S]*?)<\/command-args>/.exec(raw) || [])[1] || "";
        ev.push({ t: "user", ts, text: `${cmd[1].trim()} ${args.trim()}`.trim() }, { t: "turn_start", ts });
        continue;
      }
      if (/^\s*<local-command-(stdout|stderr)>/.test(raw)) { ev.push({ t: "turn_end", ts }); continue; }
      // what you typed only: the harness adds attachments as separate <system-reminder> text blocks
      const textPart = withoutReminders(typeof c === "string" ? c
        : Array.isArray(c) ? c.filter(p => p && p.type === "text").map(p => p.text).join("\n") : "");
      if (Array.isArray(c) && c.some(p => p && p.type === "tool_result")) { ev.push({ t: "activity", ts }); continue; }
      if (/^\[Request interrupted/.test(textPart)) { ev.push({ t: "abort", ts }); continue; }
      if (textPart) ev.push({ t: "user", ts, text: textPart.trim() }, { t: "turn_start", ts });
    } else if (e.type === "assistant" && m.usage) {
      // a reply streamed in several blocks repeats the same message (and usage): count it once
      const key = e.requestRef || m.id || ts;
      const u = m.usage, cc = u.cache_creation || {};
      const written = u.cache_creation_input_tokens || 0;
      const ttl = cc.ephemeral_1h_input_tokens > 0 ? 3600 : cc.ephemeral_5m_input_tokens > 0 ? 300 : undefined;
      const call = { t: "call", ts: starts.get(e.requestRef) || ts, end: ts, model: copilotModelId(m.model),
                     input: (u.input_tokens || 0) + written + (u.cache_read_input_tokens || 0),
                     cached: u.cache_read_input_tokens || 0, written, out: u.output_tokens || 0, ttl };
      if (!calls.has(key)) { calls.set(key, call); ev.push(call); } else Object.assign(calls.get(key), call);
      for (const p of Array.isArray(m.content) ? m.content : []) {
        if (p.type === "text" && p.text) ev.push({ t: "reply", ts, text: p.text.slice(0, 4000) });
        if (p.type === "tool_use" && CLAUDE_EDIT_TOOLS.test(p.name || "")) ev.push({ t: "edit", ts, files: filesIn(p.input) });
      }
      if (CLAUDE_TURN_DONE.test(m.stop_reason || "")) ev.push({ t: "turn_end", ts });
    }
  }
  return done(ev, { cwd });
}

// ---------------------------------------------------------------- Codex harness
// ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl

/** Text without the <system-reminder> blocks Claude's harness adds (attachment references, ...). */
function withoutReminders(t) { return String(t || "").replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, "").trim(); }

function codexText(content) {
  return (Array.isArray(content) ? content : []).map(p => p && (p.text || "")).join("\n").trim();
}

function codexTrace(text) {
  const ev = [];
  let model = "?", cwd = "", lastInput = 0;
  for (const e of entries(text)) {
    const p = e.payload || {}, ts = time(e.timestamp);
    if (e.type === "session_meta") { cwd = p.cwd || cwd; continue; }
    if (e.type === "turn_context") { model = p.model || model; cwd = p.cwd || cwd; continue; }
    if (e.type === "event_msg") {
      if (p.type === "task_started") { ev.push({ t: "turn_start", ts }); lastInput = ts; }
      else if (p.type === "task_complete") ev.push({ t: "turn_end", ts });
      else if (p.type === "turn_aborted") ev.push({ t: "abort", ts });
      else if (p.type === "thread_settings_applied" && p.thread_settings && p.thread_settings.model) model = p.thread_settings.model;
      else if (/compact/.test(p.type || "")) ev.push({ t: "compaction", ts });
      continue;
    }
    if (e.type === "compacted") { ev.push({ t: "compaction", ts }); continue; }
    if (e.type === "token_usage_record") {
      const u = p.usage || {};
      // the request started after its last input arrived (a message or a tool's output)
      ev.push({ t: "call", ts: lastInput || ts, end: ts, model, input: u.input_tokens || 0, cached: u.cached_input_tokens || 0,
                written: u.cache_write_input_tokens, out: (u.output_tokens || 0) });
      continue;
    }
    if (e.type !== "response_item") continue;
    if (p.type === "message" && p.role === "user") {
      // what you typed only: Codex appends attachments as "@/path" lines
      const t = codexText(p.content).replace(/(\n+@\S+)+\s*$/, "").trim();
      lastInput = ts;
      // Codex adds its own context blocks as user messages (<environment_context>, ...): not yours
      if (t && !/^<[a-z_]+>[\s\S]*<\/[a-z_]+>$/.test(t)) ev.push({ t: "user", ts, text: t });
    } else if (p.type === "message" && p.role === "assistant") ev.push({ t: "reply", ts, text: codexText(p.content).slice(0, 4000) });
    else if (/_call_output$/.test(p.type || "")) { ev.push({ t: "activity", ts }); lastInput = ts; }
    else if (/_call$/.test(p.type || "")) {
      ev.push({ t: "activity", ts });
      if (/apply_patch/.test(p.name || "")) ev.push({ t: "edit", ts, files: filesIn(p.arguments || p.input) });
    }
  }
  return done(ev, { cwd });
}

module.exports = { parseJsonl, localTrace, sdkTrace, claudeTrace, codexTrace, copilotModelId, filesIn };
