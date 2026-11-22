# Antigravity engine for MetaBot

Status: implemented and registered as separate Gemini and Claude production
MetaBot/Feishu bots.

Runtime audit on 2026-10-18:

- Active binary: `/root/.local/bin/agy` 1.4.2, 221,286,656 bytes, SHA256
  `085f43e0d0628a8a8dabe1e547067818fa2c0adc86cfac98a3c4492918f455ef`.
- Root filesystem headroom after validation: about 9.7 GB.
- `primary` resolves explicitly to `/root/.gemini`; its secret-safe identity
  check matches the intended paid account. `agy models` exposes Gemini 4 Argon
  and Claude Opus/Sonnet 5.5, and bounded sandboxed canaries passed for
  `gemini-4-argon-low` and `claude-opus-5-5-low`.
- `backup` resolves explicitly to `/var/lib/metabot-antigravity/backup`; its
  identity check matches the second account. It currently exposes the older
  Gemini 3.8 / Claude 4.6 catalog, and a `gemini-3.8-flash-low` canary passed.
- The obsolete `/var/lib/metabot-antigravity/primary` profile is not treated as
  the paid account: it has no OAuth token and correctly asks for sign-in.
- An empty-profile test under 1.4.2 asked for authentication, created no OAuth
  token, and did not modify the default profile token. This revalidates the
  deployment's hidden `--gemini_dir` isolation for this exact binary version.
- No production bot was created, updated, or restarted.

## Why this is a separate engine

Antigravity CLI uses the `agy` executable, `--conversation` session IDs, and a
different streaming JSON schema from legacy Gemini CLI. Replacing `gemini` with
`agy` inside the existing engine would break session continuity and tool-event
rendering.

## Safety defaults

- Runs headless with `--output-format stream-json`.
- Enables `--sandbox` unless explicitly disabled.
- Defaults to the terminal sandbox and never bypasses permissions unless the
  deployment explicitly sets `dangerouslySkipPermissions: true` for a trusted,
  root-running harness bot.
- Does not print raw provider stderr because OAuth URLs or authorization codes
  may be present.
- Does not rotate Google accounts automatically when a quota is exhausted.
- Named accounts are selected only through an explicit `/account` command.
- Changing accounts clears the saved Antigravity conversation ID so a
  server-side conversation is never resumed under a different account.

## Bot configuration shape

```json
{
  "name": "antigravity-review",
  "engine": "antigravity",
  "defaultWorkingDirectory": "/absolute/project/path",
  "antigravity": {
    "model": "gemini-4-argon-low",
    "effort": "high",
    "sandbox": true,
    "dangerouslySkipPermissions": false,
    "printTimeout": "20m",
    "agent": "code-reviewer"
  }
}
```

For a deliberately unrestricted root-running harness, set
`dangerouslySkipPermissions: true`. This supersedes `sandbox` and passes
`--dangerously-skip-permissions`. It allows arbitrary host file reads/writes,
commands, network actions, and credential access; backups do not mitigate
credential disclosure or irreversible external side effects.

Use the exact model slug returned by `agy models`; do not infer a slug from the
display name shown on the Antigravity website.

## Manual multi-account selection

`agy` does not expose a documented account/profile selector. Version 1.4.2 was
empirically verified to honor the hidden `--gemini_dir=<absolute-path>` flag,
including OAuth-token, cache, conversation, and configuration isolation. The SG
deployment therefore uses one root-only profile directory and executable
wrapper per account while sharing a single `agy` binary. This keeps
the process able to access root-owned workspaces without opening `/root` to
additional operating-system users.

This is profile isolation, not a privilege boundary against the root-running
MetaBot process. Every `agy` upgrade must repeat the empty-profile
authentication canary before the wrappers are trusted. MetaBot stores only the
safe alias and absolute runner path; passwords, OAuth codes, cookies, and tokens
must not appear in `bots.json`, wrapper arguments, ordinary logs, or group-chat
messages.

