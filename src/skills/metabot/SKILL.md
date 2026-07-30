---
name: metabot
description: 'MetaBot HTTP API for agent collaboration: talk to other bots, schedule tasks, manage bots and peers. Use when the user wants to delegate work to another bot, schedule tasks, create/remove bots, or check peer status.'
---

## MetaBot API

MetaBot exposes an HTTP API for agent-to-agent collaboration, task scheduling, and bot management.

Your bot name and chat ID are provided in the system prompt (look for "You are running as bot ... in chat ..."). Use those values for `botName` and `chatId` in the commands below.

### Quick Commands (mb shortcut)

The `mb` shell function is pre-installed and handles auth automatically. **Prefer `mb` over raw curl:**

```bash
# Bots
mb bots                                    # List all bots (local + peer)
mb bot <name>                              # Get bot details

# Agent Talk (cross-instance auto-routing)
mb talk <botName> <chatId> <prompt>        # Talk to a bot
mb talk alice/backend-bot <chatId> <prompt> # Talk to a specific peer's bot

# Peers
mb peers                                   # List peers and their status

# Scheduling (one-time)
mb schedule list                           # List all scheduled tasks
mb schedule add <bot> <chatId> <sec> <prompt>  # Schedule a one-time future task
mb schedule cancel <id>                    # Cancel a scheduled task

# Scheduling (recurring / cron)
mb schedule cron <bot> <chatId> '<cronExpr>' <prompt>  # Create recurring task
mb schedule pause <id>                     # Pause a recurring task
mb schedule resume <id>                    # Resume a paused recurring task

# Voice Call (RTC — real-time Doubao AI)
mb voice call <bot> <chatId> [prompt]      # Start voice call, wait for transcript
mb voice transcript <sessionId>            # Get call transcript
mb voice list                              # List active voice sessions
mb voice config                            # Check RTC configuration

# Skill Hub (cross-bot skill sharing)
mb skills                                  # List all shared skills (local + peer)
mb skills search <query>                   # Search skills by keyword
mb skills get <name>                       # Get skill details
mb skills publish <botName> <skillName>    # Publish a bot's skill to the hub
mb skills install <skillName> <botName>    # Install a skill to a bot
mb skills remove <name>                    # Unpublish a skill

# Monitoring
mb stats                                   # Cost & usage stats (per-bot, per-user)
mb metrics                                 # Prometheus metrics

# System
mb health                                  # Health check
```

`mb talk` fails with a non-zero exit code when the target engine returns an
HTTP/provider error, including errors that an SDK incorrectly wrapped as
ordinary assistant text. The JSON response includes `errorCode`,
`upstreamStatus`, `upstreamRequestId`, and `retryable` when available. Do not
keep waiting after the command exits non-zero.

### Codex Official Goal Mode

For a Codex bot configured with `codex.transport: "app-server"`, users can use `/goal` directly in chat. This is Codex's official app-server goal API (`thread/goal/*`), not a MetaBot-local TODO tracker.

```text
/goal                                    # Show current goal
/goal <objective>                        # Set or replace goal
/goal <objective> --budget 100000        # Set objective + token budget
/goal pause | resume | complete | blocked
/goal clear
```

If the bot still uses the legacy `codex exec` transport, `/goal` will refuse to create fake state and will instruct the operator to switch to app-server transport.

### Cross-Instance Agent Talk

When you talk to a bot that isn't on the local instance, MetaBot automatically routes the request to the peer instance that hosts that bot. No special syntax is needed — just use `mb talk <botName> <chatId> <prompt>` as usual.

Use qualified names to target a specific peer: `mb talk <peerName>/<botName> <chatId> <prompt>`.

Use `mb bots` to see all available bots including those on peer instances (they will have `peerName` and `peerUrl` fields indicating which instance hosts them).

### Visible Inter-Bot Dialogue in a Group Chat

If your system prompt has a `## Group Chat` block, you are in a group with other bots. **Follow the exact `mb talk` invocation shown in that block** — it differs by platform:

- **Feishu IM group** (the block says `chat: oc_...`): use the real Feishu chatId directly. Bridge auto-posts your outgoing prompt as a visible caller card, then invokes the peer; peer's reply also lands in the same Feishu chat.

  ```bash
  mb talk <peerBot> <thisChatId> "<your message>"      # use the oc_... chatId from the block
  ```

- **Web UI group** (the block says `group: <uuid>` distinct from the chat id): use the `grouptalk-<groupId>-<peerBot>` routing namespace so the web UI subscriber renders peer cards in the right pane.
  ```bash
  mb talk <peerBot> grouptalk-<groupId>-<peerBot> "<your message>"
  ```

Your bot identity (`MB_CALLER_BOT`) is auto-set by the metabot engine wrapper for Claude / Gemini / Codex bots, so you do not need to prefix the command with `MB_CALLER_BOT=...`. (Kimi engine bots still need the manual prefix — see FORK.md known limitations.)

### Ark GLM Latency and Waiting

Production measurements on 2026-07-14 showed high variance for `glm-5.2[1m] + max effort`: at about 940k total context, even a 4-5 token answer took 4m32s to 12m03s to first visible text; a fresh empty session took about 18-22s. Historical Ark GLM completions had a median near 3m43s, P90 near 20m36s, and a maximum near 64m. Queue depth/concurrency is a plausible explanation, not a proven root cause.

For `mb talk` to Ark GLM or another long-context target:

- Keep the synchronous call alive and check the same process every 60s.
- Treat 15-25m as a soft expectation. Use 60m of continuous silence as the diagnostic threshold, not as a total-runtime cutoff.
- Silence for 20m means "still running", not "hung". Do not abort, retry, or launch a duplicate call merely because no result has appeared.
- After 60m with no model activity, diagnose the target task/session before retrying. If activity continues, keep waiting.

