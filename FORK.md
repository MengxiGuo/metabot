# MengxiGuo/metabot — Personal Fork

This is a personal fork of [xvirobotics/metabot](https://github.com/xvirobotics/metabot)
with three substantial additions on top of upstream `main` (last sync point:
commit `c84ae84`).

> All upstream functionality (Claude Code / Kimi Code / Codex CLI engines, Feishu /
> Telegram / WeChat / Web UI bridges) is preserved. This fork **adds** features,
> doesn't modify or remove existing behavior.

---

## What's added in this fork

### 1. Gemini CLI engine

A fourth engine alongside Claude / Kimi / Codex. Wraps Google's [gemini-cli](https://github.com/google-gemini/gemini-cli)
(installed separately via `npm install -g @google/gemini-cli`) so a bot can use
your Google AI Pro / Ultra subscription as its model backend.

Auto-fallback chain: `gemini-3.1-pro-preview → gemini-3-flash-preview` when
the Pro-tier daily quota is exhausted. Session continuity drops `--resume` on
fallback to avoid cross-model state hangs.

Config a bot for Gemini in `bots.json`:

```json
{
  "name": "gemini",
  "engine": "gemini",
  "feishuAppId": "cli_xxx",
  "feishuAppSecret": "...",
  "defaultWorkingDirectory": "/home/user/some-project",
  "gemini": {
    "model": "gemini-3.1-pro-preview",
    "approvalMode": "yolo",
    "contextWindow": 1048576
  }
}
```

### 2. Inter-bot multi-agent collaboration framework

Two bots running under the same metabot can now talk to each other in a
group chat with both sides visible to the user:

```bash
MB_CALLER_BOT=quatumtrading-claude  mb talk gemini  <chatId>  "<prompt>"
```

The `MB_CALLER_BOT` env var triggers metabot to post the outgoing prompt as
a visible card from the caller's identity before invoking the target — so
the whole inter-bot dialogue is observable in the real Feishu group.

When inter-bot calls are detected (caller bot != target bot, real `oc_...`
chatId), metabot auto-injects a **critical-evaluation framing prefix** into
the target's prompt: target's default mode shifts from "be agreeable" to
"honest stress-test", with explicit rules against cheap `我同意 + 补充`
patterns, nitpicking, and strawmanning. This prevents LLM-to-LLM dialogue
from collapsing into mutual rubber-stamping.

### 3. N-Bot Consensus Protocol

A 5-phase state machine for reasoned multi-bot consensus (N up to 4):

```bash
mb consensus start  <bot1,bot2[,bot3]>  "<problem>"  <type>  <stakes>  <chatId>  <callerBotName>
```

Phases: Independent Take → Cross-Critique → Falsification Round →
Synthesis + Adversarial Verifier → Final Dissent. The protocol includes
four anti-cheap-alignment mechanisms:

- **Falsification-Weighted synthesizer queue** — most-criticized bot must
  synthesize first (forces self-defense vs. dismissal)
- **Delta Mandate sign-off** — critics must list preserved / reframed /
  dropped points (no "Approved" rubber-stamp)
- **Synthesis Fork** — 2 consecutive Delta rejects trigger forced role
  transfer to the rejecting critic (max 2 transfers before escalating to user)
- **Source-Tracing keyword check** — dropped points must keyword-match the
  critic's prior raw output (anti-fork-fraud)

Output is structured: `agreedPoints` (with falsification scenarios that
failed), `standingDissents` (with required scenarios), `riskTags`,
`empiricalQuestions` (deferred to measurement), `pureDifferences` (demoted
preferences).

Group visibility: every phase event renders a real card in the trigger
chatId so the user can watch the bots stress-test each other mid-flight
and intervene before consensus closes.

### 4. Gemini Pro-tier quota footer

Gemini bot reply cards now show real-time quota in the footer, matching
Claude's `ctx | $cost | model | duration` style. Data source is Google's
`https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` endpoint
(uses your existing `~/.gemini/oauth_creds.json` token, no extra auth).

```
ctx: 104.4k/1049k (10%) | quota: 27.3% used (还有 16.1h reset) | gemini-3.1-pro-preview | 12.6s
```

---

## Setup (for someone using Claude Code to install)

Assuming you already use upstream metabot's general setup (`Node.js 20+`,
`pm2`, a Feishu app), here are the **extra** steps for this fork's features:

