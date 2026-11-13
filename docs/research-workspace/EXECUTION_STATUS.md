# DSH Research Workspace — Execution Status

- 最后更新：2026-11-14
- 当前 Batch：Batch A
- 当前 Phase：Phase 1 — Idea Manager（Completed）；Phase 2 — Session–Idea Binding（Ready to Start）
- 状态：Phase 1 验收门禁通过；Batch A 进行中
- 开发授权：Phase 1–9 整体授权
- 执行模式：Batch 验收门禁 + 自动推进

## 1. 环境与基线

| 项 | 值 |
|---|---|
| 工作区 | `/home/duziyu/dsh-discovery` |
| DSH 版本 | `0.2.2-rc.1` |
| 源码基线 | `dsh-v0.2.2-rc.1` tarball（commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`） |
| Git 仓库 | 否（当前环境无 `git`；工作区由 Phase 0 tarball 解压得到） |
| 用户已有修改 | 无（复制前工作区只有 `docs/research-workspace/*.md`） |
| Node | `v24.22.3` |
| pnpm | `11.28.5`（通过 corepack） |
| GPU | 无；全部测试必须 GPU-free |
| Governance 文档 | Phase 0 时缺失；已按用户提供的治理规范创建 `EXECUTION_GOVERNANCE.md` |

## 2. 阶段状态

| 阶段 | 状态 | 验收门禁 |
|---|---|---|
| Phase 0 | Completed | 五份架构文档已审查并完成 Review Revision |
| Batch A | In Progress | Pending（Phase 2 尚未完成） |
| Phase 1 | Completed | Passed（见 `reports/PHASE_1_COMPLETION.md`） |
| Phase 2 | Ready to Start | Pending |
| Batch B | Pending | Pending |
| Phase 3–4 | Pending | Pending |
| Batch C | Pending | Pending |
| Phase 5–6 | Pending | Pending |
| Batch D | Pending | Pending |
| Phase 7–8 | Pending | Pending |
| Batch E | Pending | Pending |
| Phase 9 | Pending | Pending |

## 3. 数据库 Migration

| 版本 | 内容 | 状态 |
|---|---|---|
| v1 | `research_schema_migrations`、`research_ideas`、`research_idea_relations`、`research_timeline_events` | Applied in Phase 1 tests |

Phase 1 未创建 `research_sessions`、`research_session_idea_links`、`research_session_checkpoints`、`research_outbox` 或任何 Phase 3+ 表。

## 4. 架构决策

- 继续使用 Phase 0 审计确认的架构。
- Phase 1 只实现 Idea Manager；未实现 Session/Memory/Knowledge/Discovery/Orchestrator。
- Parent/Child 只由 `research_ideas.parent_idea_id` 表达；Relation Table 只表达 related_to / derived_from / merged_from / references。
- 不修改 DSH 核心 Agent Loop、Session Event Format、Session Header Schema。
- `research/changed` 使用 `schemaVersion: 1` 的版本化 envelope，在数据库事务提交后发出；listener 失败不回滚已提交数据。
- Phase 2 的 Research Session 创建主路径使用 `ctx.agents.create({ setup })`；`agent/created` fallback 必须先通过首次请求集成测试。

## 5. 当前工作

- Phase 1 代码、测试、README 与完成报告已交付。
- Phase 2 尚未开始；不得提前实现 Memory、Claim、Knowledge Graph、Discovery、Orchestrator。
- Phase 2 需要新增 `research_sessions`、`research_session_idea_links`、`research_session_checkpoints` 与 `research_outbox`，并实现 pending 创建账本、checkpoint 双水位和首次请求集成测试。

## 6. 验收证据

```sh
corepack pnpm exec vitest run \
  packages/research/research-core/tests \
  packages/research/research-tools/tests \
  packages/client/ui-research-workspace/tests
# 6 files, 26 tests passed
```

```sh
corepack pnpm run typecheck
# 5 gates passed
```

另外已通过：

- `corepack pnpm run build:lib:host`、`corepack pnpm run build:lib:client`
- `corepack pnpm run build:check`（host/client aggregate checks）
- `corepack pnpm run lint`（退出码 0；仅既有 unused-directive warning）
- `corepack pnpm run constraints`
- `corepack pnpm run verify-md-links`
- `corepack pnpm run verify-package-readme-model-experience`
- `corepack pnpm run verify-package-readme-limitations`
- `corepack pnpm run verify-translation-pairing`（五个新增 README pair）
- `corepack pnpm run verify-tool-catalog`

## 7. 已知阻塞与风险

- 无当前阻塞。
- 风险：当前环境没有 `git`；无法用 git 记录提交/差异。验收报告使用文件清单与实际测试输出。
- 风险：`pnpm install` 需要网络与时间；若依赖安装失败，后续 Phase 无法完成验收。
- 风险：Phase 2 的标准 SessionController resume 路径仍依赖 `agent/created` fallback；该 fallback 在 Phase 0 审计中为 **Unverified**，必须在 Phase 2 用首次请求集成测试验证。

## 8. 下一步

1. 开始 Phase 2：Session–Idea Binding、Inbox、pending 创建账本、checkpoint 双水位、`research/changed` 消费者。
2. 执行 Phase 2 的首次请求 Prompt/Tool 可见性测试、重复事件处理测试、checkpoint 恢复测试与 Session Dispose/重启一致性测试。
3. 通过 Batch A 全部十项验收后，生成 `reports/BATCH_A_COMPLETION.md`，再进入 Batch B。
