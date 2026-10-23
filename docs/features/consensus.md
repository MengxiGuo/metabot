# Consensus Profiles

MetaBot can run a multi-agent consensus task when one bot should not be trusted to make the whole decision alone. A consensus task has two optional roles:

- `panelists`: bots that produce independent takes, critique each other, and preserve dissent.
- `synthesizerBot`: an optional non-panelist bot used first for the final synthesis.

## Independent Judgment Requirement

Consensus is an adversarial review process, not majority voting. Responses from panelists and the synthesizer are advisory arguments, not authority.

- Evaluate each claim, objection, and counterargument separately against its premises, evidence, logic, and relevance.
- Do not accept a conclusion because it is repeated, confidently phrased, or supported by more bots. Agreement count is not evidence.
- Retain the original position when a rebuttal is weak; revise it only when stronger evidence or reasoning warrants a change, and record what changed and why.
- Resolve factual disputes with primary sources, code, tests, or logs when feasible. Preserve unresolved uncertainty and dissent rather than forcing agreement.
- The calling bot owns the final decision and should identify which peer arguments it accepted, rejected, or left unresolved before taking action.

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


### Consensus 停止与执行设置

在发起群里向发起 bot 或参与 bot 发送 `/stop` 或单独的 `stop`（多人群仍遵守原有 @ 提及要求），会取消本群关联的所有活动 consensus，并停止当前普通任务。命中 consensus 时不会顺带暂停日常调度。其他群的讨论不受影响。

按任务停止：`mb consensus stop <taskId>`；查看状态：`mb consensus get <taskId>`。API 是 `POST /api/consensus/:taskId/stop`。取消先返回 `stopping`，待参与者执行收尾后为 `cancelled`，结果内状态为 `aborted`，不是成功完成。重复停止不会重跑任务；已有工具副作用不会被撤销，已发出的结果和原生会话记录保留。服务重启前创建的旧任务无法补挂新取消控制器。

独立讨论会话首次执行继承来源群同一 bot 的账号、模型、引擎、思考档位与工作目录，不继承原生会话 ID 或历史。继承只发生一次，后续阶段不覆盖讨论中自动换号的结果。

反重力额度耗尽：明确的 `Resets in ...` 按实际剩余时长加 60 秒余量避让，按 runner 与额度组共享，并在服务重启后恢复；未知恢复时间仍冷却 5 分钟。不会因取消而换号重跑，也不会放宽已有的执行进展保护。
