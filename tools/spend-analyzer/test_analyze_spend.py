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


if __name__ == "__main__":
    unittest.main()