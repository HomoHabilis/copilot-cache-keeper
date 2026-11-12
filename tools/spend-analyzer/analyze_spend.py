#!/usr/bin/env python3
"""Find where your AI coding agents spend Copilot credits, and what you could avoid.

Finds the agent logs on this machine by itself:
  - VS Code Copilot Chat  Agent Debug Logs (exact credits per model call) and chat session files
                          (per message; older sessions, effort and context-size settings,
                          tool-definition share of each prompt)
  - Copilot CLI           ~/.copilot/session-state/*/events.jsonl (also VS Code's "Copilot" harness
                          chats, Copilot SDK, shown separately)
  - VS Code Claude and Codex harness chats: listed in VS Code's agent-host.db, billed through
                          Copilot; logs in ~/.claude/projects and ~/.codex/sessions (your own Claude
                          Code sessions there are left out)
  - OpenCode              ~/.local/share/opencode/opencode.db

Then ranks the spending factors by credits that could have been avoided: expired caches after
pauses, oversized context, max/xhigh reasoning effort, the long-context price tier, tool
definitions sent with every call, compactions, subagents.

  python3 analyze_spend.py                    last 60 days, report in ./spend-report-<date>.md
  python3 analyze_spend.py --days 90
  python3 analyze_spend.py --input DIR        also search DIR (e.g. logs copied from another machine)
  python3 analyze_spend.py --json calls.json  also dump every normalized call

Credits: 1 credit = $0.01 (GitHub AI Credits). VS Code debug logs give exact credits; the rest is
computed from tokens with the price sheet Copilot sends VS Code (models.json), or OpenCode's cost.
Standard library only.
"""

from __future__ import annotations

import argparse
import base64
import collections
import datetime as dt
import glob
import json
import os
import re
import sqlite3
import statistics
import sys
import tempfile
import shutil
from pathlib import Path

HOME = Path.home()
# Cache lifetimes, from data only (see ttl_for): logged, measured, else these known values. Other
# models with no data get none, and no expiry is judged for them.
KNOWN_TTLS = [("claude", 300), ("gpt-6.1-sol", 1800)]   # seconds
MISS_MIN_CTX = 30_000          # ignore misses on small prompts
MISS_CACHED_BELOW = 0.5        # a call with less than half its prompt cached is a miss
TYPICAL_NEW = 1_000            # tokens a normal message adds uncached (not part of a miss)
BIG_CTX = 100_000              # context above this is re-read (cache price) on every call

# ---------------------------------------------------------------- where logs live

def wsl_homes() -> list[Path]:
    r"""On Windows: the home folders of the running WSL distros (\\wsl.localhost\<distro>\home\<user>),
    where VS Code keeps a WSL window's logs. Only running distros: reading one would start it."""
    if os.name != "nt":
        return []
    import subprocess
    def distros(*flags):
        try:
            out = subprocess.run(["wsl.exe", "-l", "-q", *flags], capture_output=True, timeout=15).stdout
        except (OSError, subprocess.SubprocessError):
            return []
        # UTF-16 by default; UTF-8 when WSL_UTF8 is set or in newer wsl.exe versions
        text = out.decode("utf-16-le", errors="ignore") if b"\x00" in out else out.decode("utf-8", errors="ignore")
        return [d.strip().lstrip("\ufeff") for d in text.replace("\x00", "").splitlines() if d.strip()]
    running, installed = distros("--running"), distros()
    stopped = [d for d in installed if d not in running]
    if stopped:
        print(f"WSL distros not running, not read: {', '.join(stopped)} (start them to include their chats)", file=sys.stderr)
    homes = []
    for d in running:
        for prefix in (r"\\wsl.localhost", r"\\wsl$"):
            base = Path(prefix + "\\" + d + "\\home")
            try:
                homes += [p for p in base.iterdir() if p.is_dir()]
                break
            except OSError:
                continue
    return homes


OTHER_HOMES = wsl_homes()



def vscode_storage_roots(extra: list[Path]) -> list[Path]:
    """VS Code workspaceStorage folders: local install, VS Code server (remote/WSL), Windows from WSL."""
    pats = [
        HOME / ".vscode-server/data/User/workspaceStorage",
        HOME / ".vscode-server-insiders/data/User/workspaceStorage",
        HOME / ".config/Code/User/workspaceStorage",
        HOME / ".config/Code - Insiders/User/workspaceStorage",
        HOME / "Library/Application Support/Code/User/workspaceStorage",
        HOME / "Library/Application Support/Code - Insiders/User/workspaceStorage",
    ]
    if os.environ.get("APPDATA"):
        pats += [Path(os.environ["APPDATA"]) / "Code/User/workspaceStorage",
                 Path(os.environ["APPDATA"]) / "Code - Insiders/User/workspaceStorage"]
    pats += [Path(p) for p in glob.glob("/mnt/c/Users/*/AppData/Roaming/Code/User/workspaceStorage")]
    pats += [Path(p) for p in glob.glob("/mnt/c/Users/*/AppData/Roaming/Code - Insiders/User/workspaceStorage")]
    for h in OTHER_HOMES:
        pats += [h / ".vscode-server/data/User/workspaceStorage", h / ".vscode-server-insiders/data/User/workspaceStorage"]
    for e in extra:
        pats += [Path(p) for p in glob.glob(str(e / "**/workspaceStorage"), recursive=True)]
    return [p for p in dict.fromkeys(pats) if p.is_dir()]


def cli_roots(extra: list[Path]) -> list[Path]:
    roots = [HOME / ".copilot/session-state"] + [Path(p) for p in glob.glob("/mnt/c/Users/*/.copilot/session-state")] + \
            [h / ".copilot/session-state" for h in OTHER_HOMES]
    for e in extra:
        roots += [Path(p) for p in glob.glob(str(e / "**/session-state"), recursive=True)]
    return [p for p in dict.fromkeys(roots) if p.is_dir()]


def opencode_dbs(extra: list[Path]) -> list[Path]:
    dbs = [HOME / ".local/share/opencode/opencode.db"] + \
          [Path(p) for p in glob.glob("/mnt/c/Users/*/.local/share/opencode/opencode.db")] + \
          [h / ".local/share/opencode/opencode.db" for h in OTHER_HOMES]
    if os.environ.get("LOCALAPPDATA"):
        dbs.append(Path(os.environ["LOCALAPPDATA"]) / "opencode/opencode.db")
    for e in extra:
        dbs += [Path(p) for p in glob.glob(str(e / "**/opencode.db"), recursive=True)]
    return [p for p in dict.fromkeys(dbs) if p.is_file()]

def harness_roots(extra: list[Path]) -> list[tuple[Path, Path]]:
    """(VS Code data folder, home folder) pairs where VS Code's Agent Host keeps its chat list
    (User/globalStorage/agent-host.db) and per-chat data (agentSessionData/): VS Code server
    (WSL/SSH/containers), local VS Code on Linux/macOS/Windows, and Windows from WSL. The home folder
    is where that side's Claude and Codex logs are (~/.claude, ~/.codex)."""
    pairs = [(HOME / ".vscode-server/data", HOME), (HOME / ".vscode-server-insiders/data", HOME),
             (HOME / ".config/Code", HOME), (HOME / "Library/Application Support/Code", HOME)]
    if os.environ.get("APPDATA"):
        pairs.append((Path(os.environ["APPDATA"]) / "Code", HOME))
    for h in OTHER_HOMES:
        pairs += [(h / ".vscode-server/data", h), (h / ".vscode-server-insiders/data", h)]
    for u in glob.glob("/mnt/c/Users/*"):
        pairs.append((Path(u) / "AppData/Roaming/Code", Path(u)))
    for e in extra:
        for db in glob.glob(str(e / "**/globalStorage/agent-host.db"), recursive=True):
            data = Path(db).parent.parent.parent
            pairs.append((data, data.parent))
    seen, out = set(), []
    for data, home in pairs:
        try:
            found = (data / "User/globalStorage/agent-host.db").is_file()
        except OSError:                                    # another user's folder: not readable
            found = False
        if data not in seen and found:
            seen.add(data)
            out.append((data, home))
    return out


