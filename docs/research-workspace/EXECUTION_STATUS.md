# DSH Research Workspace — Execution Status

- 最后更新：2026-11-14
- 当前 Batch：Batch B / Phase 3（Ready to Start）
- 已完成 Batch：Batch A（Phase 1–2）
- 开发授权：Phase 1–9 整体授权
- 执行模式：Batch 验收门禁 + 自动推进

## 1. 环境与基线

| 项 | 值 |
|---|---|
| 工作区 | `/home/duziyu/dsh-discovery` |
| 远端 | `https://github.com/Dzy-HW-XD/dsh-discovery`（private） |
| DSH 版本 | `0.2.2-rc.1` |
| 源码基线 | `dsh-v0.2.2-rc.1` tarball（commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`） |
| Git | 已安装；`main` 跟踪 `origin/main` |
| Node | `v24.22.3` |
| pnpm | `11.28.5`（通过 corepack） |
| GPU | 无；全部测试 GPU-free |

## 2. 阶段状态

| 阶段 | 状态 | 验收门禁 |
|---|---|---|
| Phase 0 | Completed | 五份架构文档已审查并完成 Review Revision |
| Batch A | Completed | Passed（见 `reports/BATCH_A_COMPLETION.md`） |
| Phase 1 | Completed | Passed |
| Phase 2 | Completed | Passed |
| Batch B | Ready to Start | Pending |
| Phase 3 | Ready to Start | Pending |
| Phase 4 | Pending | Pending |
| Batch C | Pending | Pending |
| Phase 5–6 | Pending | Pending |
| Batch D | Pending | Pending |
| Phase 7–8 | Pending | Pending |
| Batch E | Pending | Pending |
| Phase 9 | Pending | Pending |

## 3. 数据库 Migration

| 版本 | 内容 | 状态 |
|---|---|---|
| v1 | `research_schema_migrations`、`research_ideas`、`research_idea_relations`、`research_timeline_events` | Applied（Phase 1） |
| v2 | `research_sessions`、`research_session_idea_links`、`research_session_checkpoints`、`research_outbox`；Idea/Relation/Timeline 扩展列 | Applied（Phase 2） |

Migration v1→v2 升级测试通过；重复打开幂等。

## 4. 架构决策

- 继续使用 Phase 0 审计确认的架构。
- Phase 1 只实现 Idea Manager；Phase 2 只实现 Session binding、event processing 与 recovery。
- Parent/Child 只由 `research_ideas.parent_idea_id` 表达；Relation Table 只表达 related_to / derived_from / merged_from / references。
- 不修改 DSH 核心 Agent Loop、Session Event Format、Session Header Schema。
- Research Session 创建主路径使用 `ctx.agents.create({ setup })`。
- 标准 UI 创建/恢复路径使用 `agent/created` fallback；首次请求 Prompt/Context/Tool 可见性已由集成测试验证。
- `last_seen_seq` 只记录观察进度；`last_successfully_processed_seq` 只在 outbox 处理事务提交后推进。
- `session/disposed` 只触发最终扫描，不等于 Research finalize；finalize 是显式业务操作。
- Inbox Session 不注入 Research prompt/tools；绑定 Idea 后才安装；解绑时移除。
- `research-tools` 使用 host/client 双编译面：Client 只包含 wire types；Host 服务与 Session Query Reader 不进入 Client 程序。
- `research-core` 不依赖 Session Query；Host 的 `ResearchSessionLogReader` 由 `research-tools` 注入，避免 Client 程序加载 Host 包。
- Phase 2 不创建 `research_branches`，不实现 Memory、Claim、Evidence、Knowledge Graph、Discovery、Orchestrator。

## 5. 当前工作

- Batch A 已完成并生成完成报告。
- Batch B / Phase 3 尚未开始。
- 下一阶段将实现 Research Artifact Database（ResearchQuestion、Hypothesis、Claim、Evidence、ResearchGap、Discovery、Artifact、Versioning、Provenance、Timeline）。

## 6. 验收证据

```sh
corepack pnpm exec vitest run \
  packages/research/research-core/tests \
  packages/research/research-tools/tests \
  packages/client/ui-research-workspace/tests
# 9 files, 44 tests passed
```

```sh
corepack pnpm run typecheck
# 5 gates passed
```

```sh
corepack pnpm run build:lib:host
corepack pnpm run build:lib:client
corepack pnpm run build:check
corepack pnpm run hygiene       # 23 gates passed
corepack pnpm run lint
corepack pnpm run constraints
corepack pnpm run verify-md-links
corepack pnpm run verify-package-readme-model-experience
corepack pnpm run verify-package-readme-limitations
corepack pnpm run verify-tool-catalog
```

## 7. 已知阻塞与风险

- 无当前阻塞。
- 真实 Web 浏览器 E2E 未执行；UI 证据为 jsdom 组件测试 + 真实 Cordis/SlotRegistry 注册测试。
- `agent/created` fallback 安装失败目前只记录 Host warning，未向用户显示 notice。
- Session event 处理是单进程串行 outbox pump；多进程并发不在 Phase 2 v1 范围。
- Outbox gap 重试使用 1 秒 timer；跨进程 gap 依赖下次启动 reconciliation 补齐。
- `research_branches`、Research Session title/preset 选择、UI Workspace 选择器尚未实现。
- 当前 Git 工作区在 Batch A 实现后尚未提交；需要提交并推送后作为可追溯基线。
- `hygiene` 已完成：23/23 gate 通过；Phase 1 遗留的 locale metadata、Client UI 硬编码文案和可选产品包分类已补齐。

## 8. 下一步

1. 提交并推送 Batch A 实现。
2. 开始 Batch B / Phase 3：Research Artifact Database。
3. Phase 3 通过验收后进入 Phase 4，再进入 Batch C。
