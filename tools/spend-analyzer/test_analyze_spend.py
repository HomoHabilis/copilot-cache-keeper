import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import analyze_spend as spend


class MissingPricesTests(unittest.TestCase):
    def setUp(self):
        prices = spend.PRICES.copy()
        spend.PRICES.clear()
        self.addCleanup(spend.PRICES.update, prices)
        self.addCleanup(spend.PRICES.clear)
        # these made-up models get a cache lifetime as if a log stated it (a model with no data gets
        # none: see LifetimeTests)
        ttls = spend.TTLS.copy()
        spend.TTLS.update({"unknown-model": 300, "priced-model": 300})
        self.addCleanup(spend.TTLS.update, ttls)
        self.addCleanup(spend.TTLS.clear)
        self.calls = [
            spend.call(source="copilot-sdk", session="remote-sdk", workspace="remote",
                       ts=1_000_000 + offset, model="unknown-model", ctx=80_000,
                       cached=0, out=100)
            for offset in (0, 600_000)
        ]

    def test_unpriced_cache_miss_is_reported_without_crashing(self):
        analysis = spend.analyze(self.calls, [], {})
        text = spend.report(analysis, self.calls, 60, {})

        self.assertEqual(len(analysis["misses"]), 1)
        self.assertEqual(analysis["unpriced"], self.calls)
        self.assertIn("Credits are unknown for 2 model calls (unknown-model)", text)
        self.assertIn("excluded from spending totals", text)
        self.assertIn("--input DIR", text)
        self.assertIn("| unknown | unknown | expired after a pause |", text)

    def test_mixed_calls_preserve_known_totals_and_zero_credits(self):
        spend.PRICES["priced-model"] = {
            "batch_size": 1_000_000,
            "default": {"input_price": 100, "cache_read_price": 10},
        }
        priced = [dict(record, session="priced-sdk", model="priced-model", credits=credits)
                  for record, credits in zip(self.calls, (3.0, 0.0))]
        calls = self.calls + priced
        analysis = spend.analyze(calls, [], {})
        text = spend.report(analysis, calls, 60, {})

        self.assertEqual(analysis["total"], 3.0)
        self.assertEqual(len(analysis["calls"]), 2)
        self.assertEqual(len(analysis["unpriced"]), 2)
        self.assertIn("| 0.0 | 7.1 | expired after a pause |", text)

    def test_fully_priced_calls_do_not_warn(self):
        calls = [dict(record, credits=2.0) for record in self.calls]
        analysis = spend.analyze(calls, [], {})
        text = spend.report(analysis, calls, 60, {})

        self.assertEqual(analysis["total"], 4.0)
        self.assertEqual(analysis["unpriced"], [])
        self.assertNotIn("**Warning:**", text)
        self.assertIn("| 2.0 | unknown | expired after a pause |", text)

    def test_main_warns_and_writes_report_for_sdk_only_logs(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            output = Path(directory) / "report.md"
            stack.enter_context(mock.patch.object(spend.sys, "argv", ["analyze_spend.py", "--out", str(output)]))
            for name in ("vscode_storage_roots", "cli_roots", "opencode_dbs", "harness_roots",
                         "collect_vscode_turns", "collect_opencode", "collect_harnesses"):
                stack.enter_context(mock.patch.object(spend, name, return_value=[]))
            stack.enter_context(mock.patch.object(spend, "collect_vscode_debug", return_value=([], set())))
            stack.enter_context(mock.patch.object(spend, "collect_cli", return_value=(self.calls, {})))
            stderr = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

            spend.main()

            self.assertIn("credits unknown for 2 model calls", stderr.getvalue())
            self.assertIn("VS Code Copilot SDK chats 2 calls", stderr.getvalue())
            self.assertIn("| unknown | unknown |", output.read_text(encoding="utf-8"))


class LifetimeTests(unittest.TestCase):
    """Cache lifetimes from data only: logged, measured, known; none for a model without data."""

    def setUp(self):
        for d in (spend.TTLS, spend.MEASURED_TTLS):
            saved = d.copy()
            d.clear()
            self.addCleanup(d.update, saved)
            self.addCleanup(d.clear)

    def test_known_models_and_no_guess_for_others(self):
        self.assertEqual(spend.ttl_for("claude-opus-5.5"), 300)
        self.assertEqual(spend.ttl_for("gpt-6.1-sol"), 1800)
        self.assertIsNone(spend.ttl_for("gpt-5.6-luna"))
        self.assertEqual(spend.ttl_for("gpt-5.6-luna", 3600), 3600, "the call's own log wins")

    def test_lifetime_measured_in_local_logs(self):
        # the second call still hits the cache 1140 s after the first: at least 1140 s
        calls = [spend.call(source="vscode", session="s", ts=0, model="gpt-5.6-luna", ctx=20_000, cached=0),
                 spend.call(source="vscode", session="s", ts=60_000, model="gpt-5.6-luna", ctx=30_000, cached=19_000),
                 spend.call(source="vscode", session="s", ts=1_200_000, model="gpt-5.6-luna", ctx=31_000, cached=30_000)]
        spend.learn_measured_ttls(calls)
        self.assertEqual(spend.ttl_for("gpt-5.6-luna"), 1140)

    def test_short_measured_gap_is_not_a_lifetime(self):
        # a hit after 74 s only proves at least 74 s: not enough to judge expiries
        spend.MEASURED_TTLS["gpt-6-astra"] = 74
        self.assertIsNone(spend.ttl_for("gpt-6-astra"))

    def test_miss_without_lifetime_data_is_not_called_expired(self):
        calls = [spend.call(source="vscode", session="s", ts=t, model="new-model", ctx=80_000, cached=0, credits=1.0)
                 for t in (0, 3_600_000)]
        analysis = spend.analyze(calls, [], {})
        self.assertEqual(analysis["misses"][0]["cause"], "unknown cache lifetime")
        self.assertEqual(analysis["expired"], [])


class SessionTotalTests(unittest.TestCase):
    def test_sdk_total_beyond_its_calls_is_a_compaction(self):
        import json as _json
        lines = [
            {"type": "session.start", "timestamp": "2026-11-11T10:00:00Z", "data": {"reasoningEffort": "high"}},
            {"type": "session.usage_record", "timestamp": "2026-11-11T10:01:00Z", "data": {"usage": {
                "model": "gpt-6.1-sol", "inputTokens": 20000, "cacheReadTokens": 0, "outputTokens": 10,
                "copilotUsage": {"totalNanoAiu": 4e9}}}},
            {"type": "session.compaction_complete", "timestamp": "2026-11-11T10:02:00Z", "data": {}},
            {"type": "session.usage_checkpoint", "timestamp": "2026-11-11T10:03:00Z", "data": {"totalNanoAiu": 12e9}},
        ]
        with tempfile.TemporaryDirectory() as d:
            sess = Path(d) / "s1"
            sess.mkdir()
            (sess / "events.jsonl").write_text("\n".join(_json.dumps(x) for x in lines) + "\n", encoding="utf-8")
            (sess / "workspace.yaml").write_text("client_name: vscode-agent-host\n", encoding="utf-8")
            calls, _ = spend.collect_cli([Path(d)], 0)
        billed = [c for c in calls if c["kind"] != "message"]
        self.assertEqual(sum(c["credits"] for c in billed), 12)
        self.assertEqual([c["credits"] for c in billed if c["kind"] == "agent"], [4], "the call as billed, not scaled")
        self.assertEqual([c["credits"] for c in billed if c["kind"] == "compaction"], [8])


class ChatFileTests(unittest.TestCase):
    def test_chats_of_windows_with_no_folder_are_read(self):
        import json as _json
        req = {"timestamp": 1_800_000_000_000, "message": {"text": "No folder"}, "modelId": "copilot/claude-opus-5.5",
               "promptTokens": 50_000, "completionTokens": 200, "elapsedMs": 20_000, "copilotCredits": 30}
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d) / "User/workspaceStorage"
            ws.mkdir(parents=True)
            empty = Path(d) / "User/globalStorage/emptyWindowChatSessions"
            empty.mkdir(parents=True)
            (empty / "empty.jsonl").write_text("\n".join(_json.dumps(x) for x in [
                {"kind": 0, "v": {"requests": []}}, {"kind": 2, "k": ["requests"], "v": [req]}]) + "\n", encoding="utf-8")
            turns = spend.collect_vscode_turns([ws], 0, {})
        msgs = spend.turns_as_calls(turns, set())
        self.assertEqual([(c["session"], c["workspace"], c["credits"]) for c in msgs], [("empty", "(no folder)", 30.0)])