def read_text(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def read_table(db: Path, table: str) -> list[dict]:
    """Rows of a SQLite table, read from a copy (the app may be writing it); [] if unreadable."""
    tmp = tempfile.mkdtemp()
    try:
        for ext in ("", "-wal", "-shm"):
            if os.path.exists(str(db) + ext):
                shutil.copy(str(db) + ext, f"{tmp}/t.db{ext}")
        con = sqlite3.connect(f"{tmp}/t.db")
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(f"select * from {table}")]
        finally:
            con.close()
    except (sqlite3.Error, OSError):
        return []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

# ---------------------------------------------------------------- prices and cache lifetimes

PRICES: dict[str, dict] = {}   # model id -> token_prices (from the newest price sheet seen)
TTLS: dict[str, int] = {}      # model id -> seconds (learned from Copilot CLI)


def load_prices(roots: list[Path]) -> None:
    sheets = []
    for r in roots:
        sheets += glob.glob(str(r / "*/GitHub.copilot-chat/debug-logs/*/models.json"))
    for f in sorted(sheets, key=lambda p: os.path.getmtime(p)):   # newest last wins
        try:
            for m in json.load(open(f, encoding="utf-8")):
                tp = (m.get("billing") or {}).get("token_prices")
                if tp:
                    PRICES[m.get("id")] = tp
                    fam = (m.get("capabilities") or {}).get("family")
                    if fam:
                        PRICES.setdefault(fam, tp)
        except (OSError, ValueError):
            continue


def rates(model: str, ctx: int) -> dict | None:
    """Credits per token for this model at this prompt size (price tier by context), or None."""
    sheet = PRICES.get(model)
    if not sheet:
        return None
    batch = sheet.get("batch_size") or 0
    if not batch:
        return {"read": 0.0, "write": 0.0, "input": 0.0, "out": 0.0, "tier_max": None}
    tiers = sorted([t for t in sheet.values() if isinstance(t, dict)],
                   key=lambda t: t.get("max_prompt_tokens") or 1e18)
    t = next((x for x in tiers if ctx <= (x.get("max_prompt_tokens") or 1e18)), tiers[-1])
    return {"read": (t.get("cache_read_price") or 0) / batch,
            "write": (t.get("cache_write_price") or t.get("input_price") or 0) / batch,
            "input": (t.get("input_price") or 0) / batch,
            "out": (t.get("output_price") or 0) / batch,
            "tier_max": tiers[0].get("max_prompt_tokens") if len(tiers) > 1 else None}


MEASURED_TTLS: dict[str, int] = {}   # model id -> longest gap after which a Local chat still hit the cache
GUESS_TTL = 300        # what the extension's warnings assume for a model with no data
MEASURED_MARGIN = 60   # a measured gap counts once it beats the guess (or known value) by this much


def ttl_for(model: str, call_ttl: int | None = None) -> int | None:
    """A cache lifetime from data only: the call's own log (Claude's cache tier), Copilot CLI/SDK logs,
    what the Local debug logs prove (at least the known value), the known values (Claude, Sol 6.1).
    None for any other model: no expiry is judged without data."""
    if call_ttl:
        return call_ttl
    if model in TTLS:
        return TTLS[model]
    known = next((t for p, t in KNOWN_TTLS if (model or "").startswith(p)), None)
    # a measured gap is only a minimum: it counts once it beats the guess or the known value by a
    # margin, rounded down to the minute (the extension's rule)
    m = MEASURED_TTLS.get(model, 0)
    if m > (known or GUESS_TTL) + MEASURED_MARGIN:
        return m // 60 * 60
    return known


def learn_measured_ttls(calls: list[dict]) -> None:
    """Longest proven cache lifetime per model in Local chats' debug logs (the extension's provenGaps):
    the gap between a call and the previous call of the same model (any call of the chat refreshes the
    cache), when the cache still covered the chat's own conversation: at least 5k tokens of its own, at
    least 80% of them cached, and at least 90% of the previous prompt."""
    sessions = collections.defaultdict(list)
    for c in calls:
        if c["source"] == "vscode" and c["kind"] in ("agent", "side", "compaction"):
            sessions[c["session"]].append(c)
    for evs in sessions.values():
        evs.sort(key=lambda c: c["ts"])
        agent = [c for c in evs if c["kind"] == "agent"]
        if len(agent) < 2:
            continue
        base = agent[0]["ctx"] or 0
        for a0, a1 in zip(agent, agent[1:]):
            model = a1["model"]
            if not model or a0["model"] != model:
                continue
            prev, cached = a0["ctx"] or 0, a1["cached"] or 0
            own = prev - base
            if own < 5000 or cached < base + 0.8 * own or cached < 0.9 * prev:
                continue
            last = max([a0["ts"]] + [e["ts"] for e in evs if e["model"] == model and e["ts"] < a1["ts"]])
            gap = round((a1["ts"] - last) / 1000)
            if gap > MEASURED_TTLS.get(model, 0):
                MEASURED_TTLS[model] = gap


def estimate_credits(model: str, ctx: int, cached: int, written: int, out: int) -> float | None:
    r = rates(model, ctx)
    if r is None:
        return None
    fresh = max(0, ctx - cached - written)
    return cached * r["read"] + written * r["write"] + fresh * r["input"] + out * r["out"]

# ---------------------------------------------------------------- normalized records

def call(**kw) -> dict:
    base = dict(source="", session="", workspace="", ts=0, model="?", effort=None, ctx=0, cached=0,
                written=0, out=0, reasoning=0, credits=None, exact=False, kind="agent", user_msg=False)
    base.update(kw)
    return base


def uri_to_local_path(uri: str) -> Path | None:
    """file:///c%3A/Users/... -> a path readable here (Windows path, or /mnt/c/... from WSL)."""
    from urllib.parse import unquote, urlparse
    if not uri.startswith("file:"):
        return None
    path = unquote(urlparse(uri).path)
    m = re.match(r"^/([A-Za-z]):(/.*)$", path)
    if m:
        win = Path(f"{m.group(1)}:{m.group(2)}")
        wsl = Path(f"/mnt/{m.group(1).lower()}{m.group(2)}")
        return win if win.exists() else wsl
    return Path(path)


def folder_name(uri_or_path: str) -> str:
    from urllib.parse import unquote
    return unquote(str(uri_or_path)).rstrip("/\\").replace("\\", "/").split("/")[-1] or "?"


