#!/usr/bin/env python3
"""Extract recent MetaBot chat context through SG, Mac, and 3060 archives."""

# Applied lessons: MEMORY-002, OPS-076, OPS-077, OPS-079, OPS-081, OPS-082.

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
from collections import deque
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


CST = timezone(timedelta(hours=8))
DEFAULT_ARCHIVE_ROOT = Path("/root/metabot/data/messages")
MAX_STORED_BODY_CHARS = 4000
REMOTE_COMPACT_CODE = """import json, sys
budget = int(sys.argv[1])
records = []
for raw in sys.stdin:
    try:
        record = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        continue
    if not isinstance(record, dict):
        continue
    compact = {
        key: record[key]
        for key in ("ts", "dir", "bot_name", "msg_id", "user_id", "type")
        if key in record
    }
    body = record.get("text") or record.get("card_summary") or record.get("card_full") or ""
    if isinstance(body, str) and body:
        compact["text"] = " ".join(body[:4000].split())
    records.append(compact)
by_msg = {}
passthrough = []
for record in records:
    msg_id = record.get("msg_id")
    if record.get("dir") == "out" and isinstance(msg_id, str):
        by_msg[msg_id] = record
    else:
        passthrough.append(record)
records = passthrough + list(by_msg.values())
records.sort(key=lambda record: str(record.get("ts") or ""))
payloads = [
    json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\\n"
    for record in records
]
selected = []
used = 0
for payload in reversed(payloads):
    size = len(payload.encode("utf-8"))
    if selected and used + size > budget:
        break
    if size > budget:
        continue
    selected.append(payload)
    used += size
sys.stdout.write("".join(reversed(selected)))
"""


