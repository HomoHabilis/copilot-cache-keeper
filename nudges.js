// Nudges: when to tell you that a chat is costing real money that a different habit would save.
// Pure decisions (no VS Code): the extension asks here what to show for a chat, and shows it.
//
// The rule for all of them: only for real spending. Each is tied to an amount in credits it must
// reach (cacheKeeper.nudges.minCredits, nudges.splitMinCredits); below it, nothing is shown at all, not
// even a passive line. None is shown twice for the same reason, and each has a "Mute for this chat".
// A chat that runs unattended for an hour is never a reason by itself: what counts is context carried
// across your messages, and pauses.
//
//   s    a chat's state (core.analyzeTrace)
//   ins  its what-ifs (report.liveInsight), or null
//   mem  what this chat was already told: { muted ("Mute for this chat", on any nudge: no more nudges of
//        any kind for it), splitAt, keepOffered, waitFor }
"use strict";
const core = require("./core");

const DEFAULTS = { minCredits: 100, splitMinCredits: 300, splitMinPercent: 25, digestDays: 7 };
// One switch per nudge (cacheKeeper.nudges.<name>, all on by default), active ones first, then the passive ones.
const KINDS = ["split", "autoKeepWarmOffer", "waitingWarning", "costPerCall", "commitHint", "contextSizeTip", "digest"];
const CARRY_CALLS = 50;        // the carry cost counts once this many more calls would cost minCredits more than in a new chat
const DIGEST_FACTOR = 5;       // the digest is shown when the period's saving reaches this many times minCredits
const SPLIT_AGAIN = 2;         // the split nudge comes back once the chat has cost this many times what it had then

const cr = x => core.fmt(x);
const usd = x => `$${(x / 100).toFixed(2)}`;

/** The thresholds from the settings (missing or invalid: the defaults). */
function options(get) {
  const num = (key, d) => { const v = Number(get(key)); return Number.isFinite(v) && v >= 0 && get(key) !== undefined && get(key) !== null ? v : d; };
  // cacheKeeper.nudges.enabled turns them all off; each one also has its own switch (KINDS)
  const on = get("nudges.enabled") !== false, o = { on };
  for (const k of KINDS) o[k] = on && get(`nudges.${k}`) !== false;
  return Object.assign(o, { minCredits: num("nudges.minCredits", DEFAULTS.minCredits),
    splitMinCredits: num("nudges.splitMinCredits", DEFAULTS.splitMinCredits),
    splitMinPercent: num("nudges.splitMinPercent", DEFAULTS.splitMinPercent),
    digestDays: num("nudges.digestDays", DEFAULTS.digestDays) });
}

/** What a new chat would save per model call from here, in credits. */
function perCallSaving(ins) { return ins ? Math.max(0, ins.carry.perCall - ins.carry.newPerCall) : 0; }

/** The context this chat carries costs real money: CARRY_CALLS more calls cost minCredits more than in a new chat. */
function carryMatters(ins, o) { return perCallSaving(ins) * CARRY_CALLS >= o.minCredits && o.minCredits >= 0 && perCallSaving(ins) > 0; }

/**
 * The agent has finished and this chat would have cost much less in two or three chats: say so, once
 * (again only when it has cost twice as much since). Not while the agent works, not on a Fusion chat,
 * not when the context has just been compacted.
 */
function splitNudge(s, ins, mem, o) {
  if (!o.split || !ins || !ins.split || s.busy || s.routed || !ins.growing || mem.muted || mem.splitNever) return null;
  if (ins.split.saving < o.splitMinCredits || ins.split.share * 100 < o.splitMinPercent) return null;
  if (mem.splitAt && ins.billed < SPLIT_AGAIN * mem.splitAt) return null;
  const per = perCallSaving(ins);
  return { kind: "split", billed: ins.billed,
    text: `Cache Keeper: ${name(s)} has cost ${cr(ins.billed)} cr (${usd(ins.billed)}). In ${ins.split.chats} chats it would have been about ` +
      `${cr(ins.billed - ins.split.saving)} cr (${Math.round(100 * ins.split.share)}% less).` +
      (per >= 0.05 ? ` From here, a new chat saves about ${cr(per)} cr on every model call.` : ""),
    buttons: [CONTINUE, MUTE_THIS_CHAT] };
}

/**
 * This chat has paid for two expired caches after pauses, and keeping it warm through them would
 * have cost much less: offer Auto keep warm, once, while the cache is warm.
 */
function keepWarmOffer(s, ins, mem, o, remaining) {
  if (!o.autoKeepWarmOffer || !ins || s.busy || s.routed || !s.cost || mem.muted || mem.keepOffered || remaining <= 0) return null;
  const p = ins.paid.pause;
  if (p.count < 2 || ins.keeperSaving < o.minCredits) return null;
  return { kind: "keepWarm",
    text: `Cache Keeper: ${name(s)} has paid for ${p.count} expired caches after pauses (${cr(p.credits)} cr). Keeping it warm ` +
      `through them would have cost about ${cr(Math.max(0, p.credits - ins.keeperSaving))} cr.`,
    buttons: [AUTO_KEEP_WARM, MUTE_THIS_CHAT] };
}

/**
 * The agent is in the middle of a turn, has made no model call for almost a whole cache lifetime, and
 * its next call would re-send a costly context: it may be waiting for you to approve a tool. Once per
 * message of yours. (A long command looks the same in the log: nothing can be done about that one.)
 */