```json
{
  "antigravity": {
    "defaultAccount": "primary",
    "accounts": {
      "primary": {
        "runner": "/opt/metabot/antigravity-accounts/primary/run-agy"
      },
      "backup": {
        "runner": "/opt/metabot/antigravity-accounts/backup/run-agy"
      }
    }
  }
}
```

Supported chat commands:

- `/model list` queries `agy models` through the currently selected account
  runner and displays only that account's exact catalog. It never merges or
  falls back to another account's models.
- `/account` shows the current account's alias, redacted login identity, usage and reset dates.
- `/account list` (also `ls`, `dashboard`, `quota`) shows all configured accounts
  as separate mobile-friendly notices. Email identities are genuinely redacted
  (partial local name only, no domain); credentials and provider errors are never displayed.
- `/account use backup` selects an account and starts a fresh conversation on
  the next request.
- `/account next` advances once in configuration order. It is an explicit user
  action, not a quota/error-triggered fallback.
- `/account reset` returns to `defaultAccount`.

Account switching is refused while a task is running. A quota, authentication,
eligibility, permission, or provider error is returned to the user without
trying another account.

### Account dashboard (2026-11-01)

The dashboard queries the existing read-only `--output-format json -p /usage`
command through each account's exact configured runner. It shows every returned
model pool and window independently, with used/remaining percentages and absolute
reset dates in Asia/Shanghai (UTC+8). These are pool percentages, not token counts
or proof that every model in a pool is available. Missing or invalid quota/reset
fields remain unknown; failed queries never become zero usage. Expired provider
reset dates are explicitly labelled as awaiting a provider update.

Identity comes only from `id_token_email` in the selected profile's local
`antigravity-cli/antigravity-oauth-token` file. Profile discovery supports one
literal absolute `--gemini_dir` flag on the runner's `exec` command, including
quoted paths and line continuations. It never guesses a profile from an alias,
falls back to HOME, prints credentials, or forwards provider stderr. Custom or
remote runners without this mapping show identity unknown while still querying
their own quota. Files are bounded to 16 KiB. The display email may reflect the
CLI's saved identity; it is not a separate online identity attestation.

Queries share a 30-second cache and in-flight work across bots/chats. One usage
subprocess runs at a time, with a 15-second timeout and 2 MiB output cap. For a local
preview, run the following from the checkout with your configuration and bot name.

```bash
node --import tsx tools/antigravity-account-dashboard.ts ./bots.json YOUR_BOT_NAME
```

The Feishu formatter masks the local name and removes the email domain.
A failed message receipt is reported as a delivery failure.

## Skills and agent-bus access

Antigravity discovers workspace skills from `.agents/skills/<name>/SKILL.md`.
The MetaBot skill installer therefore mirrors every installed skill into both
`.claude/skills` and `.agents/skills`. Skill Hub installs are mirrored the same
way. This lets an Antigravity bot invoke `/metabot` and other workspace skills
without maintaining a separate Antigravity-only skill bundle.

The SG account profiles grant only these MetaBot command prefixes in headless
sandbox mode: `mb health`, `mb bots`, `mb peers`, `mb talk`, and
`mb consensus`. A deployment that explicitly enables
`dangerouslySkipPermissions` bypasses those interactive approval gates for
that bot and must treat every inbound prompt as root-capable.

Once the bot is registered, it participates in the same registry and HTTP task
path as every other engine. Other agents can call it with:

```bash
mb talk antigravity-review <chatId> "Review this change"
```

It can also be included as a named panelist in a `consensusProfiles` entry and
used by `mb consensus`. MetaBot's registry performs this orchestration; no
Feishu `@mention` loop is used.

## Activation gates

1. Create one root-only profile directory and root-owned runner per approved,
   location-eligible account. Authenticate each account exactly once through
   its own runner; do not implement automatic quota-rotation.
2. Run a sandboxed headless canary through every runner and verify a terminal
   `SUCCESS` result without exposing provider stderr or credentials.
