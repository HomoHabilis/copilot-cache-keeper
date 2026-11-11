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


if __name__ == "__main__":
    unittest.main()