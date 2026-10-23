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
- `/account` shows the current safe alias.
- `/account list` shows configured aliases, never credentials or email
  addresses.
- `/account use backup` selects an account and starts a fresh conversation on
  the next request.
- `/account next` advances once in configuration order. It is an explicit user
  action, not a quota/error-triggered fallback.
- `/account reset` returns to `defaultAccount`.

Account switching is refused while a task is running. A quota, authentication,
eligibility, permission, or provider error is returned to the user without
trying another account.

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