def workspace_labels(roots: list[Path]) -> dict[str, str]:
    """Workspace storage id -> readable name. A multi-folder workspace is named after its folders."""
    labels = {}
    for r in roots:
        for ws in glob.glob(str(r / "*/workspace.json")):
            try:
                j = json.load(open(ws, encoding="utf-8"))
            except (OSError, ValueError):
                continue
            wsid = Path(ws).parent.name
            if j.get("folder"):
                labels[wsid] = folder_name(j["folder"])
                continue
            uri = j.get("workspace") or ""
            label = None
            local = uri_to_local_path(uri)
            try:
                if local and local.exists():
                    # .code-workspace files may contain comments and trailing commas
                    text = re.sub(r"(?m)^\s*//.*$", "", local.read_text(encoding="utf-8", errors="ignore"))
                    text = re.sub(r",(\s*[}\]])", r"\1", text)
                    folders = [f.get("name") or folder_name(f.get("path") or f.get("uri") or "")
                               for f in json.loads(text).get("folders", [])]
                    if folders:
                        label = " + ".join(folders[:3]) + (f" +{len(folders) - 3}" if len(folders) > 3 else "")
            except (OSError, ValueError, AttributeError):
                pass
            if not label:
                name = folder_name(uri)
                if name == "workspace.json":
                    # untitled multi-folder workspace whose file VS Code deleted on close: its id is its creation time
                    wid = Path(uri).parent.name
                    when = dt.datetime.fromtimestamp(int(wid) / 1000).strftime("%Y-%m-%d") if wid.isdigit() else wid
                    label = f"untitled workspace (closed, {when})"
                else:
                    label = name.replace(".code-workspace", "")
            labels[wsid] = label
    return labels


def collect_vscode_debug(roots: list[Path], since_ms: int, labels: dict) -> tuple[list[dict], set]:
    calls, sessions = [], set()
    for r in roots:
        for d in glob.glob(str(r / "*/GitHub.copilot-chat/debug-logs/*/")):
            d = Path(d)
            main = d / "main.jsonl"
            if not main.exists() or main.stat().st_mtime * 1000 < since_ms:
                continue
            sid, ws = d.name, d.parent.parent.parent.name
            sessions.add(sid)
            mcp_frac = mcp_fraction(d)
            for f in d.glob("*.jsonl"):
                sub = f.name != "main.jsonl"
                for line in f.open(encoding="utf-8", errors="ignore"):
                    if '"llm_request"' not in line and '"user_message"' not in line:
                        continue
                    try:
                        o = json.loads(line)
                    except ValueError:
                        continue
                    if o.get("type") == "user_message" and not sub:
                        c = str((o.get("attrs") or {}).get("content", ""))
                        calls.append(call(source="vscode", session=sid, workspace=labels.get(ws, ws[:8]),
                                          ts=o.get("ts", 0), kind="message", user_msg=not c.startswith("[cache-keeper]")))
                        continue
                    if o.get("type") != "llm_request" or o.get("ts", 0) < since_ms:
                        continue
                    a = o.get("attrs") or {}
                    if "inputTokens" not in a:
                        continue
                    name = str(a.get("debugName", ""))
                    kind = ("subagent" if sub else "compaction" if "summarizeConversationHistory" in name
                            else "agent" if name.startswith("panel/") else "side")
                    try:
                        opts = json.loads(a.get("requestOptions") or "{}")
                    except ValueError:
                        opts = {}
                    effort = (opts.get("reasoning") or {}).get("effort") or (opts.get("output_config") or {}).get("effort")
                    calls.append(call(source="vscode", session=sid, workspace=labels.get(ws, ws[:8]), ts=o["ts"],
                                      model=a.get("model", "?"), effort=effort, ctx=a.get("inputTokens", 0),
                                      cached=a.get("cachedTokens", 0), out=a.get("outputTokens", 0),
                                      credits=(a.get("copilotUsageNanoAiu") or 0) / 1e9, exact=True, kind=kind,
                                      mcp_frac=mcp_frac))
    seen, unique = set(), []
    for c in calls:
        key = (c["session"], c["ts"], c["kind"], c["ctx"], c["out"])
        if key not in seen:
            seen.add(key)
            unique.append(c)
    return unique, sessions


def mcp_fraction(session_dir: Path) -> float | None:
    """Share of the tool definitions sent to the model that come from MCP servers (tools_*.json)."""
    for f in sorted(session_dir.glob("tools_*.json")):
        try:
            raw = json.load(open(f, encoding="utf-8"))
            tools = json.loads(raw["content"]) if isinstance(raw, dict) and "content" in raw else raw
            sizes = [(str(t.get("name") or (t.get("function") or {}).get("name", "")), len(json.dumps(t))) for t in tools]
            total = sum(n for _, n in sizes)
            return sum(n for name, n in sizes if name.startswith("mcp_")) / total if total else None
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
    return None


def turns_as_calls(turns: list[dict], covered: set) -> list[dict]:
    """Messages from chat session files whose chat has no debug log (older chats): one record per message."""
    out = []
    for t in turns:
        if t["session"] in covered or not t["complete"] or t["credits"] <= 0:
            continue
        out.append(call(source="vscode-messages", session=t["session"], workspace=t["workspace"], ts=t["ts"],
                        model=t["model"], effort=t["effort"], ctx=t["prompt"], out=t["out"], credits=t["credits"],
                        exact=True, kind="message-total", gap=t["gap"], ours=t["ours"], tool_share=t["tool_share"]))
    return out


CALLS_PER_MESSAGE: dict[str, float] = {}   # model -> median agent calls per message (from debug logs)


def learn_calls_per_message(calls: list[dict]) -> None:
    """Median number of agent calls each of your messages triggered, per model, where debug logs show it."""
    per = collections.defaultdict(list)
    sessions = collections.defaultdict(list)
    for c in calls:
        if c["source"] == "vscode" and c["kind"] in ("agent", "message"):
            sessions[c["session"]].append(c)
    for evs in sessions.values():
        evs.sort(key=lambda c: c["ts"])
        count, model = None, None
        for c in evs + [call(kind="message", user_msg=True)]:
            if c["kind"] == "message" and c["user_msg"]:
                if count and model:
                    per[model].append(count)
                count, model = 0, None
            elif c["kind"] == "agent" and count is not None:
                count += 1
                model = c["model"]
    for m, v in per.items():
        CALLS_PER_MESSAGE[m] = statistics.median(v)


def calls_per_message(c: dict) -> float:
    """Model calls inside one VS Code message: your own median for that model, else 8."""
    return CALLS_PER_MESSAGE.get(c["model"], statistics.median(CALLS_PER_MESSAGE.values()) if CALLS_PER_MESSAGE else 8.0)


def replay_requests(path: Path) -> list[dict]:
    """VS Code chat session files are an op log: rebuild the list of requests (one per message)."""
    reqs: list[dict] = []
    for line in path.open(encoding="utf-8", errors="ignore"):
        try:
            o = json.loads(line)
        except ValueError:
            continue
        k, v = o.get("k", []), o.get("v")
        if o.get("kind") == 0 and isinstance(v, dict):
            reqs = list(v.get("requests", []))
        elif k == ["requests"] and o.get("kind") == 2 and isinstance(v, list):
            reqs[o.get("i", len(reqs)):] = v
        elif len(k) == 3 and k[0] == "requests" and o.get("kind") == 1 and isinstance(k[1], int):
            while len(reqs) <= k[1]:
                reqs.append({})
            reqs[k[1]][k[2]] = v
    return reqs


def collect_vscode_turns(roots: list[Path], since_ms: int, labels: dict) -> list[dict]:
    """One record per message from chat session files (credits per message, settings, tool share).

    VS Code keeps copies of a chat's file under several workspace folders (e.g. when a folder
    becomes a multi-folder workspace). Copies are merged: each message counted once, taken from
    the most complete copy, named after a plain folder when there is one."""
    copies = collections.defaultdict(list)
    for r in roots:
        # and globalStorage/emptyWindowChatSessions: chats of windows with no folder open
        for f in glob.glob(str(r / "*/chatSessions/*.jsonl")) + glob.glob(str(r.parent / "globalStorage/emptyWindowChatSessions/*.jsonl")):
            copies[Path(f).stem].append(Path(f))
    turns = []
    for sid, files in copies.items():
        per_msg = {}
        def better(t, old):   # complete beats partial, then more credits
            return old is None or (t["complete"], t["credits"]) > (old["complete"], old["credits"])
        names = []
        for f in files:
            ws_name = ("(no folder)" if f.parent.name == "emptyWindowChatSessions"
                       else labels.get(f.parent.parent.name, f.parent.parent.name[:8]))
            names.append(ws_name)
            for t in session_turns(f, since_ms, ws_name):
                k = (t["ts"], t["turn"])
                if better(t, per_msg.get(k)):
                    per_msg[k] = t
        plain = [n for n in names if " + " not in n and not n.startswith("untitled workspace")]
        name = plain[0] if plain else names[0]
        for t in per_msg.values():
            t["workspace"] = name
            turns.append(t)
    return turns


