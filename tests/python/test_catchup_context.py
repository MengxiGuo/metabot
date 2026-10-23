from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).parents[2] / "src" / "skills" / "catchup" / "scripts" / "catchup_context.py"
SPEC = importlib.util.spec_from_file_location("catchup_context", SCRIPT)
assert SPEC and SPEC.loader
catchup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catchup)


def record(date: str, msg_id: str, text: str) -> dict[str, str]:
    return {
        "ts": f"{date}T12:00:00+08:00",
        "dir": "in",
        "msg_id": msg_id,
        "user_id": "user-test",
        "text": text,
    }


class CatchupCoverageTests(unittest.TestCase):
    def test_auto_routes_recent_to_mac_and_cold_to_3060(self) -> None:
        dates = ["2026-07-08", "2026-08-21", "2026-08-22"]
        local_files = [Path(f"/archive/chat/{dates[2]}.jsonl")]
        local_records = [record(dates[2], "local", "from-local")]
        mac_records = [record(dates[1], "mac", "from-mac")]
        node_records = [record(dates[0], "node", "from-3060")]
        original_partition = catchup.partition_dates_by_mac_retention

        def fixed_partition(stems: list[str], retention_days: int):
            return original_partition(
                stems,
                retention_days,
                today=date(2026, 8, 22),
            )

        argv = [
            "catchup_context.py",
            "--chat-id",
            "oc_test",
            "--source",
            "auto",
            "--days",
            "3",
            "--mode",
            "recent",
            "--max-lines",
            "20",
        ]
        with (
            patch.object(catchup, "date_stems", return_value=dates),
            patch.object(catchup, "partition_dates_by_mac_retention", side_effect=fixed_partition),
            patch.object(catchup, "archive_files", return_value=local_files),
            patch.object(catchup, "load_records", return_value=local_records),
            patch.object(
                catchup,
                "load_mac_records_with_diagnostics",
                return_value=(
                    mac_records,
                    {
                        "error": "",
                        "files": 1,
                        "dates": [dates[1]],
                        "attempts": 1,
                        "health_status": "not_checked",
                    },
                ),
            ) as load_mac,
            patch.object(
                catchup,
                "load_3060_records",
                return_value=(node_records, {"error": "", "files": 1, "dates": [dates[0]]}),
            ) as load_3060,
            patch.object(sys, "argv", argv),
        ):
            output = io.StringIO()
            with redirect_stdout(output):
                rc = catchup.main()

        text = output.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("source: mixed(local,mac,3060)", text)
        self.assertIn("source_files: local=1,mac=1,3060=1", text)
        self.assertIn("routing_status: complete", text)
        self.assertIn("Mac-missing-within-retention", text)
        self.assertIn(f"covered_dates: {','.join(dates)}", text)
        self.assertIn("missing_dates: _none_", text)
        self.assertEqual(text.count("from-local"), 1)
        self.assertEqual(text.count("from-mac"), 1)
        self.assertEqual(text.count("from-3060"), 1)
        self.assertEqual(load_mac.call_args.args[1], dates[1:2])
        self.assertEqual(load_3060.call_args.args[1], dates[:1])

    def test_recent_missing_file_does_not_query_3060(self) -> None:
        dates = ["2026-08-20", "2026-08-21", "2026-08-22"]
        argv = [
            "catchup_context.py",
            "--chat-id",
            "oc_test",
            "--source",
            "auto",
            "--days",
            "3",
            "--mac-retention-days",
            "36500",
            "--mode",
            "recent",
        ]
        with (
            patch.object(catchup, "date_stems", return_value=dates),
            patch.object(
                catchup,
                "archive_files",
                return_value=[Path(f"/archive/chat/{dates[2]}.jsonl")],
            ),
            patch.object(
                catchup,
                "load_records",
                return_value=[record(dates[2], "local", "latest")],
            ),
            patch.object(
                catchup,
                "load_mac_records_with_diagnostics",
                return_value=(
                    [],
                    {
                        "error": "",
                        "files": 0,
                        "dates": [],
                        "attempts": 1,
                        "health_status": "not_checked",
                    },
                ),
            ),
            patch.object(catchup, "load_3060_records") as load_3060,
            patch.object(sys, "argv", argv),
        ):
            output = io.StringIO()
            with redirect_stdout(output):
                catchup.main()

        text = output.getvalue()
        self.assertIn(f"missing_dates: {dates[0]},{dates[1]}", text)
        self.assertIn(f"recent_missing_dates: {dates[0]},{dates[1]}", text)
        self.assertIn("recent_blocked_dates: _none_", text)
        self.assertIn("routing_status: partial_recent_missing", text)
        load_3060.assert_not_called()

    def test_recent_mac_error_blocks_without_querying_3060(self) -> None:
        dates = ["2026-08-20", "2026-08-21", "2026-08-22"]
        argv = [
            "catchup_context.py",
            "--chat-id",
            "oc_test",
            "--days",
            "3",
            "--mac-retention-days",
            "36500",
        ]
        with (
            patch.object(catchup, "date_stems", return_value=dates),
            patch.object(catchup, "archive_files", return_value=[]),
            patch.object(
                catchup,
                "load_mac_records_with_diagnostics",
                return_value=(
                    [],
                    {
                        "error": "query timeout",
                        "files": 0,
                        "dates": [],
                        "attempts": 1,
                        "health_status": "unreachable",
                        "health_ready_routes": 0,
                    },
                ),
            ),
            patch.object(catchup, "load_3060_records") as load_3060,
            patch.object(sys, "argv", argv),
        ):
            output = io.StringIO()
            with redirect_stdout(output):
                catchup.main()

        text = output.getvalue()
        self.assertIn("routing_status: blocked_recent_mac_unavailable", text)
        self.assertIn(f"recent_blocked_dates: {','.join(dates)}", text)
        self.assertIn("mac_health: unreachable", text)
        self.assertIn("do not query 3060", text)
        load_3060.assert_not_called()

    def test_partition_uses_inclusive_45_day_mac_window(self) -> None:
        cutoff, mac_dates, cold_dates = catchup.partition_dates_by_mac_retention(
            ["2026-07-08", "2026-07-09", "2026-08-22", "invalid"],
            45,
            today=date(2026, 8, 22),
        )
        self.assertEqual(cutoff, "2026-07-09")
        self.assertEqual(mac_dates, ["2026-07-09", "2026-08-22", "invalid"])
        self.assertEqual(cold_dates, ["2026-07-08"])

    def test_mac_error_health_ready_retries_once(self) -> None:
        rows = [record("2026-08-22", "mac", "recovered")]
        with (
            patch.object(
                catchup,
                "load_mac_records",
                side_effect=[
                    ([], {"error": "timeout", "files": 0, "dates": []}),
                    (rows, {"error": "", "files": 1, "dates": ["2026-08-22"]}),
                ],
            ) as query,
            patch.object(
                catchup,
                "check_mac_health",
                return_value={"status": "degraded", "ready_routes": 1, "error": ""},
            ) as health,
        ):
            records, info = catchup.load_mac_records_with_diagnostics(
                "oc_test", ["2026-08-22"], 10, 75, 25, 200, 65536
            )

        self.assertEqual(records, rows)
        self.assertEqual(info["attempts"], 2)
        self.assertEqual(info["health_status"], "degraded")
        self.assertEqual(query.call_count, 2)
        health.assert_called_once_with(25)

    def test_mac_unreachable_does_not_retry_query(self) -> None:
        with (
            patch.object(
                catchup,
                "load_mac_records",
                return_value=([], {"error": "timeout", "files": 0, "dates": []}),
            ) as query,
            patch.object(
                catchup,
                "check_mac_health",
                return_value={"status": "unreachable", "ready_routes": 0, "error": ""},
            ),
        ):
            _, info = catchup.load_mac_records_with_diagnostics(
                "oc_test", ["2026-08-22"], 10, 75, 25, 200, 65536
            )

        self.assertEqual(info["attempts"], 1)
        self.assertEqual(query.call_count, 1)

    def test_remote_commands_search_historical_snapshots_per_date(self) -> None:
        dates = ["2026-08-20", "2026-08-21"]
        mac_command = catchup.mac_remote_command("oc_test", dates, 100, 1048576)
        node_command = catchup.archive_3060_remote_command("oc_test", dates, 100, 1048576)

        self.assertIn("for d in 2026-08-20 2026-08-21", mac_command)
        self.assertIn("sort -r", mac_command)
        self.assertNotIn("backups/latest", mac_command)
        self.assertIn("python3 -c", mac_command)
        self.assertNotIn('tail -c "$tail_bytes"', mac_command)
        self.assertIn("for d in 2026-08-20 2026-08-21", node_command)
        self.assertIn("sort -r", node_command)

    def test_merge_drops_only_exact_duplicates(self) -> None:
        shared = record("2026-08-20", "same", "same")
        distinct = record("2026-08-20", "other", "same")
        merged = catchup.merge_record_sets([[shared], [shared.copy(), distinct]], 10)
        self.assertEqual(len(merged), 2)

    def test_large_card_body_is_compacted_before_retention(self) -> None:
        large = record("2026-08-20", "large", "")
        large.pop("text")
        large["card_full"] = "x" * 1_000_000
        loaded = catchup.load_records_from_iter(iter([large]), 10)
        self.assertEqual(len(loaded), 1)
        self.assertLessEqual(len(loaded[0]["text"]), catchup.MAX_STORED_BODY_CHARS)

    def test_remote_decode_replaces_truncated_utf8_prefix(self) -> None:
        valid = json.dumps(record("2026-08-20", "valid", "message"), ensure_ascii=False)
        proc = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=f"\ufffdbroken\n{valid}\n",
            stderr=(
                "__CATCHUP_DATE__2026-08-20\n"
                "__CATCHUP_FILE__/snapshot/chat/2026-08-20.jsonl\n"
                "__CATCHUP_ROOT__/snapshot/messages\n"
            ),
        )
        with patch.object(catchup.subprocess, "run", return_value=proc) as run:
            records, info = catchup.load_mac_records(
                "oc_test",
                ["2026-08-20"],
                10,
                10,
                10,
                65536,
            )

        self.assertEqual(len(records), 1)
        self.assertEqual(info["dates"], ["2026-08-20"])
        self.assertEqual(run.call_args.kwargs["errors"], "replace")
        self.assertEqual(run.call_args.args[0][0:2], ["ssh-home-mac", "--read-only"])
        self.assertIn("--command-timeout", run.call_args.args[0])

    def test_remote_compactor_emits_bounded_complete_json(self) -> None:
        large = record("2026-08-20", "large", "中文" * 100_000)
        proc = subprocess.run(
            [sys.executable, "-c", catchup.REMOTE_COMPACT_CODE, "65536"],
            input=json.dumps(large, ensure_ascii=False) + "\n",
            capture_output=True,
            text=True,
            check=True,
        )
        compact = json.loads(proc.stdout)
        self.assertEqual(compact["msg_id"], "large")
        self.assertLessEqual(len(compact["text"]), catchup.MAX_STORED_BODY_CHARS)
        self.assertLessEqual(len(proc.stdout.encode("utf-8")), 65536)

    def test_remote_compactor_collapses_streaming_card_frames(self) -> None:
        first = {
            "ts": "2026-08-20T12:00:00+08:00",
            "dir": "out",
            "bot_name": "bot-test",
            "msg_id": "same-card",
            "text": "partial",
        }
        final = {**first, "ts": "2026-08-20T12:00:01+08:00", "text": "final"}
        proc = subprocess.run(
            [sys.executable, "-c", catchup.REMOTE_COMPACT_CODE, "65536"],
            input="\n".join(json.dumps(item) for item in (first, final)) + "\n",
            capture_output=True,
            text=True,
            check=True,
        )
        rows = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["text"], "final")

    def test_default_mode_is_recent_for_session_recovery(self) -> None:
        dates = ["2026-08-22"]
        argv = ["catchup_context.py", "--chat-id", "oc_test", "--days", "1"]
        with (
            patch.object(catchup, "date_stems", return_value=dates),
            patch.object(
                catchup,
                "archive_files",
                return_value=[Path("/archive/chat/2026-08-22.jsonl")],
            ),
            patch.object(
                catchup,
                "load_records",
                return_value=[record(dates[0], "message", "history")],
            ),
            patch.object(sys, "argv", argv),
        ):
            output = io.StringIO()
            with redirect_stdout(output):
                catchup.main()

        self.assertIn("mode: recent", output.getvalue())
        self.assertIn("Mac is the only historical tier", output.getvalue())
        self.assertIn("history", output.getvalue())


if __name__ == "__main__":
    unittest.main()
