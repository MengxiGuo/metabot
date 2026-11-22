# Task replies from chat

## Transport-only contract

Reply must not change how the model normally decides, asks questions, or executes
work. No Reply instruction is appended to system prompts, user prompts or the
MetaBot skill. Tests compare the complete effective prompt byte-for-byte with
and without a Reply capability for Codex, Claude SDK and Antigravity. Existing
instructions unrelated to this feature remain unchanged.

When the user sends `/reply text`, the bridge checks the current task and its
owner, then passes the answer to an existing native question or the engine's
supported active-input API. It does not add instructions, ask for confirmation,
restart the task, or enqueue a new MetaBot task. Delivery confirmation describes
the engine receipt; model consumption occurs at an engine-supported boundary,
not necessarily in the middle of an already running external tool.

## Verified capability boundaries

- With Codex app-server, native questions and turn steering are available. Free-form replies use `turn/steer` with the
  exact active thread and `expectedTurnId`; rejection is never reported as
  delivery. Isolated real Codex testing confirmed same-turn receipt and a changed
  final answer. Native `requestUserInput` questions retain their question IDs.
- Claude SDK bots retain their existing native structured-question
  answers. A stream-input API exists, but current-turn consumption of arbitrary
  messages has not been established for this integration. Free-form steering is
  not enabled on the basis of a local input-queue write.
- Headless Antigravity bots currently have no verified free-form
  current-turn input adapter. CLI NDJSON multi-turn input is not proof of
  current-turn steering. Unsupported input receives an explicit notice.

The legacy CLI/HTTP question channel is available to explicit callers.

## Routing and safety

`/reply` bypasses the ordinary busy-message queue. Normal text retains its
original queue behavior except when an existing question is waiting for an
answer. Only the original task owner in the same chat can answer. Empty input,
attachments, replies above 16000 JavaScript characters, duplicate submissions,
expired questions and inactive tasks are rejected explicitly. Timeout, failure
or cancellation never grants permission. Native transport ACK is distinguished
from the model's final outcome and from actual Feishu user ingress.

## Validation

Run the targeted suite from the fork checkout.

```bash
cd "$HOME/metabot" && ./node_modules/.bin/vitest run tests/reply-autonomy-policy.test.ts tests/task-question-channel.test.ts tests/reply-command.test.ts tests/codex-user-input.test.ts tests/codex-steer.test.ts tests/codex-build-args.test.ts tests/codex-app-server-client.test.ts tests/claude-executor.test.ts tests/independent-judgment-policy.test.ts tests/antigravity-engine.test.ts --maxWorkers=1 --minWorkers=1
```

```bash
cd "$HOME/metabot" && ./node_modules/.bin/tsc --noEmit
```