def session_turns(f: Path, since_ms: int, ws_name: str) -> list[dict]:
    """The messages of one chat session file."""
    turns = []
    try:
        if f.stat().st_mtime * 1000 < since_ms:
            return []
        reqs = replay_requests(f)
    except OSError:
        return []
    prev_end = None
    for i, q in enumerate(reqs):
        ts = q.get("timestamp") or 0
        el = q.get("elapsedMs")
        cfg = q.get("modelConfiguration") or {}
        det = {d.get("label"): d.get("percentageOfPrompt") for d in (q.get("promptTokenDetails") or [])}
        msg = q.get("message") or {}
        text = msg.get("text", "") if isinstance(msg, dict) else ""
        if ts >= since_ms and q.get("copilotCredits") is not None:
            turns.append(dict(source="vscode-turn", session=f.stem, workspace=ws_name, ts=ts,
                              turn=i, model=str(q.get("modelId", "")).split("/")[-1],
                              effort=cfg.get("reasoningEffort"), ctx_setting=cfg.get("contextSize"),
                              credits=float(q.get("copilotCredits") or 0), prompt=int(q.get("promptTokens") or 0),
                              out=int(q.get("completionTokens") or 0), elapsed=el,
                              tool_share=(det.get("Tool Definitions") or 0) / 100,
                              ours=text.startswith("[cache-keeper]"),
                              gap=(ts - prev_end) / 1000 if ts and prev_end else None, complete=bool(el)))
        if ts and el:
            prev_end = ts + el
    return turns


def collect_cli(roots: list[Path], since_ms: int) -> tuple[list[dict], dict]:
    calls, compactions = [], collections.Counter()
    for r in roots:
        for f in glob.glob(str(r / "*/events.jsonl")):
            f = Path(f)
            try:
                if f.stat().st_mtime * 1000 < since_ms:
                    continue
            except OSError:
                continue
            sid, effort, cwd, nano_total, records = f.parent.name, None, "", None, []
            per_call_sum, per_call_known, last_compaction = 0.0, True, 0
            # a VS Code "Copilot" harness chat (Copilot SDK in VS Code's Agent Host), same log format
            src = "copilot-sdk" if "vscode-agent-host" in read_text(f.parent / "workspace.yaml") else "cli"
            for line in f.open(encoding="utf-8", errors="ignore"):
                if not any(k in line for k in ('"session.start"', '"session.usage_record"', 'cacheTtlSeconds',
                                               '"user.message"', 'compaction_complete', 'totalNanoAiu',
                                               '"reasoningEffort"')):
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                t, d = o.get("type", ""), o.get("data") or {}
                ts = int(dt.datetime.fromisoformat(o["timestamp"].replace("Z", "+00:00")).timestamp() * 1000) if o.get("timestamp") else 0
                for m in re.finditer(r'"modelId":"([^"]+)","cacheExpiresAt":"[^"]*","cacheTtlSeconds":(\d+)', line):
                    TTLS[m.group(1)] = int(m.group(2))
                # the effort in force: set at session start and on each model or effort change
                if isinstance(d.get("reasoningEffort"), str):
                    effort = d["reasoningEffort"]
                if t == "session.start":
                    cwd = ((d.get("context") or {}).get("cwd") or "") if isinstance(d.get("context"), dict) else ""
                elif t == "session.compaction_complete":
                    compactions[sid] += 1
                    last_compaction = ts
                elif t == "user.message" and ts >= since_ms:
                    records.append(call(source=src, session=sid, workspace=Path(cwd).name or sid[:8], ts=ts,
                                        kind="message", user_msg=True))
                elif t == "session.usage_record":
                    u = d.get("usage") or {}
                    nano = (u.get("copilotUsage") or {}).get("totalNanoAiu")
                    if nano is None:
                        per_call_known = False
                    else:
                        per_call_sum += nano / 1e9
                    if ts < since_ms:
                        continue
                    records.append(call(source=src, session=sid, workspace=Path(cwd).name or sid[:8], ts=ts,
                                        model=u.get("model", "?"), effort=effort, ctx=u.get("inputTokens", 0),
                                        cached=u.get("cacheReadTokens", 0), written=u.get("cacheWriteTokens", 0),
                                        out=u.get("outputTokens", 0), reasoning=u.get("reasoningTokens", 0),
                                        ttl=u.get("cacheTtlSeconds") or None,      # the call's own cache lifetime
                                        billed=nano / 1e9 if nano is not None else None,
                                        kind="agent" if u.get("initiator") in (None, "user", "agent") else "side"))
                elif "totalNanoAiu" in d:
                    nano_total = max(nano_total or 0, d.get("totalNanoAiu") or 0)
            est = []
            for c in records:
                if c["kind"] != "message":
                    billed = c.pop("billed", None)
                    if per_call_known and billed is not None:
                        c["credits"], c["exact"] = billed, True        # as billed, call by call
                    else:
                        c["credits"] = estimate_credits(c["model"], c["ctx"], c["cached"], c["written"], c["out"])
                        est.append(c)
                else:
                    c.pop("billed", None)
            # billed in the session's total but with no call of its own (a compaction's call): one more
            # record, a compaction when the session had one, else a side call
            if per_call_known and nano_total and nano_total / 1e9 > per_call_sum + 0.01:
                at = last_compaction or max([c["ts"] for c in records] or [0])
                if at >= since_ms:
                    model = next((c["model"] for c in sorted(records, key=lambda c: -c["ts"]) if c["kind"] != "message"), "?")
                    records.append(call(source=src, session=sid, workspace=Path(cwd).name or sid[:8], ts=at, model=model,
                                        credits=nano_total / 1e9 - per_call_sum, exact=True,
                                        kind="compaction" if last_compaction else "side"))
            # scale estimates to the session's exact total when the CLI reported one
            tot = sum(c["credits"] or 0 for c in est)
            if est and nano_total and tot > 0 and not per_call_known:
                k = nano_total / 1e9 / tot
                for c in est:
                    c["credits"] = (c["credits"] or 0) * k
                    c["exact"] = True
            calls += records
    return calls, compactions