def safe_chat_id(chat_id: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", chat_id)


def remote_compact_command(bytes_per_file: int) -> str:
    return f"python3 -c {shlex.quote(REMOTE_COMPACT_CODE)} {max(bytes_per_file, 65536)}"


def date_stems(days: int) -> list[str]:
    today = datetime.now(CST).date()
    return [
        (today - timedelta(days=i)).isoformat()
        for i in range(max(days, 1) - 1, -1, -1)
    ]


def partition_dates_by_mac_retention(
    dates: Iterable[str],
    retention_days: int,
    today: date | None = None,
) -> tuple[str, list[str], list[str]]:
    """Assign dates to Mac hot history or 3060 cold history.

    Invalid date stems fail closed into the Mac tier so they can never leak to
    3060 through an availability fallback.
    """
    effective_today = today or datetime.now(CST).date()
    cutoff = effective_today - timedelta(days=max(retention_days, 1) - 1)
    mac_dates: list[str] = []
    cold_dates: list[str] = []
    for stem in dates:
        try:
            parsed = date.fromisoformat(stem)
        except ValueError:
            mac_dates.append(stem)
            continue
        if parsed >= cutoff:
            mac_dates.append(stem)
        else:
            cold_dates.append(stem)
    return cutoff.isoformat(), mac_dates, cold_dates


def archive_files(archive_root: Path, chat_id: str, days: int) -> list[Path]:
    chat_dir = archive_root / safe_chat_id(chat_id)
    if not chat_dir.exists():
        return []

    wanted = set(date_stems(days))

    files: list[Path] = []
    for fp in chat_dir.glob("*.jsonl"):
        if fp.stem in wanted:
            files.append(fp)
    return sorted(files)


def iter_jsonl(files: Iterable[Path]) -> Iterable[dict[str, Any]]:
    for fp in files:
        try:
            with fp.open("r", encoding="utf-8") as f:
                yield from iter_jsonl_lines(f)
        except OSError:
            continue


def iter_jsonl_lines(lines: Iterable[str]) -> Iterable[dict[str, Any]]:
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            yield obj


def body_of(record: dict[str, Any], max_chars: int | None = None) -> str:
    body = (
        record.get("text")
        or record.get("card_summary")
        or record.get("card_full")
        or ""
    )
    if isinstance(body, str):
        if max_chars is not None and len(body) > max_chars:
            body = body[:max_chars]
        return " ".join(body.split())
    return ""


def compact_record(record: dict[str, Any]) -> dict[str, Any]:
    compact = {
        key: record[key]
        for key in ("ts", "dir", "bot_name", "msg_id", "user_id", "type")
        if key in record
    }
    body = body_of(record, MAX_STORED_BODY_CHARS)
    if body:
        compact["text"] = body
    return compact


def is_meaningful(record: dict[str, Any]) -> bool:
    body = body_of(record)
    record_type = record.get("type")
    if not body and record_type not in {"image", "file"}:
        return False
    if record.get("dir") == "out":
        if body == "_Thinking..._":
            return False
        if body.startswith("✅ Done ("):
            return False
    return True


def collapse_out(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_msg: dict[str, dict[str, Any]] = {}
    passthrough: list[dict[str, Any]] = []
    for record in records:
        if record.get("dir") == "out" and isinstance(record.get("msg_id"), str):
            by_msg[record["msg_id"]] = record
        else:
            passthrough.append(record)

    merged = passthrough + list(by_msg.values())
    merged.sort(key=lambda r: str(r.get("ts") or ""))
    return merged


def load_records_from_iter(records: Iterable[dict[str, Any]], max_records: int) -> list[dict[str, Any]]:
    kept: deque[dict[str, Any]] = deque(maxlen=max_records)
    for record in records:
        kept.append(compact_record(record))
    return [r for r in collapse_out(list(kept)) if is_meaningful(r)]


def load_records(files: list[Path], max_records: int) -> list[dict[str, Any]]:
    return load_records_from_iter(iter_jsonl(files), max_records)


def merge_record_sets(
    record_sets: Iterable[Iterable[dict[str, Any]]],
    max_records: int,
) -> list[dict[str, Any]]:
    """Merge source records chronologically while dropping exact duplicates."""
    unique: dict[str, dict[str, Any]] = {}
    for records in record_sets:
        for record in records:
            key = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            unique[key] = record

    merged = collapse_out(list(unique.values()))
    merged = [record for record in merged if is_meaningful(record)]
    if len(merged) > max_records:
        merged = merged[-max_records:]
    return merged


def mac_remote_command(
    chat_id: str,
    dates: Iterable[str],
    lines_per_file: int,
    bytes_per_file: int,
) -> str:
    chat = shlex.quote(safe_chat_id(chat_id))
    dates_shell = " ".join(shlex.quote(d) for d in dates)
    tail_lines = max(lines_per_file, 1)
    tail_bytes = max(bytes_per_file, 65536)
    compact_command = remote_compact_command(tail_bytes)
    return f"""set -eu
chat={chat}
tail_lines={tail_lines}
tail_bytes={tail_bytes}
base="$HOME/sg_archive/backups"
if [ ! -d "$base" ]; then
  exit 5
fi
count=0
for d in {dates_shell}; do
  found=""
  root=""
  for snapshot in $(find "$base" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' | sort -r); do
    for candidate in \\
      "$snapshot/root/metabot/data/messages" \\
      "$snapshot/root/root/metabot/data/messages"; do
      f="$candidate/$chat/$d.jsonl"
      if [ -f "$f" ]; then
        found="$f"
        root="$candidate"
        break 2
      fi
    done
  done
  if [ -z "$found" ]; then
    continue
  fi
  count=$((count + 1))
  printf '__CATCHUP_DATE__%s\\n' "$d" >&2
  printf '__CATCHUP_FILE__%s\\n' "$found" >&2
  printf '__CATCHUP_ROOT__%s\\n' "$root" >&2
  tail -n "$tail_lines" "$found" | {compact_command}
  printf '\\n'
done
if [ "$count" -eq 0 ]; then
  exit 6
fi
"""


def load_mac_records(
    chat_id: str,
    dates: Iterable[str],
    max_records: int,
    timeout: int,
    remote_lines_per_file: int,
    remote_bytes_per_file: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cmd = mac_remote_command(
        chat_id,
        dates,
        remote_lines_per_file,
        remote_bytes_per_file,
    )
    try:
        command_timeout = max(5, min(timeout - 5, 60))
        proc = subprocess.run(
            [
                "ssh-home-mac",
                "--read-only",
                "--command-timeout",
                str(command_timeout),
                "sh -c " + shlex.quote(cmd),
            ],
            check=False,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        return [], {"error": str(err), "files": 0, "root": "", "dates": []}

    root = ""
    found_files: set[str] = set()
    found_dates: list[str] = []
    for line in proc.stderr.splitlines():
        if line.startswith("__CATCHUP_ROOT__"):
            root = line.removeprefix("__CATCHUP_ROOT__")
        elif line.startswith("__CATCHUP_FILE__"):
            found_files.add(line.removeprefix("__CATCHUP_FILE__"))
        elif line.startswith("__CATCHUP_DATE__"):
            found_dates.append(line.removeprefix("__CATCHUP_DATE__"))

    files = len(found_files)
    found_dates = list(dict.fromkeys(found_dates))

    if proc.returncode != 0:
        if proc.returncode == 6:
            return [], {"error": "", "files": 0, "root": root, "dates": []}
        err = proc.stderr.strip() or f"ssh-home-mac returned {proc.returncode}"
        return [], {"error": err, "files": files, "root": root, "dates": found_dates}

    records = load_records_from_iter(iter_jsonl_lines(proc.stdout.splitlines()), max_records)
    return records, {"error": "", "files": files, "root": root, "dates": found_dates}


def check_mac_health(timeout: int) -> dict[str, Any]:
    """Run the canonical two-route Mac health probe exactly once."""
    try:
        proc = subprocess.run(
            ["ssh-home-mac", "--health"],
            check=False,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=max(timeout, 1),
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        return {"status": "unreachable", "ready_routes": 0, "error": str(err)}

    status = "unknown"
    ready_routes = 0
    for line in reversed(proc.stdout.splitlines()):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        candidate = payload.get("status")
        if candidate in {"ready", "degraded", "unreachable"}:
            status = candidate
            ready_routes = int(payload.get("ready_routes") or 0)
            break

    if status == "unknown" and proc.returncode == 255:
        status = "unreachable"
    error = ""
    if status not in {"ready", "degraded"}:
        error = (proc.stderr.strip() or f"ssh-home-mac --health returned {proc.returncode}")[:1000]
    return {"status": status, "ready_routes": ready_routes, "error": error}


def load_mac_records_with_diagnostics(
    chat_id: str,
    dates: Iterable[str],
    max_records: int,
    timeout: int,
    health_timeout: int,
    remote_lines_per_file: int,
    remote_bytes_per_file: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Query Mac, then health-check and retry once only after a query error."""
    requested_dates = list(dates)
    records, info = load_mac_records(
        chat_id,
        requested_dates,
        max_records,
        timeout,
        remote_lines_per_file,
        remote_bytes_per_file,
    )
    result = dict(info)
    result.update({"attempts": 1, "health_status": "not_checked", "health_ready_routes": 0})
    initial_error = str(result.get("error") or "")
    if not initial_error:
        return records, result

    health = check_mac_health(health_timeout)
    result.update(
        {
            "health_status": str(health.get("status") or "unknown"),
            "health_ready_routes": int(health.get("ready_routes") or 0),
            "health_error": str(health.get("error") or ""),
            "initial_error": initial_error,
        }
    )
    if result["health_status"] not in {"ready", "degraded"}:
        return records, result

    retry_records, retry_info = load_mac_records(
        chat_id,
        requested_dates,
        max_records,
        timeout,
        remote_lines_per_file,
        remote_bytes_per_file,
    )
    result = dict(retry_info)
    result.update(
        {
            "attempts": 2,
            "health_status": str(health.get("status") or "unknown"),
            "health_ready_routes": int(health.get("ready_routes") or 0),
            "health_error": str(health.get("error") or ""),
            "initial_error": initial_error,
        }
    )
    return retry_records, result


def archive_3060_remote_command(
    chat_id: str,
    dates: Iterable[str],
    lines_per_file: int,
    bytes_per_file: int,
) -> str:
    chat = shlex.quote(safe_chat_id(chat_id))
    dates_shell = " ".join(shlex.quote(d) for d in dates)
    tail_lines = max(lines_per_file, 1)
    tail_bytes = max(bytes_per_file, 65536)
    compact_command = remote_compact_command(tail_bytes)
    return f"""set -eu
chat={chat}
tail_lines={tail_lines}
tail_bytes={tail_bytes}
base=/mnt/nvme/sg_archive/source_snapshots
if [ ! -d "$base" ]; then
  exit 5
fi
count=0
for d in {dates_shell}; do
  found=""
  root=""
  for snapshot in $(find "$base" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' | sort -r); do
    for candidate in \\
      "$snapshot/root/metabot/data/messages" \\
      "$snapshot/root/root/metabot/data/messages"; do
      f="$candidate/$chat/$d.jsonl"
      if [ -f "$f" ]; then
        found="$f"
        root="$candidate"
        break 2
      fi
    done
  done
  if [ -z "$found" ]; then
    continue
  fi
  count=$((count + 1))
  printf '__CATCHUP_DATE__%s\\n' "$d" >&2
  printf '__CATCHUP_FILE__%s\\n' "$found" >&2
  printf '__CATCHUP_ROOT__%s\\n' "$root" >&2
  tail -n "$tail_lines" "$found" | {compact_command}
  printf '\\n'
done
if [ "$count" -eq 0 ]; then
  exit 6
fi
"""


def load_3060_records(
    chat_id: str,
    dates: Iterable[str],
    max_records: int,
    timeout: int,
    remote_lines_per_file: int,
    remote_bytes_per_file: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cmd = archive_3060_remote_command(
        chat_id,
        dates,
        remote_lines_per_file,
        remote_bytes_per_file,
    )
    try:
        proc = subprocess.run(
            ["ssh", "-C", "home-3060", "sh -c " + shlex.quote(cmd)],
            check=False,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        return [], {"error": str(err), "files": 0, "root": "", "dates": []}

    root = ""
    files = 0
    found_dates: list[str] = []
    for line in proc.stderr.splitlines():
        if line.startswith("__CATCHUP_ROOT__"):
            root = line.removeprefix("__CATCHUP_ROOT__")
        elif line.startswith("__CATCHUP_FILE__"):
            files += 1
        elif line.startswith("__CATCHUP_DATE__"):
            found_dates.append(line.removeprefix("__CATCHUP_DATE__"))

    if proc.returncode != 0:
        if proc.returncode == 6:
            return [], {"error": "", "files": 0, "root": root, "dates": []}
        err = proc.stderr.strip() or f"ssh home-3060 returned {proc.returncode}"
        return [], {"error": err, "files": files, "root": root, "dates": found_dates}

    records = load_records_from_iter(iter_jsonl_lines(proc.stdout.splitlines()), max_records)
    return records, {"error": "", "files": files, "root": root, "dates": found_dates}


def select_records(
    records: list[dict[str, Any]],
    bot_name: str | None,
    mode: str,
    max_lines: int,
) -> tuple[list[dict[str, Any]], str]:
    if not records:
        return [], "empty"

    if mode == "recent" or not bot_name:
        return records[-max_lines:], "recent"

    last_self_ts: str | None = None
    for record in reversed(records):
        if record.get("dir") == "out" and record.get("bot_name") == bot_name:
            ts = record.get("ts")
            if isinstance(ts, str):
                last_self_ts = ts
                break

    if not last_self_ts:
        return records[-min(max_lines, 30):], "cold-start"

    selected = [r for r in records if str(r.get("ts") or "") > last_self_ts]
    if selected:
        return selected[-max_lines:], f"incremental-after-{last_self_ts}"
    return [], f"no-new-records-after-{last_self_ts}"


def render_record(record: dict[str, Any], max_chars: int) -> str | None:
    ts = str(record.get("ts") or "????-??-??T??:??:??")[:16].replace("T", " ")
    direction = record.get("dir") or "?"
    if direction == "in":
        speaker = "user"
        user_id = record.get("user_id")
        if isinstance(user_id, str) and user_id:
            speaker += f" {user_id[-6:]}"
    elif direction == "out":
        speaker = f"bot {record.get('bot_name') or 'unknown'}"
    else:
        speaker = str(direction)

    body = body_of(record)
    if not body:
        if record.get("type") == "image":
            body = "[image]"
        elif record.get("type") == "file":
            body = "[file]"
        else:
            return None

    if len(body) > max_chars:
        body = body[:max_chars].rstrip() + "..."
    return f"[{ts} {speaker}]: {body}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chat-id", required=True)
    parser.add_argument("--bot-name")
    parser.add_argument("--archive-root", default=os.environ.get("METABOT_ARCHIVE_ROOT", str(DEFAULT_ARCHIVE_ROOT)))
    parser.add_argument("--source", choices=["auto", "local", "mac", "3060"], default="auto")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--mode", choices=["incremental", "recent"], default="recent")
    parser.add_argument("--max-records", type=int, default=5000)
    parser.add_argument("--max-lines", type=int, default=80)
    parser.add_argument("--max-chars-per-entry", type=int, default=700)
    parser.add_argument("--max-total-chars", type=int, default=16000)
    parser.add_argument("--mac-timeout", type=int, default=75)
    parser.add_argument("--mac-health-timeout", type=int, default=25)
    parser.add_argument("--mac-retention-days", type=int, default=45)
    parser.add_argument("--node3060-timeout", type=int, default=45)
    parser.add_argument("--remote-lines-per-file", type=int)
    parser.add_argument("--remote-bytes-per-file", type=int)
    args = parser.parse_args()

    safe_id = safe_chat_id(args.chat_id)
    archive_root = Path(args.archive_root)
    wanted_dates = date_stems(args.days)
    mac_retention_days = max(args.mac_retention_days, 1)
    mac_cutoff_date, mac_window_dates, cold_window_dates = partition_dates_by_mac_retention(
        wanted_dates,
        mac_retention_days,
    )
    max_records = max(args.max_records, 1)
    remote_lines_per_file = args.remote_lines_per_file
    if remote_lines_per_file is None:
        lines_per_day = (max(args.max_lines, 1) + max(args.days, 1) - 1) // max(args.days, 1)
        # One visible bot reply can produce many streaming-card JSONL frames.
        # Read a wider bounded tail, then collapse those frames on the source node.
        remote_lines_per_file = max(
            200,
            min(2000, lines_per_day * 25 + 100),
        )
    remote_bytes_per_file = args.remote_bytes_per_file
    if remote_bytes_per_file is None:
        remote_bytes_per_file = max(
            65536,
            min(131072, 4194304 // max(args.days, 1)),
        )

    source_records: dict[str, list[dict[str, Any]]] = {
        "local": [],
        "mac": [],
        "3060": [],
    }
    source_dates: dict[str, list[str]] = {"local": [], "mac": [], "3060": []}
    source_files: dict[str, int] = {"local": 0, "mac": 0, "3060": 0}
    source_errors: list[str] = []
    mac_info: dict[str, Any] = {
        "error": "",
        "attempts": 0,
        "health_status": "not_needed",
        "health_ready_routes": 0,
    }
    archive_info: dict[str, Any] = {"error": ""}

    if args.source in {"auto", "local"}:
        local_files = archive_files(archive_root, args.chat_id, args.days)
        source_files["local"] = len(local_files)
        source_dates["local"] = [path.stem for path in local_files]
        if local_files:
            source_records["local"] = load_records(local_files, max_records)

    if args.source == "auto":
        local_missing_dates = [
            stem for stem in wanted_dates if stem not in source_dates["local"]
        ]
        _, mac_query_dates, node3060_query_dates = partition_dates_by_mac_retention(
            local_missing_dates,
            mac_retention_days,
        )
    elif args.source == "mac":
        mac_query_dates = list(wanted_dates)
        node3060_query_dates = []
    elif args.source == "3060":
        mac_query_dates = []
        node3060_query_dates = list(wanted_dates)
    else:
        mac_query_dates = []
        node3060_query_dates = []

    if mac_query_dates:
        mac_records, mac_info = load_mac_records_with_diagnostics(
            args.chat_id,
            mac_query_dates,
            max_records,
            max(args.mac_timeout, 1),
            max(args.mac_health_timeout, 1),
            remote_lines_per_file,
            remote_bytes_per_file,
        )
        source_records["mac"] = mac_records
        source_files["mac"] = int(mac_info.get("files") or 0)
        source_dates["mac"] = sorted(set(mac_info.get("dates") or []))
        mac_error = str(mac_info.get("error") or "")
        if mac_error:
            source_errors.append(f"mac: {mac_error}")

    if node3060_query_dates:
        archive_records, archive_info = load_3060_records(
            args.chat_id,
            node3060_query_dates,
            max_records,
            max(args.node3060_timeout, 1),
            remote_lines_per_file,
            remote_bytes_per_file,
        )
        source_records["3060"] = archive_records
        source_files["3060"] = int(archive_info.get("files") or 0)
        source_dates["3060"] = sorted(set(archive_info.get("dates") or []))
        archive_error = str(archive_info.get("error") or "")
        if archive_error:
            source_errors.append(f"3060: {archive_error}")

    if args.source == "local":
        active_names = ["local"] if source_files["local"] else []
    elif args.source == "mac":
        active_names = ["mac"] if source_files["mac"] else []
    elif args.source == "3060":
        active_names = ["3060"] if source_files["3060"] else []
    else:
        active_names = [name for name in ("local", "mac", "3060") if source_files[name]]

    records = merge_record_sets(
        (source_records[name] for name in active_names),
        max_records,
    )
    covered_set = set().union(*(set(source_dates[name]) for name in active_names)) if active_names else set()
    covered_dates = [date for date in wanted_dates if date in covered_set]
    unresolved_dates = [date for date in wanted_dates if date not in covered_set]
    recent_unresolved_dates = [date for date in mac_window_dates if date not in covered_set]
    cold_unresolved_dates = [date for date in cold_window_dates if date not in covered_set]
    mac_error = str(mac_info.get("error") or "")
    archive_error = str(archive_info.get("error") or "")
    if args.source == "auto":
        recent_blocked_dates = list(recent_unresolved_dates) if mac_error else []
        recent_missing_dates = [
            stem for stem in recent_unresolved_dates if stem not in recent_blocked_dates
        ]
        if recent_blocked_dates:
            routing_status = "blocked_recent_mac_unavailable"
        elif recent_missing_dates and cold_unresolved_dates:
            routing_status = "partial_recent_and_cold_missing"
        elif recent_missing_dates:
            routing_status = "partial_recent_missing"
        elif cold_unresolved_dates and archive_error:
            routing_status = "blocked_cold_3060_unavailable"
        elif cold_unresolved_dates:
            routing_status = "partial_cold_missing"
        else:
            routing_status = "complete"
    else:
        recent_blocked_dates = []
        recent_missing_dates = list(recent_unresolved_dates)
        routing_status = "diagnostic_complete" if not unresolved_dates else "diagnostic_partial"
    files_count = sum(source_files[name] for name in active_names)

    if len(active_names) == 1:
        source = active_names[0]
    elif active_names:
        source = f"mixed({','.join(active_names)})"
    else:
        source = args.source if args.source != "auto" else "none"

    if source == "local":
        archive_root_label = str(archive_root)
        archive_dir_label = str(archive_root / safe_id)
    elif source == "mac":
        archive_root_label = "Mac ~/sg_archive/backups/<snapshot-date>/root/metabot/data/messages"
        archive_dir_label = f"{archive_root_label}/{safe_id}"
    elif source == "3060":
        archive_root_label = "/mnt/nvme/sg_archive/source_snapshots/<snapshot-date>/root/metabot/data/messages"
        archive_dir_label = f"{archive_root_label}/{safe_id}"
    else:
        archive_root_label = "SG local + Mac historical snapshots + 3060 historical snapshots"
        archive_dir_label = f"exact chat only: {safe_id}"

    print("# MetaBot Catchup Context")
    print(f"chat_id: {args.chat_id}")
    print(f"safe_chat_id: {safe_id}")
    print(f"bot_name: {args.bot_name or '_unknown_'}")
    print(f"source: {source}")
    print(f"archive_root: {archive_root_label}")
    print(f"archive_dir: {archive_dir_label}")
    print(f"days: {args.days}")
    print(f"mode: {args.mode}")
    print(f"mac_retention_days: {mac_retention_days}")
    print(f"mac_cutoff_date_inclusive: {mac_cutoff_date}")
    print("routing_order: SG-local -> Mac-missing-within-retention; SG-local -> 3060-missing-older-than-retention")
    print("routing_note: Mac is the only historical tier inside its retention window; Mac failure never falls through to 3060")
    print(f"routing_status: {routing_status}")
    print(f"mac_window_dates: {','.join(mac_window_dates) or '_none_'}")
    print(f"cold_window_dates: {','.join(cold_window_dates) or '_none_'}")
    print(f"mac_query_dates: {','.join(mac_query_dates) or '_none_'}")
    print(f"node3060_query_dates: {','.join(node3060_query_dates) or '_none_'}")
    print(f"mac_health: {mac_info.get('health_status') or 'unknown'}")
    print(f"mac_health_ready_routes: {int(mac_info.get('health_ready_routes') or 0)}")
    print(f"mac_attempts: {int(mac_info.get('attempts') or 0)}")
    print(
        f"remote_limits: lines_per_file={remote_lines_per_file},"
        f"bytes_per_file={remote_bytes_per_file}"
    )
    print(f"files: {files_count}")
    print(
        "source_files: "
        + ",".join(f"{name}={source_files[name]}" for name in ("local", "mac", "3060"))
    )
    print(f"covered_dates: {','.join(covered_dates) or '_none_'}")
    print(f"missing_dates: {','.join(unresolved_dates) or '_none_'}")
    print(f"recent_blocked_dates: {','.join(recent_blocked_dates) or '_none_'}")
    print(f"recent_missing_dates: {','.join(recent_missing_dates) or '_none_'}")
    print(f"cold_missing_dates: {','.join(cold_unresolved_dates) or '_none_'}")
    print(
        "date_sources: "
        + ";".join(
            f"{name}={','.join(source_dates[name]) or '_none_'}"
            for name in ("local", "mac", "3060")
        )
    )
    if recent_blocked_dates:
        print("mac_failure_action: recent history is blocked; inspect ssh-home-mac health/journal evidence and do not query 3060 for these dates")
    if recent_missing_dates:
        print("recent_missing_note: Mac was reachable but no archive file was found; this may mean no messages or a Mac backup gap")
    if cold_unresolved_dates:
        print("cold_missing_note: no 3060 archive file was found; this may mean no messages or unavailable cold history")
    if source_errors:
        print(f"source_error: {'; '.join(source_errors)}")

    if not files_count or not records:
        print("\nNo archive files found for this chat and date range.")
        return 0

    selected, selection_reason = select_records(
        records,
        args.bot_name,
        args.mode,
        max(args.max_lines, 1),
    )
    print(f"records_loaded_after_collapse: {len(records)}")
    print(f"selected: {len(selected)}")
    print(f"selection: {selection_reason}")
    print("\n## Entries")

    total = 0
    emitted = 0
    for record in selected:
        line = render_record(record, max(args.max_chars_per_entry, 80))
        if not line:
            continue
        if total + len(line) + 1 > args.max_total_chars:
            print("\n[truncated: max total characters reached]")
            break
        print(line)
        total += len(line) + 1
        emitted += 1

    if emitted == 0:
        print("No new messages selected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