OPUS = {"batch_size": 1_000_000, "default": {"input_price": 400, "cache_read_price": 20, "cache_write_price": 500,
                                             "output_price": 2000}}


def message(ts, ctx, credits, rounds, out=0, **kw):
    """One message of an older chat: its calls end at `rounds` (s after it was sent)."""
    ends = [ts + r * 1000 for r in rounds]
    return spend.call(source="vscode-messages", session="old", ts=ts, model="claude-opus-5.5", ctx=ctx, out=out,
                      credits=credits, kind="message-total", rounds=ends, nrounds=len(ends), end=ends[-1],
                      ours=bool(kw.get("own")), **kw)


class BillCheckedExpiryTests(unittest.TestCase):
    """Older chats (a record per message): a cold send is read from the bill, not guessed from the pause."""

    def setUp(self):
        prices = spend.PRICES.copy()
        spend.PRICES.clear()
        spend.PRICES["claude-opus-5.5"] = OPUS
        self.addCleanup(spend.PRICES.update, prices)
        self.addCleanup(spend.PRICES.clear)
        m = 60_000
        warm = lambda ctx: ctx * 20e-6            # one call reading its whole prompt from the cache
        cold = lambda ctx: ctx * 500e-6           # ... writing it all again
        self.msgs = [
            message(0, 200_000, 100, [10]),                                   # the chat's first message
            message(20 * m, 200_000, warm(200_000), [10]),                    # 20 min later, but billed warm: no expiry
            message(21 * m, 200_000, 2 * warm(200_000), [10, 20]),            # warm
            message(31 * m, 200_000, cold(200_000), [10]),                    # 10 min later, billed a full re-send
            message(32 * m, 200_000, warm(200_000) + cold(200_000), [10, 500]),   # the agent waited 8 min in the turn
            message(42 * m, 200_000, warm(200_000), [10], own="keepalive"),   # Cache Keeper's own: not judged
        ]

    def test_cold_sends_follow_the_bill(self):
        a = spend.analyze(self.msgs, [], {})
        self.assertEqual([(m["ts"] // 60_000, m["cause"]) for m in a["misses"]],
                         [(31, "expired after a pause"), (32, "expired while the agent waited")])
        for m in a["misses"]:
            self.assertAlmostEqual(m["extra"], 200_000 * 480e-6, delta=5)
            self.assertLessEqual(m["extra"], m["credits"], "never more than the message was billed")
        names = [f[0] for f in a["factors"]]
        self.assertIn("Expired caches while the agent waited", names)

    def test_what_if_keeps_the_pause_warm_but_not_the_agents_wait(self):
        a = spend.analyze(self.msgs, [], {})
        wi = a["whatif"]
        self.assertEqual(len(wi["rows"]), 1)
        self.assertAlmostEqual(wi["cold_pause"], 92, delta=6)
        self.assertAlmostEqual(wi["cold_wait"], 92, delta=6)
        # the 10 min pause takes 2 keep-alives (a read of 200k each): about 92 - 8 saved; the wait is not saved
        self.assertAlmostEqual(wi["keeper"], 84, delta=6)
        self.assertIn("## What Cache Keeper and shorter chats would have saved", spend.report(a, self.msgs, 60, {}))

    def test_a_pause_past_the_keep_warm_limit_is_not_counted_as_saved(self):
        late = [dict(m) for m in self.msgs[:3]] + [message(4 * 3_600_000, 200_000, 100, [10])]
        a = spend.analyze(late, [], {})
        self.assertEqual([m["cause"] for m in a["misses"]], ["expired after a pause"])
        self.assertEqual(a["whatif"]["keeper"], 0)


class OwnMessageTests(unittest.TestCase):
    def test_keep_alives_and_summaries_are_recognised(self):
        self.assertEqual(spend.own_kind(" Stepping away for a few minutes. Just reply OK, no tools needed. "), "keepalive")
        self.assertEqual(spend.own_kind("[summary] I'm pausing and this chat's cache will expire"), "other")
        self.assertEqual(spend.own_kind("/compact keep the goal"), "other")
        self.assertEqual(spend.own_kind("[cache-keeper] keep-alive, reply OK"), "keepalive")
        self.assertIsNone(spend.own_kind("Stepping away, please continue the refactoring"))

    def test_same_lists_as_the_extension(self):
        core = Path(__file__).resolve().parents[2] / "core.js"
        if not core.exists():
            self.skipTest("core.js is not next to this helper")
        text = core.read_text(encoding="utf-8")
        block = text[text.index("const KEEPALIVES_BY_LANG"):text.index("const KEEPALIVE_SET")]
        import json as _json
        wordings = {_json.loads(x) for x in __import__("re").findall(r'^\s+("(?:[^"\\]|\\.)*"),\s*$', block, flags=8)}
        self.assertEqual(wordings, spend.KEEPALIVES, "copy core.js's keep-alive wordings into KEEPALIVES")
        tags = set(__import__("re").findall(r'"(\[[^"\]]+\])"', text[text.index("const SUMMARY_TAGS"):text.index("const COMPACT_COMMAND")]))
        self.assertTrue(tags and tags <= set(spend.OWN_PREFIXES))

    def test_kept_warm_counts_what_the_keep_alives_avoided(self):
        prices = spend.PRICES.copy()
        spend.PRICES.clear()
        spend.PRICES["claude-opus-5.5"] = OPUS
        self.addCleanup(spend.PRICES.update, prices)
        self.addCleanup(spend.PRICES.clear)
        m = 60_000
        msgs = [message(0, 200_000, 100, [10]),
                message(285_000, 200_000, 4.0, [5], own="keepalive"),
                message(570_000, 200_000, 4.0, [5], own="keepalive"),
                message(12 * m, 200_000, 4.0, [5])]                      # back after 12 min, on a warm cache
        k = spend.analyze(msgs, [], {})["kept"]
        self.assertEqual((k["pings"], k["avoided"]), (2, 1))
        self.assertAlmostEqual(k["spent"], 8.0)
        self.assertAlmostEqual(k["avoided_credits"], 199_000 * 0.955 * 480e-6, places=3)


if __name__ == "__main__":
    unittest.main()