def iso_ms(t: str | None) -> int:
    try:
        return int(dt.datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def json_or(v, default):
    try:
        return json.loads(v) if isinstance(v, str) else (v if v is not None else default)
    except ValueError:
        return default


def claude_calls(f: Path, sid: str, ws: str, since_ms: int) -> list[dict]:
    """A Claude harness log (~/.claude/projects/<folder>/<id>.jsonl): one record per model call,
    and one per message you typed."""
    starts, calls, out = {}, {}, []
    for line in f.open(encoding="utf-8", errors="ignore"):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        ts, m = iso_ms(e.get("timestamp")), e.get("message") if isinstance(e.get("message"), dict) else {}
        if e.get("type") == "api-request" and e.get("id"):
            starts[e["id"]] = ts
        elif e.get("type") == "user" and not e.get("isMeta") and not e.get("isCompactSummary") and ts >= since_ms:
            c = m.get("content")
            text = c if isinstance(c, str) else " ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text") \
                if isinstance(c, list) else ""
            tool = isinstance(c, list) and any(isinstance(p, dict) and p.get("type") == "tool_result" for p in c)
            if text.strip() and not tool and not re.match(r"\s*<(local-command|system-reminder)", text):
                out.append(call(source="claude-harness", session=sid, workspace=ws, ts=ts, kind="message", user_msg=True))
        elif e.get("type") == "assistant" and m.get("usage"):
            start = starts.get(e.get("requestRef"), ts)
            if start < since_ms:
                continue
            u, key = m["usage"], e.get("requestRef") or m.get("id") or ts
            written = u.get("cache_creation_input_tokens") or 0
            cc = u.get("cache_creation") or {}
            ttl = 3600 if (cc.get("ephemeral_1h_input_tokens") or 0) > 0 else 300 if (cc.get("ephemeral_5m_input_tokens") or 0) > 0 else None
            # Copilot's model ids use a dot: claude-opus-5-5 -> claude-opus-5.5
            model = re.sub(r"-(\d+)-(\d+)$", r"-\1.\2", m.get("model") or "?")
            calls[key] = call(source="claude-harness", session=sid, workspace=ws, ts=start, model=model,
                              ctx=(u.get("input_tokens") or 0) + written + (u.get("cache_read_input_tokens") or 0),
                              cached=u.get("cache_read_input_tokens") or 0, written=written, out=u.get("output_tokens") or 0,
                              ttl=ttl, kind="subagent" if e.get("isSidechain") else "agent")   # a streamed reply repeats: last wins
    return out + list(calls.values())


def codex_calls(f: Path, sid: str, ws: str, since_ms: int) -> list[dict]:
    """A Codex harness log (~/.codex/sessions/Y/M/D/rollout-*-<thread>.jsonl)."""
    out, model, last_input = [], "?", 0
    for line in f.open(encoding="utf-8", errors="ignore"):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        p, ts = e.get("payload") or {}, iso_ms(e.get("timestamp"))
        if e.get("type") == "turn_context":
            model = p.get("model") or model
        elif e.get("type") == "event_msg" and p.get("type") == "task_started":
            last_input = ts
        elif e.get("type") == "token_usage_record" and ts >= since_ms:
            u = p.get("usage") or {}
            out.append(call(source="codex-harness", session=sid, workspace=ws, ts=last_input or ts, model=model,
                            ctx=u.get("input_tokens") or 0, cached=u.get("cached_input_tokens") or 0,
                            written=u.get("cache_write_input_tokens") or 0, out=u.get("output_tokens") or 0,
                            reasoning=u.get("reasoning_output_tokens") or 0))
        elif e.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
            text = " ".join(x.get("text", "") for x in p.get("content") or [] if isinstance(x, dict)).strip()
            last_input = ts
            # Codex adds its own context blocks as user messages (<environment_context>, ...): not yours
            if text and not re.fullmatch(r"<[a-z_]+>[\s\S]*</[a-z_]+>", text) and ts >= since_ms:
                out.append(call(source="codex-harness", session=sid, workspace=ws, ts=ts, kind="message", user_msg=True))
        elif e.get("type") == "response_item" and str(p.get("type", "")).endswith("_call_output"):
            last_input = ts
    return out


def collect_harnesses(roots: list[tuple[Path, Path]], since_ms: int) -> list[dict]:
    """Claude and Codex chats run by VS Code's Agent Host and billed through Copilot. Only chats VS Code
    created (registration "explicit"): the Claude harness also lists your own Claude Code sessions
    ("discovery"), which Anthropic bills, not Copilot. Claude's estimates are scaled to the credits
    Copilot billed (session.db, turn_usage); Codex is computed from tokens at Copilot's prices."""
    calls = []
    for data, home in roots:
        for row in read_table(data / "User/globalStorage/agent-host.db", "sessions"):
            m = re.match(r"^(claude|codex):/+([^/?#]+)$", str(row.get("session_uri") or ""))
            if not m or row.get("registration_source") != "explicit" or int(row.get("modified_time") or 0) < since_ms:
                continue
            kind, vid = m.groups()
            sdb = data / "agentSessionData" / vid / "session.db"
            meta = {r["key"]: r["value"] for r in read_table(sdb, "session_metadata")}
            routed = (json_or(meta.get("claude.model"), {}) or {}).get("id", "") if kind == "claude" else meta.get("codex.model") or ""
            prov = re.match(r"^@provider=([^:]+):", routed or "")
            if prov and prov.group(1) not in ("copilot", "vscode-proxy"):
                continue                                   # billed to the user's own account
            if kind == "claude":
                link = (json_or(meta.get("defaultChatProviderData"), {}) or {}).get("sdkSessionId")
                cwd = ((json_or(meta.get("claude.workingDirectories"), []) or [""])[0]) or ""
                files = glob.glob(str(home / ".claude/projects" / "*" / f"{link}.jsonl")) if link else []
            else:
                link, cwd = meta.get("codex.threadId"), meta.get("codex.cwd") or ""
                files = glob.glob(str(home / ".codex/sessions" / "*" / "*" / "*" / f"rollout-*-{link}.jsonl")) if link else []
            if not files:
                continue
            ws = Path(re.sub(r"^[a-z-]+://[^/]*", "", str(cwd))).name or vid[:8]
            recs = (claude_calls if kind == "claude" else codex_calls)(Path(files[0]), vid, ws, since_ms)
            billed = sum(((json_or(r.get("usage"), {}) or {}).get("_meta") or {}).get("copilotUsage", {}).get("totalNanoAiu") or 0
                         for r in read_table(sdb, "turn_usage")) / 1e9
            est = [c for c in recs if c["kind"] != "message"]
            for c in est:
                c["credits"] = estimate_credits(c["model"], c["ctx"], c["cached"], c["written"], c["out"])
            tot = sum(c["credits"] or 0 for c in est)
            if billed and tot > 0:                         # scale to what Copilot billed for this chat
                for c in est:
                    c["credits"], c["exact"] = (c["credits"] or 0) * billed / tot, True
            calls += recs
    return calls


def collect_opencode(dbs: list[Path], since_ms: int) -> list[dict]:
    calls = []
    for db in dbs:
        tmp = tempfile.mkdtemp()
        try:
            for ext in ("", "-wal", "-shm"):          # copy: the app may be writing it
                if os.path.exists(str(db) + ext):
                    shutil.copy(str(db) + ext, f"{tmp}/o.db{ext}")
            con = sqlite3.connect(f"{tmp}/o.db")
            rows = con.execute("select m.session_id, s.directory, s.parent_id, m.type, m.data from session_message m "
                               "join session_v2 s on s.id = m.session_id where m.type in ('user','assistant')").fetchall()
        except sqlite3.Error:
            rows = []
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        for sid, directory, parent, typ, data in rows:
            try:
                m = json.loads(data)
            except ValueError:
                continue
            ts = (m.get("time") or {}).get("created") or 0
            if ts < since_ms:
                continue
            ws = Path(directory or "").name or sid[:8]
            if typ == "user":
                calls.append(call(source="opencode", session=parent or sid, workspace=ws, ts=ts, kind="message", user_msg=True))
                continue
            tok = m.get("tokens") or {}
            cache = tok.get("cache") or {}
            model = (m.get("model") or {}).get("id", "?")
            calls.append(call(source="opencode", session=parent or sid, workspace=ws, ts=ts, model=model,
                              effort=(m.get("model") or {}).get("variant"),
                              ctx=(tok.get("input") or 0) + (cache.get("read") or 0) + (cache.get("write") or 0),
                              cached=cache.get("read") or 0, written=cache.get("write") or 0,
                              out=(tok.get("output") or 0) + (tok.get("reasoning") or 0), reasoning=tok.get("reasoning") or 0,
                              credits=(m.get("cost") or 0) * 100, exact=True, kind="subagent" if parent else "agent"))
    return calls