function waitingWarning(s, mem, o, remaining, warnSeconds) {
  if (!o.waitingWarning || !s.busy || s.routed || !s.cost || mem.muted || mem.waitNever) return null;
  if (!(remaining > 0 && remaining <= warnSeconds) || s.cost.missExtra < o.minCredits || mem.waitFor === s.lastRealUserTs) return null;
  const quiet = Math.max(1, Math.round((s.ttl - remaining) / 60));
  return { kind: "waiting",
    text: `Cache Keeper: the agent in ${name(s)} has made no model call for ${quiet} min: it may be waiting for your approval ` +
      `(or running a long command). Cache expires in ${Math.round(remaining)}s: the next step then re-sends the context, ` +
      `+${cr(s.cost.missExtra)} cr.`,
    // nothing to choose here: "Got it" just closes it. Muting is worth having: a long command looks
    // the same, and a chat full of long builds would keep getting it
    buttons: [GOT_IT, MUTE_THIS_CHAT] };
}

/** The tooltip's line on what the carried context costs per call, only when that is real money. */
function carryLine(ins, o) {
  if (!o.costPerCall || !carryMatters(ins, o)) return null;
  return `Each model call re-reads ${Math.round(ins.ctx / 1000)}k tokens: **${cr(ins.carry.perCall)} cr** (in a new chat: about ${cr(ins.carry.newPerCall)} cr).`;
}

/**
 * The agent committed or pushed since your last message, and the carried context costs real money: a
 * piece of work is done, a cheap moment to go on in a new chat. Status bar only, until you write again.
 */
function commitHint(s, ins, o, mem = {}) {
  if (!o.commitHint || !ins || s.busy || s.routed || mem.muted || !carryMatters(ins, o)) return null;
  if (!(ins.lastCommit > (s.lastRealUserTs || 0))) return null;
  return `$(git-commit) **Just committed:** a good moment for a new chat (about ${cr(perCallSaving(ins))} cr less per model call). ${continueLink(s)}`;
}

/**
 * A chat has grown past the model's smaller context-size option, and an expiry there costs real
 * money: say once (ever) that the smaller option would have compacted by now. `smaller`: that
 * option's size in tokens (the price sheet's base tier), or null when the model has only one.
 */
function contextTip(s, smaller, o, shown) {
  if (!o.contextSizeTip || shown || !smaller || s.routed || !s.cost || s.ctx <= smaller || s.cost.missExtra < o.minCredits) return null;
  return { kind: "contextTip",
    // (a notification with no button is cut to one line: the button is what lets the text show in full)
    text: `Cache Keeper: ${name(s)} is at ${Math.round(s.ctx / 1000)}k tokens, past ${s.model}'s ${Math.round(smaller / 1000)}K context-size option ` +
      `(next to the model, under the chat box). With it, VS Code would have compacted by now; an expiry here adds about ${cr(s.cost.missExtra)} cr.`,
    buttons: [GOT_IT] };
}

/**
 * The digest of a spend analysis (report.analyzeSpend) over `days`: one line, only when keeping warm
 * and shorter chats would have saved real money (DIGEST_FACTOR times minCredits).
 */
function digest(a, days, o) {
  const wi = a && a.whatIf;
  if (!o.digest || !wi || !wi.rows.length || wi.both < DIGEST_FACTOR * o.minCredits) return null;
  return { kind: "digest",
    text: `Cache Keeper, last ${days} days: ${cr(a.total)} cr (${usd(a.total)}) in Copilot chats, ${cr(wi.coldPause + wi.coldWait)} cr of it ` +
      `expired caches. Keeping warm and shorter chats would have saved about ${cr(wi.both)} cr ` +
      `(${Math.round(100 * wi.both / Math.max(wi.billed, 1e-9))}% of the ${wi.rows.length} costliest).`,
    buttons: [OPEN_REPORT, DONT_SHOW_AGAIN] };
}

/**
 * A link for the status-bar tooltip that does it in one click: the handoff summary is written, then
 * the new chat opens from it (the command cacheKeeper.continueInNewChat, for this chat).
 */
const CONTINUE_COMMAND = "cacheKeeper.continueInNewChat";
function continueLink(s) {
  return `[$(arrow-right) ${CONTINUE}](command:${CONTINUE_COMMAND}?${encodeURIComponent(JSON.stringify([String(s.id)]))} "Write the handoff summary, then open a new chat from it")`;
}

function name(s) {
  const t = s.title || String(s.id).slice(0, 8);
  return `"${t.length > 30 ? t.slice(0, 29) + "…" : t}"`;
}

const CONTINUE = "Continue in new chat", AUTO_KEEP_WARM = "Auto keep warm",
      OPEN_REPORT = "Open report", DONT_SHOW_AGAIN = "Don't show again", GOT_IT = "Got it",
      MUTE_THIS_CHAT = "Mute for this chat";

module.exports = { options, continueLink, CONTINUE_COMMAND, splitNudge, keepWarmOffer, waitingWarning, carryLine, commitHint, contextTip, digest, carryMatters, perCallSaving,
  DEFAULTS, KINDS, CARRY_CALLS, DIGEST_FACTOR, GOT_IT, MUTE_THIS_CHAT, CONTINUE, AUTO_KEEP_WARM, OPEN_REPORT, DONT_SHOW_AGAIN };
