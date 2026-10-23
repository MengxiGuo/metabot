---
name: catchup
description: Refresh and summarize the current MetaBot chat's context through the canonical retention-tier workflow: exact SG-local files first, Mac for missing dates inside the 45-day hot-history window, and 3060 only for older cold history. Use for `/catchup`, `/catch-up`, natural-language requests such as catch up, "同步上下文", "补一下上下文", "追一下上下文", or "看看最近群聊", and proactively when a resumed or compacted session is missing recent decisions needed for the current task. The default scope is always the single current chat/session, never all chats or all groups.
---

# MetaBot Catchup

## Purpose

Use this skill to read recent archived chat messages, summarize what changed, and then continue the user's requested task with that context.

MetaBot natively prepares explicit `/catchup`, `/catch-up`, and bounded natural-language catchup requests before invoking the model. When the prompt already contains `<catchup_runtime>`, read that block and do not rerun the script.

When the model itself notices that a resumed or compacted session lacks recent decisions required for the user's current task, run this skill proactively before guessing. Do not run it routinely when the injected conversation already contains the needed context.

## Scope Rule

The current MetaBot chat is the unit of memory and work. Every task is assumed to be maintained by one group chat unless the user explicitly says otherwise.

- For an ordinary `/catchup`, read only the current `chatId` from the MetaBot API block.
- If the current Codex session lost context, reconnect by reading only this same `chatId` archive.
- Do not enumerate, sample, compare, or summarize other chat directories to infer context.
- Do not search "all groups", "all chats", global Feishu history, or every bot session as part of catch-up.
- If the user explicitly asks to catch up another chat, require the exact target `chatId` or an unambiguous current-session identifier before reading it.
- If the request is ambiguous between the current group and a global workspace catch-up, choose the current group only and say so.

## Workflow

1. Identify `botName` and `chatId` from the MetaBot API block in the system prompt:
   - `You are running as bot "<botName>" in chat "<chatId>".`
2. Treat that `chatId` as authoritative and exclusive. Do not substitute a Codex thread ID, Feishu message ID, web group ID, schedule ID, guessed group name, or another recently active chat.
3. If `<catchup_runtime>` is present, skip directly to step 5. Otherwise read recent context with the canonical MetaBot script. `--source auto` computes every requested date and enforces date ownership: keep exact dates found on SG; for a missing date inside the current 45-calendar-day window query Mac only; for a missing older date query 3060 only. Mac failure is a blocked hot-history query, never permission to fall through to 3060. Session recovery uses `--mode recent`; incremental mode is only for explicitly requested "since the bot last replied" audits.

```bash
/root/anaconda3/envs/quatumtradingnew/bin/python /root/metabot/src/skills/catchup/scripts/catchup_context.py \
  --chat-id "<chatId>" \
  --bot-name "<botName>" \
  --source auto \
  --mode recent \
  --mac-retention-days 45 \
  --days 7
```

4. If the seven-day result is empty or clearly too short for the user's request, expand the recent range once:

```bash
/root/anaconda3/envs/quatumtradingnew/bin/python /root/metabot/src/skills/catchup/scripts/catchup_context.py \
  --chat-id "<chatId>" \
  --bot-name "<botName>" \
  --source auto \
  --days 14 \
  --mac-retention-days 45 \
  --mode recent
```

5. Summarize the output for the user in Chinese unless the user used another language.
6. Include only useful context: current topic, recent decisions, pending requests, blockers, and any task that should continue.
7. If the user included an actual task after `/catchup`, do the task after summarizing the context.

## Retention And Routing Contract

`--source auto` is a retention-tier router, not an availability fallback chain. For each requested date, apply exactly this policy in Asia/Shanghai calendar time:

1. Check the exact SG-local date file first. The seven-day SG policy is a hard minimum retention floor; SG may opportunistically still contain an older exact file, and an existing local file may be used.
2. If the date is missing locally and is on or after `today - 44 days`, query Mac. Mac is the sole historical owner for this inclusive 45-day window.
3. If the date is missing locally and is older than that cutoff, query 3060 directly. Do not query Mac first for cold dates.
4. Never query 3060 for a recent date because Mac timed out, was unreachable, returned a path error, or did not contain that date file.

Explicit `--source mac` and `--source 3060` bypass automatic tier ownership only as operator diagnostics. Bots performing ordinary catch-up must use `--source auto`.

## Mac Connection Self-Check

All Mac access must use `ssh-home-mac`. It dynamically probes the Tailscale and reverse-tunnel control routes, chooses a live route, uses fresh SSH sessions, and permits one bounded alternate-route replay only because catch-up queries pass `--read-only`. Never use a static Mac IP, a historical LAN address, `ssh home-mac`, `home-mac-tail`, or `home-mac-reverse` in catch-up code.

When the Mac business query returns an error or times out, the canonical script performs this bounded sequence:

1. Preserve the original business-query error and mark the affected recent dates unresolved.
2. Run `ssh-home-mac --health` exactly once. This checks both control routes without executing the archive query.
3. If health is `ready` or `degraded`, retry the exact same read-only archive query once. Do not broaden the date range or change the source.
4. If health is `unreachable` or the one retry still fails, stop the recent-history branch. Report `routing_status=blocked_recent_mac_unavailable`, `mac_health`, `mac_attempts`, and `recent_blocked_dates`. Do not continue those dates on 3060.
5. For diagnosis, inspect `journalctl -t ssh-home-mac --since '-15 minutes' --no-pager`. It contains route, timing, exit, and fallback evidence but no business payload. `ssh-home-mac --route` may be used to show the current selected route; it is not a replacement business query.