# ---------------------------------------------------------------- analysis

def fmt(x: float) -> str:
    return f"{x:,.0f}" if abs(x) >= 100 else f"{x:,.1f}"


def analyze(calls: list[dict], turns: list[dict], cli_compactions: dict) -> dict:
    model_calls = [c for c in calls if c["kind"] != "message" and c["credits"] is not None]
    msgs = [c for c in model_calls if c["kind"] == "message-total"]       # older VS Code chats, per message
    agent = [c for c in model_calls if c["kind"] == "agent"]
    total = sum(c["credits"] for c in model_calls)
    by_session = collections.defaultdict(list)
    for c in sorted(calls, key=lambda c: c["ts"]):
        by_session[(c["source"], c["session"])].append(c)

    # 1. expired caches and other misses
    misses = []
    for key, evs in by_session.items():
        prev = None
        for c in evs:
            if c["kind"] == "message":
                continue
            if c["kind"] not in ("agent", "compaction"):
                continue
            if prev is not None and c["ctx"] >= MISS_MIN_CTX and c["cached"] / max(c["ctx"], 1) < MISS_CACHED_BELOW:
                gap = (c["ts"] - prev["ts"]) / 1000
                r = rates(c["model"], c["ctx"])
                lost = max(0, c["ctx"] - c["cached"] - TYPICAL_NEW)
                extra = lost * ((r["write"] or r["input"]) - r["read"]) if r else 0.0
                ttl = ttl_for(c["model"], c.get("ttl"))
                cause = ("expired after a pause" if ttl and gap >= ttl - 5 else
                         "compaction / changed prompt" if ttl else "unknown cache lifetime")
                misses.append(dict(c, gap=gap, extra=extra, cause=cause))
            prev = c
    for c in msgs:
        ttl = ttl_for(c["model"])
        if ttl and c.get("gap") is not None and not c.get("ours") and c["ctx"] >= MISS_MIN_CTX and c["gap"] >= ttl:
            r = rates(c["model"], c["ctx"])
            extra = max(0, c["ctx"] - TYPICAL_NEW) * ((r["write"] or r["input"]) - r["read"]) if r else 0.0
            misses.append(dict(c, extra=extra, cause="expired after a pause"))
    expired = [m for m in misses if m["cause"].startswith("expired")]

    # 2. reasoning effort: extra output vs the same model's cheapest effort level
    eff = collections.defaultdict(list)
    for c in model_calls:
        if c["kind"] in ("agent", "message-total") and c["effort"]:
            unit = "" if c["kind"] == "agent" else " (per message)"
            eff[(c["model"] + unit, c["effort"])].append(c)
    effort_rows, effort_extra = [], 0.0
    order = {"low": 0, "medium": 1, "high": 2, "xhigh": 3, "max": 4}
    for model in {m for m, _ in eff}:
        levels = sorted([e for m, e in eff if m == model], key=lambda e: order.get(e, 9))
        base = statistics.median([c["out"] for c in eff[(model, levels[0])]]) if levels else 0
        for e in levels:
            cs = eff[(model, e)]
            out_med = statistics.median([c["out"] for c in cs])
            r = rates(model.replace(" (per message)", ""), 0)
            extra = sum(max(0, c["out"] - base) for c in cs) * r["out"] if (r and order.get(e, 0) >= 3 and e != levels[0]) else 0.0
            effort_extra += extra
            effort_rows.append(dict(model=model, effort=e, calls=len(cs), credits=sum(c["credits"] for c in cs),
                                    out_median=out_med, per_call=sum(c["credits"] for c in cs) / len(cs), extra=extra))

    # 3. context: credits by size, re-reading big contexts, long-context price tier
    buckets = [(0, 50e3, "<50k"), (50e3, 100e3, "50-100k"), (100e3, 200e3, "100-200k"),
               (200e3, 272e3, "200-272k"), (272e3, 400e3, "272-400k"), (400e3, 1e12, ">400k")]
    ctx_rows = []
    for lo, hi, label in buckets:
        cs = [c for c in model_calls if c["kind"] == "agent" and lo <= c["ctx"] < hi]
        if cs:
            ctx_rows.append(dict(bucket=label, calls=len(cs), credits=sum(c["credits"] for c in cs),
                                 per_call=sum(c["credits"] for c in cs) / len(cs)))
    big_extra, tier_extra, mcp_extra = 0.0, 0.0, 0.0
    shares = [t["tool_share"] for t in turns if t.get("tool_share")]
    default_share = statistics.median(shares) if shares else 0.45
    share_by_session = collections.defaultdict(list)
    for t in turns:
        if t.get("tool_share"):
            share_by_session[t["session"]].append(t["tool_share"])
    fracs = [c["mcp_frac"] for c in agent if c.get("mcp_frac") is not None]
    default_frac = statistics.median(fracs) if fracs else 0.0
    for c in agent + msgs:
        r = rates(c["model"], c["ctx"])
        if not r:
            continue
        per_msg = c["kind"] != "agent"
        n = calls_per_message(c) if per_msg else 1.0
        # a per-message estimate can never exceed what the message actually cost
        cap = (lambda x, share: min(x, c["credits"] * share)) if per_msg else (lambda x, share: x)
        if c["ctx"] > BIG_CTX:
            big_extra += cap((c["ctx"] - BIG_CTX) * r["read"] * n, (c["ctx"] - BIG_CTX) / c["ctx"])
        if r["tier_max"] and c["ctx"] > r["tier_max"]:
            base = rates(c["model"], 0)
            ratio = 1 - base["read"] / r["read"] if r["read"] else 0
            tier_extra += cap(c["ctx"] * (r["read"] - base["read"]) * n + c["out"] * (r["out"] - base["out"]), ratio)
        if c["source"].startswith("vscode"):
            share = statistics.mean(share_by_session[c["session"]]) if share_by_session.get(c["session"]) else \
                (c.get("tool_share") or default_share)
            frac = c.get("mcp_frac") if c.get("mcp_frac") is not None else default_frac
            mcp_extra += cap(c["ctx"] * share * frac * r["read"] * n, share * frac)

    # 4. compactions, subagents, side calls
    comp = [c for c in model_calls if c["kind"] == "compaction"]
    sub = [c for c in model_calls if c["kind"] == "subagent"]
    side = [c for c in model_calls if c["kind"] == "side"]

    # 5. per-message view (VS Code chat session files): settings and tool definitions
    setting_rows = []
    t_ok = [t for t in turns if t["complete"] and t["credits"] > 0]
    for key in sorted({(t["model"], t["ctx_setting"]) for t in t_ok}, key=str):
        ts = [t for t in t_ok if (t["model"], t["ctx_setting"]) == key]
        setting_rows.append(dict(model=key[0], setting=key[1], turns=len(ts), credits=sum(t["credits"] for t in ts),
                                 median=statistics.median([t["credits"] for t in ts]),
                                 max_prompt=max(t["prompt"] for t in ts)))
    pause = collections.defaultdict(list)
    for t in t_ok:
        if t["gap"] is not None and t["prompt"] > 20_000 and not t["ours"]:
            ttl = ttl_for(t["model"])
            if not ttl:
                continue                       # no data on this model's cache lifetime
            kind = "pause longer than the cache lifetime" if t["gap"] >= ttl else "within the cache lifetime"
            pause[(t["model"], kind)].append(t["credits"] / (t["prompt"] / 1e5))

    # 6. sessions
    sess = []
    for (src, sid), evs in by_session.items():
        mc = [c for c in evs if c["kind"] != "message" and c["credits"] is not None]
        if not mc:
            continue
        sm = [m for m in misses if m["session"] == sid]
        sess.append(dict(source=src, session=sid, workspace=evs[0]["workspace"], start=evs[0]["ts"], calls=len(mc),
                         credits=sum(c["credits"] for c in mc), max_ctx=max(c["ctx"] for c in mc),
                         misses=len(sm), miss_extra=sum(m["extra"] for m in sm),
                         models=", ".join(sorted({c["model"] for c in mc})),
                         efforts=", ".join(sorted({str(c["effort"]) for c in mc if c["effort"]})),
                         compactions=len([c for c in mc if c["kind"] == "compaction"]) + cli_compactions.get(sid, 0)))
    sess.sort(key=lambda s: -s["credits"])

    factors = [
        ("Expired caches after pauses", sum(m["extra"] for m in expired),
         f"{len(expired)} calls re-sent their whole context after a pause longer than the cache lifetime "
         "(Claude 5 min, Sol 6.1 30 min).",
         "Reply within the cache lifetime, keep the cache warm with a short message, or start a new chat with a "
         "summary after a long break (Copilot Cache Keeper automates this in VS Code)."),
        ("Large context re-read on every call", big_extra,
         f"Context above {BIG_CTX // 1000}k tokens is re-read, at the cache price, by every model call.",
         "Start new chats per task; use a smaller context-size setting (e.g. 200K for Claude) so compaction happens "
         "earlier; keep project knowledge in AGENTS.md / memory files instead of long histories."),
        ("Max / xhigh reasoning effort", effort_extra,
         "Output (incl. reasoning) beyond what the same model writes at its lowest effort you used.",
         "Use High or Medium by default; switch to Max only for hard problems."),
        ("Long-context price tier", tier_extra,
         "Calls above a model's base tier (e.g. Sol 6.1 above 272k) pay roughly double.",
         "Keep the context-size setting at the base tier (272K for Sol) so it compacts before crossing it."),
        ("MCP tool definitions sent with every call", mcp_extra,
         f"MCP tools (e.g. Pylance, GitLab) are {100 * default_frac:.0f}% of the tool definitions VS Code sends, and tool "
         f"definitions are ~{100 * default_share:.0f}% of each prompt; they are re-read with every call, used or not.",
         "Turn off MCP servers and tool sets you don't use in the chat's tools picker."),
        ("Compactions", sum(c["credits"] for c in comp),
         f"{len(comp)} history summarizations (VS Code) plus {sum(cli_compactions.values())} in Copilot CLI.",
         "Mostly a symptom of long sessions: start new chats per task."),
        ("Other cache misses", sum(m["extra"] for m in misses if not m["cause"].startswith("expired")),
         "Misses not explained by a pause: after compaction, or a changed prompt (mode, model, tools switched).",
         "Avoid switching mode/model/tools mid-chat; they invalidate the cache."),
        ("Subagents and side calls", sum(c["credits"] for c in sub + side),
         f"{len(sub)} subagent calls, {len(side)} side calls (titles, summaries, checks).",
         "Usually small; check if a cheap subagent model is configured."),
    ]
    factors.sort(key=lambda f: -f[1])
    return dict(total=total, calls=model_calls, misses=misses, expired=expired, effort_rows=effort_rows,
                unpriced=[c for c in calls if c["kind"] != "message" and c["credits"] is None],
                mcp_frac=default_frac, tool_share=default_share,
                ctx_rows=ctx_rows, setting_rows=setting_rows, pause=pause, sessions=sess, factors=factors,
                comp=comp, turns=t_ok)


