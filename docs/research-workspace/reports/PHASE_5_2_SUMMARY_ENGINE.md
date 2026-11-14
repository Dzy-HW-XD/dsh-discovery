# Phase 5.2 — Session Summary Engine Completion Report

- 日期：2026-11-14
- 阶段：Batch C / Phase 5.2
- 状态：完成，等待 Phase 5.3 授权
- 数据库：Research schema v5
- 范围：确定性 Summary Engine 与生命周期集成；未实现 Memory Extractor、Retrieval、Context Builder、FTS、Review UI

## 1. 实际实现范围

- Migration v5：扩展 `research_session_summaries`。
- `ResearchSummaryStore`：结构化 Summary 读写、版本、supersede、幂等键。
- 新 Host-only 包 `@deepseek-ai/dsh-research-memory`：
  - `SummaryEngine`：确定性提取。
  - `SummaryCoordinator`：Outbox worker、重试、崩溃恢复、周期 drain。
- `research-tools`：
  - `SummaryCoordinator` 生命周期接线。
  - `summarizeSession` Remote。
  - `session/disposed` 与 `finalizeSession` 触发 summary。
  - `turn/end` 由事件处理器写入 summary Outbox 任务。
- Outbox：
  - `claimPending` / `pendingCount` / `nextDueAt` / `recoverProcessing` 支持 topic 过滤。
  - 事件处理器只领取 `research/session-event`。
  - Summary worker 只领取 `research/session-summary`。

## 2. Summary 数据结构

表 `research_session_summaries` 新增：

- `objective`
- `key_findings_json`
- `hypotheses_created_json`
- `hypotheses_validated_json`
- `hypotheses_rejected_json`
- `decisions_json`
- `failed_attempts_json`
- `unresolved_questions_json`
- `next_steps_json`
- `generated_artifacts_json`
- `source_references_json`
- `generation_status`
- `generation_error`
- `idempotency_key`
- `updated_at`

每个引用使用：

```ts
interface SummaryReference {
  entityType: string
  entityId: string
  label: string
  version?: number
}
```

Summary 只引用 Claim / Evidence / Hypothesis / Question / Gap / Decision / Discovery / Artifact / Source，不复制完整实体。

## 3. 事件触发调用链

```text
turn/end
  → session/event
  → ResearchSessionEventProcessor.observe
      → research_outbox: research/session-event
      → research_outbox: research/session-summary
  → SummaryCoordinator.pump / timer
      → claim summary topic
      → SessionQuery.readSession (transaction 外)
      → SummaryEngine.generate
      → ResearchSummaryStore.insert (事务)
      → outbox complete
```

其它触发：

- `session/disposed` → 最后 `scanSession` → `coordinator.enqueue` → pump。
- `finalizeSession` Remote → enqueue → pump。
- `summarizeSession` Remote → enqueue → flush → 返回最新 Summary。
- 启动 `coordinator.start()` → 恢复 processing 的 summary 任务。
- 启动 reconciliation → `events.reconcile()` → `summaryCoordinator.flush()`。

`Session.dispose` 仍不等于 Research finalize；summary 生成不会改变 Session 的 research binding 状态。

## 4. Outbox 处理机制

- Topic：`research/session-summary`。
- 幂等键：`session-summary:<session>:<start>:<end>`。
- 成功后同一事务写 summary/版本并标记 outbox done。
- 失败：
  - 保留 outbox pending/processing 状态；
  - 指数退避；
  - 10 次后 dead；
  - 不伪造 Summary 行。
- 崩溃：
  - `coordinator.start()` 只恢复 summary topic 的 processing 行；
  - 事件处理器只恢复 event topic；
  - 重试时按幂等键命中已提交 Summary 直接完成。

`summary` 写入与 Outbox 完成是两个事务；如果 Summary 已提交而 Outbox 未完成，重试会命中幂等键并完成 Outbox，不会重复插入。

## 5. Summary 质量规则

- `objective`：优先第一条直接用户消息；否则 Idea researchQuestion/title。
- key findings：仅 observed/reported Claim 与 Discovery。
- validated：Hypothesis status = supported。
- rejected：Hypothesis status = rejected。
- failed attempts：refutes/contradicts Evidence 与 rejected Hypothesis。
- unresolved：open/investigating Question 与 candidate/reviewed Gap。
- decisions / artifacts：由 Research DB 实体提供。
- inferred/speculative Claim 不进入 key findings。
- 空 Session 生成最小 Summary，不虚构成果。
- 所有引用保留 entity id，历史版本由 `summary.version` 与 `supersedes_id` 保留。

## 6. 测试结果

```sh
corepack pnpm exec vitest run \
  packages/research/research-core/tests \
  packages/research/research-tools/tests \
  packages/research/research-memory/tests \
  packages/client/ui-research-workspace/tests
```

结果：**13 个测试文件，76 个测试全部通过**。

新增覆盖：

- Summary Engine：
  - Claim / Evidence / Hypothesis / Question / Gap / Decision / Discovery / Artifact 引用。
  - Hypothesis validated/rejected。
  - failed attempts。
  - 空 Session。
  - 来源引用与 input hash。
- Summary Coordinator：
  - `turn/end` → outbox → summary。
  - 重复 `turn/end` 幂等。
  - 后续 turn 新版本、旧版本 superseded。
  - processing 行崩溃恢复。
  - 读取失败重试后成功。
  - 多 Session / 多 Idea 隔离。
- 真实生命周期：
  - 真实 AgentLoop + JSONL Session + SQLite SessionQuery。
  - Mock LLM 完成一次 turn。
  - `summarizeSession` Remote 返回结构化 Summary。
- Migration：
  - v4 → v5 保留旧 Summary 行。
  - v5 新列存在。
  - 既有 v1 → v5 / v3 → v5 测试更新。

## 7. 质量门禁

```sh
corepack pnpm run typecheck        # 5 gates passed
corepack pnpm run build:lib:host
corepack pnpm run build:lib:client
corepack pnpm run build:check      # 2 gates passed
corepack pnpm run lint             # passed, one pre-existing warning
corepack pnpm run hygiene          # 23 gates passed
corepack pnpm run constraints
corepack pnpm run verify-md-links
corepack pnpm run verify-package-readme-model-experience
corepack pnpm run verify-package-readme-limitations
corepack pnpm run verify-tool-catalog
corepack pnpm run verify-translation-pairing <README pairs>
```


## 8. Git

- 待提交 Phase 5.2 独立 commit。
- Phase 5.0 `607e13d3`、Phase 5.1 `79f7100f` 已在 origin/main。

## 9. 已知限制

- 只做确定性生成；未启用 LLM enrichment。
- 其他 Session 对 Hypothesis 的状态更新不会归因到后一个 Session，因为 Phase 3 实体没有 update-session 列；跨 Session 的 Claim 引用已通过 Evidence 关联覆盖。
- Summary 读取完整 Session log，不流式处理超大 Session。
- 未实现 Extractor、Retrieval、Context Builder、FTS、Review UI、Memory 工具。
- Summary 尚未进入 Idea Workspace UI。

## 10. 下一阶段

Phase 5.2 完成并暂停；等待 Phase 5.3 Memory Extractor 授权。