3. Configure only safe aliases and absolute runner paths, then verify
   `/account`, `/account use`, and `/account next` reset conversation state.
4. Before any future binary upgrade, record version/size/hash/free space and
   repeat the empty-profile authentication-isolation test. Do not assume the
   hidden profile flag remains compatible.
5. Register a new Feishu app with a dedicated bot name, install workspace
   skills, then validate one Feishu request, one `mb talk` request, and one
   consensus dry-run before declaring the integration operational.

Applied execution lessons:
DELIVERY-CLOSURE-OUTCOME-035, GOAL-CONTINUITY-123, JUDGMENT-001, MEMORY-002,
METABOT-BOT-DETAILS-SECRET-010, METABOT-RAW-LOG-SECRET-037,
METABOT-SENSITIVE-CONFIG-036, METABOT-ANTIGRAVITY-BINARY-124,
METABOT-ANTIGRAVITY-PROFILE-125, METABOT-ANTIGRAVITY-ACCOUNT-MAP-129,
REASONING-004, FEISHU-MATH-001, LESSON-PROJECT-KEY-001,
LESSON-WORKFLOW-KEY-001.

## Per-chat effort (2026-10-21)

Use `/effort`, `/effort list`, `/effort high`, or `/effort reset` in Feishu. The installed agy 1.4.3 accepts low/medium/high/xhigh/max as CLI candidates, but current account/model availability is checked before saving a selection. The primary Gemini 4 Argon catalog currently exposes low/medium/high only; xhigh/max are not advertised as supported Gemini tiers.

The durable `antigravityReasoningEffort` preference is isolated by bot and chat, overrides `antigravity.effort`, survives conversation reset/expiry, and is cleared by `/model reset`. Model/account changes retain this independent preference; use `/effort list` and `/effort reset` when changing to a model/account with different capabilities. The CLI remains the final authority on variant resolution.

Changing effort starts a fresh conversation on the next turn without deleting old records. Busy tasks, invalid/unsupported values, catalog failures, and session persistence errors are reported without claiming success. A concurrent model/account/effort change during catalog lookup aborts the pending change. The six normal/retry/context-recovery chat/API paths all forward the preference.

The settings display is the requested effort and source, not a measured token budget. A returned init model variant is independent runtime evidence.

## Timeout diagnostics and usage (2026-11-08)

### Historical interruption in resumed conversations (2026-11-11)

Some CLI results report an old `The stream was interrupted` error again after
a later turn completes, with `status: ERROR` and `finished_reason: error`.
MetaBot corrects only this exact failure after process exit zero, with no
signal, cancellation, disqualifying stderr or malformed JSON events. Other stop reasons,
including `print_timeout` and `interrupted`, remain failures.

Recovery requires the current user-input boundary, a final DONE response
matching the final segment, no current ERROR_MESSAGE, and independent saved history
confirming that the exact interruption precedes this turn. The terminal result
must match the full streamed turn response. The translator records raw text
deltas in `responseSteps`, keyed by step index. Each current-turn response
must match its saved MODEL/PLANNER_RESPONSE at that exact index after trimming
only the segment edges; internal whitespace remains significant. Every nonempty
streamed step must be present, and extra nonempty history responses are rejected.
This tolerates agy's per-step trailing streaming newline being trimmed on export.
Tool-only planner rows may omit `content` only when no streamed text is expected
at that index; null/object content and missing expected response content fail.
Raw streamed step text must also cover the entire streamed turn, preventing
unverified terminal-only suffixes. Empty synthetic maps support only a
single-segment compatibility fallback. Read
`transcript_full.jsonl` preferentially; only ENOENT allows fallback to
`transcript.jsonl`. Any content truncation marker, invalid full export,
subsequent user turn, response mismatch or unresolved background task keeps
the failure. Reads are bounded to 64 MiB per file, 4 MiB per UTF-8 line and
two seconds, and file size/mtime must remain unchanged during verification.