def report(a: dict, calls: list[dict], days: int, sources: dict) -> str:
    L = []
    w = L.append
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    w(f"# Agent spend report ({now}, last {days} days)\n")
    w("Credits: 1 credit = $0.01. " + ", ".join(f"{k}: {v}" for k, v in sources.items()) + ".\n")
    mc = a["calls"]
    if a["unpriced"]:
        models = ", ".join(sorted({c["model"] for c in a["unpriced"]}))
        w(f"**Warning:** Credits are unknown for {len(a['unpriced'])} model calls ({models}). "
                "These calls are excluded from spending totals; cost and savings estimates are incomplete. "
                "Model prices may be missing on this machine. Use `--input DIR` with VS Code logs containing "
                "a matching `workspaceStorage/.../GitHub.copilot-chat/debug-logs/.../models.json` price sheet.\n")
    w(f"**Total: {fmt(a['total'])} credits** (${a['total'] / 100:,.2f}) over {len(mc)} model calls "
      f"in {len(a['sessions'])} sessions.\n")

    w("## What drove the spend (estimated avoidable credits)\n")
    w("| # | Factor | Avoidable credits | Share of total | What it is | What to do |")
    w("|---|---|---:|---:|---|---|")
    for i, (name, val, what, todo) in enumerate(a["factors"], 1):
        w(f"| {i} | {name} | {fmt(val)} | {100 * val / max(a['total'], 1e-9):.0f}% | {what} | {todo} |")
    w("\nFactors overlap (an expired cache on a big context counts in both), so don't add them up.\n")

    w("## By tool and model\n")
    w("`vscode` = Agent Debug Logs, one row per model call. `vscode-messages` = older chats that only have chat "
      "session files, one row per message (a message usually triggers several model calls).\n")
    w("| Tool | Model | Calls / messages | Credits | Credits each | Median context | Cached |")
    w("|---|---|---:|---:|---:|---:|---:|")
    g = collections.defaultdict(list)
    for c in mc:
        g[(c["source"], c["model"])].append(c)
    for (src, model), cs in sorted(g.items(), key=lambda kv: -sum(c["credits"] for c in kv[1])):
        cr = sum(c["credits"] for c in cs)
        ctx = sum(c["ctx"] for c in cs)
        w(f"| {src} | {model} | {len(cs)} | {fmt(cr)} | {cr / len(cs):.2f} | "
          f"{statistics.median([c['ctx'] for c in cs]) / 1000:.0f}k | "
          + ("- |" if src == "vscode-messages" else f"{100 * sum(c['cached'] for c in cs) / max(ctx, 1):.0f}% |"))

    w("\n## Cache misses\n")
    if a["misses"]:
        ex = a["expired"]
        w(f"{len(a['misses'])} calls over {MISS_MIN_CTX // 1000}k context had less than half their prompt cached; "
          f"{len(ex)} came after a pause longer than the cache lifetime.\n")
        w("| When | Tool | Workspace | Model | Context | Cached | Pause | Credits | Extra vs cached | Cause |")
        w("|---|---|---|---|---:|---:|---:|---:|---:|---|")
        for m in sorted(a["misses"], key=lambda m: -m["extra"])[:15]:
            credits = f"{m['credits']:.1f}" if m["credits"] is not None else "unknown"
            extra = f"{m['extra']:.1f}" if rates(m["model"], m["ctx"]) is not None else "unknown"
            w(f"| {dt.datetime.fromtimestamp(m['ts'] / 1000):%m-%d %H:%M} | {m['source']} | {m['workspace']} | {m['model']} | "
              f"{m['ctx'] / 1000:.0f}k | {100 * m['cached'] / max(m['ctx'], 1):.0f}% | {m['gap'] / 60:.0f} min | "
              f"{credits} | {extra} | {m['cause']} |")
    else:
        w("None found.\n")

    w("\n## Reasoning effort\n")
    if a["effort_rows"]:
        w("| Model | Effort | Calls | Credits | Credits / call | Median output tokens | Extra vs lowest effort |")
        w("|---|---|---:|---:|---:|---:|---:|")
        for r in sorted(a["effort_rows"], key=lambda r: (r["model"], r["effort"])):
            w(f"| {r['model']} | {r['effort']} | {r['calls']} | {fmt(r['credits'])} | {r['per_call']:.2f} | "
              f"{r['out_median']:.0f} | {fmt(r['extra'])} |")
    w("\n## Context size\n")
    w("| Context at the call | Agent calls | Credits | Credits / call |")
    w("|---|---:|---:|---:|")
    for r in a["ctx_rows"]:
        w(f"| {r['bucket']} | {r['calls']} | {fmt(r['credits'])} | {r['per_call']:.2f} |")
    if a["setting_rows"]:
        w("\n**VS Code context-size setting** (per message, from chat session files):\n")
        w("| Model | Setting | Messages | Credits | Median credits / message | Largest prompt |")
        w("|---|---|---:|---:|---:|---:|")
        for r in a["setting_rows"]:
            w(f"| {r['model']} | {r['setting'] or '-'} | {r['turns']} | {fmt(r['credits'])} | {r['median']:.1f} | "
              f"{r['max_prompt'] / 1000:.0f}k |")
    if a["pause"]:
        w("\n**Pauses** (VS Code, per message, normalised to 100k context):\n")
        w("| Model | Before the message | Messages | Median credits per 100k context |")
        w("|---|---|---:|---:|")
        for (model, kind), v in sorted(a["pause"].items()):
            w(f"| {model} | {kind} | {len(v)} | {statistics.median(v):.1f} |")

    w("\n## Most expensive sessions\n")
    w("| Start | Tool | Workspace | Models | Effort | Calls | Max context | Compactions | Misses (extra) | Credits |")
    w("|---|---|---|---|---|---:|---:|---:|---|---:|")
    for s in a["sessions"][:15]:
        w(f"| {dt.datetime.fromtimestamp(s['start'] / 1000):%m-%d %H:%M} | {s['source']} | {s['workspace']} | {s['models']} | "
          f"{s['efforts'] or '-'} | {s['calls']} | {s['max_ctx'] / 1000:.0f}k | {s['compactions']} | "
          f"{s['misses']} ({fmt(s['miss_extra'])}) | {fmt(s['credits'])} |")
    w("\n## Method\n")
    w(f"- Miss: a model call with at least {MISS_MIN_CTX // 1000}k tokens of context and less than "
      f"{int(MISS_CACHED_BELOW * 100)}% of it cached, not the first call of its session. \"Expired after a pause\" "
      "means the gap since the previous call in that session was at least the model's cache lifetime "
      "(from data only: the call's log, Copilot CLI/SDK logs, the longest gap after which a Local chat still hit the "
      "cache, once longer than 5 min" + (f" ({', '.join(f'{m} ≥{ttl_for(m)}s' for m in sorted(MEASURED_TTLS) if m not in TTLS and ttl_for(m) and ttl_for(m) >= GUESS_TTL + MEASURED_MARGIN)})" if MEASURED_TTLS else "") +
      f", else {', '.join(f'{p} {t}s' for p, t in KNOWN_TTLS)}; other models with no data: not judged). "
      "Extra = uncached tokens × (write/input price − cache-read price).")
    w("- Effort: extra output tokens vs the median output of the same model at the lowest effort you used, priced at "
      "the output rate; only counted for xhigh/max.")
    w(f"- Large context: tokens above {BIG_CTX // 1000}k × cache-read price, per agent call.")
    w("- Older VS Code chats only have per-message records. For those, the number of model calls per message is "
      "your own median for that model, measured in the chats that do have debug logs ("
      + ", ".join(f"{m} {v:g}" for m, v in sorted(CALLS_PER_MESSAGE.items())) + "), and no estimate may exceed "
      "what the message actually cost.")
    w(f"- MCP tools: share of the tool list sent to the model that comes from MCP servers (measured per chat from "
      f"the debug logs, median {100 * a['mcp_frac']:.0f}%) × share of the prompt that is tool definitions (from "
      f"VS Code's prompt breakdown, median {100 * a['tool_share']:.0f}%) × context × cache-read price, per call.")
    w("- Prices: the newest price sheet Copilot sent to VS Code (models.json in the Agent Debug Logs). VS Code debug "
      "logs give exact credits; Copilot CLI/SDK give credits per call, plus what their session total adds beyond the calls (else scaled to that total); OpenCode uses its own cost.")
    return "\n".join(L) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--input", type=Path, action="append", default=[], help="extra folder to search (repeatable)")
    ap.add_argument("--out", type=Path, default=None, help="report path (default ./spend-report-<date>.md)")
    ap.add_argument("--json", type=Path, default=None, help="also write every normalized call to this file")
    args = ap.parse_args()
    since = int((dt.datetime.now() - dt.timedelta(days=args.days)).timestamp() * 1000)

    roots = vscode_storage_roots(args.input)
    load_prices(roots)
    labels = workspace_labels(roots)
    vs_calls, debug_sessions = collect_vscode_debug(roots, since, labels)
    turns = collect_vscode_turns(roots, since, labels)
    cli_calls, cli_comp = collect_cli(cli_roots(args.input), since)
    oc_calls = collect_opencode(opencode_dbs(args.input), since)
    h_calls = collect_harnesses(harness_roots(args.input), since)
    msg_calls = turns_as_calls(turns, debug_sessions)
    learn_calls_per_message(vs_calls)
    learn_measured_ttls(vs_calls)
    calls = vs_calls + msg_calls + cli_calls + oc_calls + h_calls
    n = lambda cs: len([c for c in cs if c["kind"] != "message"])
    sources = {"VS Code debug logs": f"{n(vs_calls)} calls",
               "VS Code chat sessions": f"{len(turns)} messages ({len(msg_calls)} from chats without debug logs)",
               "Copilot CLI": f"{n([c for c in cli_calls if c['source'] == 'cli'])} calls",
               "VS Code Copilot SDK chats": f"{n([c for c in cli_calls if c['source'] == 'copilot-sdk'])} calls",
               "VS Code Claude chats": f"{n([c for c in h_calls if c['source'] == 'claude-harness'])} calls",
               "VS Code Codex chats": f"{n([c for c in h_calls if c['source'] == 'codex-harness'])} calls",
               "OpenCode": f"{n(oc_calls)} calls"}
    print("Found: " + ", ".join(f"{k} {v}" for k, v in sources.items()), file=sys.stderr)
    if not n(calls):
        sys.exit("No agent logs with usage found in the period.")

    a = analyze(calls, turns, cli_comp)
    if a["unpriced"]:
        models = ", ".join(sorted({c["model"] for c in a["unpriced"]}))
        print(f"Warning: credits unknown for {len(a['unpriced'])} model calls ({models}); "
              "spending totals exclude them and savings estimates are incomplete. "
              "Use --input DIR with VS Code debug logs containing a matching models.json price sheet.",
              file=sys.stderr)
    text = report(a, calls, args.days, sources)
    out = args.out or Path(f"spend-report-{dt.date.today()}.md")
    out.write_text(text, encoding="utf-8")
    if args.json:
        args.json.write_text(json.dumps(calls, indent=1), encoding="utf-8")

    print(f"\nTotal {fmt(a['total'])} credits (${a['total'] / 100:,.2f}), {len(a['calls'])} model calls\n")
    print("What drove the spend (estimated avoidable credits; factors overlap):")
    for i, (name, val, _what, todo) in enumerate(a["factors"], 1):
        print(f"  {i}. {name:<38} {fmt(val):>8}  {100 * val / max(a['total'], 1e-9):3.0f}%   -> {todo.split(';')[0]}")
    print(f"\nFull report: {out.resolve()}")


if __name__ == "__main__":
    main()