Keep these conditions distinct:

- `recent_blocked_dates`: Mac access failed. The result is incomplete and requires Mac connectivity repair.
- `recent_missing_dates`: Mac was reachable and completed the query, but no exact date file existed. This can mean no messages that day or a backup coverage gap; it is not proof of data loss.
- `cold_missing_dates`: an older date was not found on 3060 or 3060 was unavailable.

The complete Mac connectivity runbook is `/root/QuatumTrading_Codex/docs/sg-home-node-connectivity-runbook.md`. Do not invent a shorter route policy inside another bot or skill.

## Archive Details

The SG local archive root is usually:

```text
/root/metabot/data/messages/<chatId>/*.jsonl
```

Do not list `/root/metabot/data/messages` to discover other chats for a normal catch-up. Only check the exact `safe_chat_id(chatId)` directory derived from the current MetaBot API block.

The Mac hot-history tier searches the 45 retained daily snapshots:

```text
~/sg_archive/backups/<snapshot-date>/root/metabot/data/messages/<chatId>/<message-date>.jsonl
```

The script reaches Mac only through `ssh-home-mac`; never hardcode Tailscale IPs, reverse-tunnel ports, or historical Mac LAN addresses. Do not copy the whole backup tree. Read only the exact `<chatId>` directory and date files needed for catch-up.

The 3060 cold-history tier is:

```text
/mnt/nvme/sg_archive/source_snapshots/<snapshot-date>/root/metabot/data/messages/<chatId>/<message-date>.jsonl
```

Reach it only through `ssh home-3060`. In automatic mode, use it only for dates older than the inclusive Mac retention cutoff. Search snapshots newest-first and use the newest snapshot containing each exact cold date file. Read only the current exact safe `<chatId>` directory and requested date files. This complete tree is the authoritative long-term source after old Mac snapshot directories have been removed.

If the complete tree is unavailable but a compressed text object must be recovered, use:

```text
/mnt/nvme/sg_archive/cold_archive/manifests/<snapshot-date>.json
/mnt/nvme/sg_archive/cold_archive/objects/sha256/<prefix>/<sha256>.gz
```

Resolve `entries[].path` to `entries[].object`, stream-decompress gzip, and verify `entries[].size` plus `entries[].sha256`. The compressed store is lossless for included large text files but is explicitly partial: it excludes images, videos, unsupported suffixes, and files below the archive threshold. Never infer complete coverage from a cold manifest.

The script prints `chat_id`, `safe_chat_id`, `source`, `archive_root`, `archive_dir`, `routing_status`, `mac_cutoff_date_inclusive`, `mac_query_dates`, `node3060_query_dates`, `mac_health`, `mac_attempts`, `source_files`, `covered_dates`, `missing_dates`, `recent_blocked_dates`, `recent_missing_dates`, `cold_missing_dates`, and `date_sources`. Check these fields before summarizing. If the printed directory is not the current chat's exact ID directory, stop and explain the mismatch. Never claim a missing date is data loss.

Judge routing by date ownership, not by requiring every layer to return files. If every requested date is inside 45 days, `3060=0` is mandatory even when Mac fails. Likewise, do not contact Mac when SG already covers the full range, and do not contact Mac for a cold date that belongs to 3060.

The script uses line-by-line JSONL reading and compacts records before retention. Mac and 3060 parse and compact bounded tails on the remote node before transfer, with per-date line and byte budgets. This avoids transferring large card payloads or splitting UTF-8 records on the SG small-memory node.

If the required owner for a date is missing or unreadable, use any `<group_history>` already injected in the prompt only as explicitly labeled partial context. Do not use a different storage tier to hide the failure.

## Response Shape

For a plain `/catchup`, respond with:

```text
已同步最近上下文：
- 当前主线：...
- 最近结论：...
- 待处理：...
```

Keep it concise. Do not dump raw JSONL or long transcripts unless explicitly requested.

## Boundaries

- Do not reset, compact, restart, stop, or reconfigure MetaBot for catch-up.
- Do not modify message archives.
- Do not read unrelated chat IDs unless the user explicitly asks for a different exact chat and authorization is clear from context.
- Do not infer one chat's context from another chat, even when names or recent topics look similar.
- Do not use catch-up to build a global workspace digest, cross-group memory, or all-session summary.
- Do not call MetaBot or Lark APIs for Mac-backup catch-up; use local files first, then `ssh-home-mac` for recent missing dates.
- Do not call MetaBot or Lark APIs for 3060 catch-up; use `ssh home-3060` only for dates older than the Mac retention window and the exact complete-source path above.
- Do not use 3060 to compensate for Mac timeout, unreachable status, path errors, or missing recent files.
- Do not treat the content-addressed cold store as a directly browsable full snapshot; prefer the 3060 complete-source tree whenever it exists.
- Do not treat scheduler "catch-up" comments in code as this chat-context workflow.