An intermediate MODEL/GENERIC ERROR is a completed tool error, not a stream
failure. An exported RUNNING background snapshot must be closed by a later
provider SYSTEM_MESSAGE for the exact same conversation/task with a valid
timestamp and integer exit code (including nonzero). Only the two exact agy
output-truncation headers (with/without a full-output file URI) may precede
the command-exit line. Arbitrary intervening text cannot close the task.
The final step must
still be a DONE MODEL/PLANNER_RESPONSE. This verifies completion of the
model turn, not success of every command or the user's research objective.

Stderr allows only line-anchored agy print-mode progress: root-idle waiting
for background tasks (both forms), the fully-idle wait timer, and daemon-task
termination. Unknown lines, upstream errors and **background**-task termination
still veto recovery. A truncated stderr buffer also vetoes recovery, so an
error cannot be hidden by a later suffix of progress notices. Diagnostic logs
include `multiResponseTurn`, `disqualifyingStderr`, `stderrTruncated` and
`verificationReason`. The detailed verifier returns only bounded reason codes
(e.g. `response_step_mismatch`, `background_task_unresolved`, `history_read_failed`);
its boolean wrapper remains available. Exceptions never enter diagnostic text.

Provider history and credentials are never changed and no request is replayed.
Logs contain only bounded status/boolean metadata, never response or stderr
text. Text, a DONE step or process exit zero alone cannot establish success.
The seven-turn offline regression uses unchanged full-history prefixes and
feeds each nonempty response through the translator with a trailing newline,
including the 739..749 production regression. Reconstructed events and terminal
state are explicitly labelled; this is not a captured live-stream end-to-end test.

`agy` has an upstream stream-idle timeout independent of the CLI's
`--print-timeout` and MetaBot's task/idle watchdogs. Changing one does not fix
the others. CLI 1.5.3 is installed; its response-header retry fix does not
claim to fix stream-idle failures.

The translator honors `finished_reason` (available since CLI 1.4.11):
`print_timeout` and `interrupted` remain failures even if the payload says
SUCCESS and contains partial text. A current print timeout takes precedence
over a possibly historical `error` string. Nonzero process exit also prevents
success. Network timeouts do not trigger quota failover or task replay.
Completed assistant steps are emitted before the final process result, while
only a successful terminal result and process exit complete the task.

Antigravity `result.usage` is cumulative model consumption, not current context
occupancy. On a successful process result, the executor reads the selected
profile's latest MODEL/PLANNER_RESPONSE usage in this invocation. Prompt tokens
are `input_tokens + cache_read_tokens`; completion tokens are `output_tokens`.
The context footer uses their sum. The final init-resolved model determines the
window, with explicit configuration taking precedence. The installed CLI's
Gemini 4 Argon/Carbon and Gemini 3.8 Flash families use 1,048,576 tokens; unknown
models are not guessed.

Numeric usage comes from `transcript.jsonl`, falling back to
`transcript_full.jsonl` only on ENOENT. Reads are streamed, bounded to 64 MiB /
4 MiB per line / two seconds, and rejected if the file changes, another user
turn appears, or records exceed the streamed final step. Invalid/missing usage
or unknown window retains the cumulative footer. Truncated prose is irrelevant
to intact numeric usage fields. No credentials or model requests are involved.

Resumed executions show local elapsed time from invocation start through child
exit, rather than agy's conversation-lifetime `duration_seconds`. New sessions
and standalone translator semantics are unchanged. Split cards suppress usage
on the process card and preserve context/cumulative semantics on the conclusion.
Only multi-window quota footers use `1周`/`1月` and ` / ` separators; single-window
quota formatting and other engines' context calculations remain unchanged.

For long tool-using tasks, the configured 20-minute print deadline may cut off
a healthy task. A deployment may set `printTimeout: "0"` to use MetaBot's
existing one-hour inactivity and 24-hour task limits instead. This is a
separate operational configuration change, not a fix for upstream failures.