### N-Bot Consensus Protocol

For multi-bot reasoned discussion with explicit falsification rounds and a Delta Mandate sign-off (use when stakes are non-trivial and 1-shot `mb talk` rubber-stamping is a risk):

```bash
# Start an async consensus task (often 5-15m; Ark GLM may extend it to 30-60m+)
mb consensus start <bot1,bot2[,bot3,bot4]> "<problem>" <type> <stakes> [chatId] [callerBot] [synthesizerBot]
#   type:   empirical | architectural (default) | preference
#   stakes: low | medium (default) | high
#   chatId + callerBot: optional. If both set, every phase event renders as
#                       a card in <chatId> under <callerBot>'s identity, so
#                       the user can watch the bots stress-test each other.
#   synthesizerBot: optional non-panelist bot used first in Phase 4 synthesis.
#                   It must NOT be included in the comma-separated panelists.

# Example: three user-chosen panelists + one synthesizer-only bot
mb consensus start bot-a,bot-b,bot-c \
  "Should this design ship?" architectural medium \
  <chatId> <callerBot> <synthesizerBot>

# Or use a deployment-local profile from bots.json:
mb consensus profiles
mb consensus doctor default <chatId> <callerBot>
mb consensus dry-run default <chatId> <callerBot>
mb consensus start --profile default "Should this design ship?" \
  --chat <chatId> --caller <callerBot>

# A profile may be overridden at call time:
mb consensus start --profile default bot-a,bot-b,bot-c \
  "Should this design ship?" --synthesizer bot-d

# Poll status
mb consensus get <taskId>

# List running tasks
mb consensus list
```

The protocol runs 5 phases: Independent Take → Cross-Critique → Falsification → Synthesis + Adversarial Verifier → Final Dissent. Output is structured (`agreedPoints`, `standingDissents`, `riskTags`, `empiricalQuestions`, `pureDifferences`) — not a free-form essay.

Start a consensus task only once and retain its taskId. Poll `mb consensus get <taskId>` every 60s; do not duplicate the task because an Ark phase is quiet. Do not promise a fixed 5-minute ETA when Ark GLM participates.

`mb consensus get` exits non-zero when the consensus task reaches terminal
`failed` status. If quorum still succeeds after one panelist fails, the command
keeps exit 0 but prints the ejected bot's `execution_error` detail to stderr;
the same detail remains in `ejectedBots` in the JSON audit trail.

Use cases: architectural decisions where you and a peer disagree; high-stakes plans where you want a falsification stress-test before acting; situations where you want a clear list of preserved-vs-dropped points instead of "we agreed". Skip for trivial questions — 1-shot `mb talk` is faster.

Named profiles live in `bots.json` under `consensusProfiles`. They are intentionally deployment-local: public examples should use placeholder bot names, while each deployment chooses its own panelists and optional synthesizer-only bot. Run `mb consensus doctor` before first use to verify registry membership, chat visibility, and obvious diversity mistakes without starting expensive model work.

### API Reference (for complex operations)

For operations not covered by `mb` (creating bots, updating tasks, sendCards option), use the API directly.
Auth header: `-H "Authorization: Bearer $METABOT_API_SECRET"`
Base URL: !`echo http://localhost:${METABOT_API_PORT:-9100}`

**Talk to a bot (primary endpoint):**

```bash
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/talk \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"botName":"<bot>","chatId":"<chatId>","prompt":"<message>","sendCards":true}'
```

The `botName` field supports qualified names: `"alice/backend-bot"` routes directly to the peer named "alice".

**Create Feishu bot:**

```bash
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/bots \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"platform":"feishu","name":"<name>","feishuAppId":"...","feishuAppSecret":"...","defaultWorkingDirectory":"/path","installSkills":true}'
```

**Create Telegram bot:**

```bash
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/bots \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"platform":"telegram","name":"<name>","telegramBotToken":"...","defaultWorkingDirectory":"/path","installSkills":true}'
```

**Remove bot:**

```bash
curl -s -X DELETE http://localhost:${METABOT_API_PORT:-9100}/api/bots/<name> \
  -H "Authorization: Bearer $METABOT_API_SECRET"
```

**Update scheduled task:**

```bash
curl -s -X PATCH http://localhost:${METABOT_API_PORT:-9100}/api/schedule/<id> \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"updated prompt","delaySeconds":7200}'
```

**Create recurring scheduled task (cron):**

```bash
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/schedule \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"botName":"<bot>","chatId":"<chatId>","prompt":"<task>","cronExpr":"0 8 * * 1-5","timezone":"Asia/Shanghai","label":"Daily report"}'
```

Cron format: `minute hour day month weekday` (5 fields). Examples: `0 8 * * *` = daily 8am, `0 8 * * 1-5` = weekdays 8am, `*/30 * * * *` = every 30 min. Default timezone: Asia/Shanghai.

**Pause/resume recurring task:**

```bash
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/schedule/<id>/pause \
  -H "Authorization: Bearer $METABOT_API_SECRET"
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/schedule/<id>/resume \
  -H "Authorization: Bearer $METABOT_API_SECRET"
```

**Update recurring task:**

```bash
curl -s -X PATCH http://localhost:${METABOT_API_PORT:-9100}/api/schedule/<id> \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"cronExpr":"0 9 * * *","prompt":"Updated prompt","timezone":"Asia/Shanghai"}'
```

**List peers:**

```bash
curl -s http://localhost:${METABOT_API_PORT:-9100}/api/peers \
  -H "Authorization: Bearer $METABOT_API_SECRET"
```

When asked to create a bot:

1. Ask user for platform + credentials + project name + working directory
2. POST /api/bots with installSkills:true
3. Report success — new bot activates within ~3 seconds via PM2 file-watch
