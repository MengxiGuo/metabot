# Consensus Profiles

MetaBot can run a multi-agent consensus task when one bot should not be trusted to make the whole decision alone. A consensus task has two optional roles:

- `panelists`: bots that produce independent takes, critique each other, and preserve dissent.
- `synthesizerBot`: an optional non-panelist bot used first for the final synthesis.

Keep deployment-specific bot names in `bots.json`; do not hardcode them into repository defaults.

```json
{
  "consensusProfiles": {
    "default": {
      "panelists": ["project-alpha", "project-beta", "project-gamma"],
      "synthesizerBot": "project-delta",
      "type": "architectural",
      "stakes": "medium",
      "costCapUsd": 5.0,
      "maxRounds": 5
    }
  }
}
```

Run a preflight before the first real task:

```bash
mb consensus profiles
mb consensus doctor default <chatId> <callerBot>
mb consensus dry-run default <chatId> <callerBot>
```

Start a profiled consensus:

```bash
mb consensus start --profile default "Should this design ship?" \
  --chat <chatId> --caller <callerBot>
```

You can override profile choices at call time:

```bash
mb consensus start --profile default project-alpha,project-beta,project-gamma \
  "Should this design ship?" --synthesizer project-delta
```

Use `doctor` for validation that should not call models. Use `dry-run` when you also want to verify that the caller bot can post a visibility card into the target chat.