### Step 0: Clone the fork

```bash
git clone https://github.com/MengxiGuo/metabot.git ~/metabot
cd ~/metabot
npm install
npm run build
```

> Do **not** run upstream's `install.sh` — that one fetches `xvirobotics/main`,
> which lacks the fork's commits. Just `npm install && npm run build`
> directly in this cloned dir.

### Step 1: Install gemini-cli (if using the Gemini engine)

```bash
npm install -g @google/gemini-cli
```

Then authenticate once interactively (this saves OAuth creds to `~/.gemini/`):

```bash
gemini   # follow the browser prompt; sign in with your Google AI Pro account
```

Quit the interactive session after auth completes (`Ctrl+C`). The fork's
quota footer pulls quota from `~/.gemini/oauth_creds.json` automatically —
no further config needed.

### Step 2: Configure bots.json

Copy `bots.example.json` to `bots.json` and edit. Add a Gemini bot block
if you want to use the Gemini engine (see §1 above). Add a Claude bot if
you want to use Claude Code.

If you want to use the inter-bot framework or consensus protocol, you need
at least **2 bots in the same Feishu group chat** (e.g. one Claude bot
named `my-claude` and one Gemini bot named `my-gemini`), and you must
**manually invite both bot apps to the group** in Feishu.

### Step 3: Start

Use whichever process manager you prefer:

```bash
# pm2
pm2 start ecosystem.config.cjs

# or just node
node dist/index.js
```

### Step 4: Verify

In your Feishu group, send a message to one of the bots. Reply card
appears. If you configured a Gemini bot, its footer should show the new
`quota: X% used (还有 Yh reset)` format.

To verify inter-bot collaboration, from the group send something like:

> 拉 gemini 讨论一下 <a substantive question>

The Claude bot (or whichever is the orchestrator) will trigger
`mb talk gemini ...` and both prompt + reply cards appear in the group.

To verify the consensus protocol:

```bash
mb consensus start my-claude,my-gemini "Some architectural question" architectural medium <your_group_chatId> my-claude
```

You'll see phase cards rendered live in the group over 3-5 minutes.

---

## Environment overrides (optional)

The fork respects these env vars when set; defaults match the install
convention `$HOME/metabot`:

```
METABOT_HOME              Defaults to $HOME/metabot. Used to locate data/.
METABOT_ARCHIVE_ROOT      Defaults to $METABOT_HOME/data/messages. Where the
                          message archive (incoming + outgoing) is stored.
GEMINI_OAUTH_CREDS_PATH   Defaults to $HOME/.gemini/oauth_creds.json. Override
                          if your gemini-cli OAuth file lives elsewhere.
CODE_ASSIST_ENDPOINT      Defaults to https://cloudcode-pa.googleapis.com.
                          Don't override unless Google changes endpoints.
```

---

## Known limitations

- **N=2 is the only tested consensus configuration.** The protocol code is
  N-aware (state stored in `Map<botName, *>`) but N=3+ with Codex/Kimi
  hasn't been smoke-tested end-to-end.
- **DM chats cannot run consensus.** The membership pre-flight requires all
  target bots to be in the chat — 1v1 DMs can only have one bot.
- **No quota tracker for non-Pro Gemini accounts.** The `retrieveUserQuota`
  endpoint is part of Google's Code Assist auth flow; free-tier users may
  not see this endpoint return populated buckets.
- **Inter-bot critical-eval framing is opinionated.** It forces target bots
  into adversarial-review mode by default. Some lightweight tasks would
  prefer just a delegation — there is no opt-out flag yet.

---

## License + attribution

This fork inherits upstream metabot's MIT license. All credit for the
underlying metabot framework goes to [xvirobotics](https://github.com/xvirobotics/metabot)
and its contributors.

The additions in this fork (Gemini engine wrapper, inter-bot framework,
consensus protocol, quota footer) were developed for personal use and are
provided as-is.
