# Batch A — Idea 与 Session 基础设施完成报告

- 日期：2026-11-14
- 批次：Batch A（Phase 1–2）
- 状态：Phase 1 / Phase 2 功能与自动化验收通过；Batch A 验收门禁通过
- 下一批次：Batch B / Phase 3（未在本批次实现）

## 1. 已实现范围

### Phase 1 — Idea Manager

- Idea create / list / get / update / archive。
- 显式状态转换与回退、append-only Idea timeline。
- Parent/Child 仅由 `research_ideas.parent_idea_id` 表达；无环、单父。
- `related_to`（对称、规范化）、`derived_from`、`merged_from`、`references`；移除使用 `superseded`。
- SQLite v1 migration、WAL、外键、busy timeout、乐观锁。
- `research_idea` 工具、`research` Remote、最小 Idea Dashboard、`research/changed` 事件。

### Phase 2 — Session–Idea Binding

- `research_sessions`、`research_session_idea_links`、`research_session_checkpoints`、`research_outbox`。
- Research Session 创建主路径：`ctx.agents.create({ setup })`。
- 创建前写入 pending 绑定；setup 中安装 Research prompt/context/scoped tool。
- 标准 UI Session / Resume 使用 `agent/created` fallback；首次请求集成测试验证。
- 已有 Session 绑定、解绑回 Inbox、同一 Idea 多 Session、Session 列表与详情。
- Inbox Session：`session/created` 登记；启动时补登记已有普通 Session；跳过 subagent。
- 生命周期：`session/created`、`session/event`、`session/disposed`、`agent/created`、显式 `finalizeSession`。
- `session/disposed` 不自动 finalize；Research finalize 是独立业务操作。
- 两个 checkpoint 水位：`last_seen_seq` 与 `last_successfully_processed_seq`。
- Session event 通过 outbox 幂等处理；重复 event 不重复推进；gap 不跳过；崩溃后恢复 pending/processing 行。
- 启动 reconciliation：pending 创建恢复、Inbox 补齐、Session log 与 checkpoint 对账。
- UI 最小 Session 区域：创建研究会话、打开原生 Conversation、解绑、finalize、Inbox 绑定。
- 非研究 Session 不注入 Research prompt/tools；Inbox 只有在用户绑定 Idea 后才获得 Research composition。
- Client 程序只看到 Research wire types；Host 服务、Session Query Reader 与 Agent 组合不进入 Client 编译面，避免 Host/Client `Context.sessions` 声明合并冲突。

## 2. 数据库结构

Migration v2 新增：

- `research_sessions`
- `research_session_idea_links`
- `research_session_checkpoints`
- `research_outbox`

Migration v2 扩展：

- `research_ideas`: `workspace_id`, `workspace_path`, `last_session_id`
- `research_idea_relations`: `source_session_id`, `source_event_seq`, `metadata_json`
- `research_timeline_events`: `session_id`

Migration 可从既有 v1 数据库升级；`research_schema_migrations` 记录 v1/v2。

## 3. 修改的 Packages 与 Files

新增/修改：

- `packages/research/research-core/src/database.ts` — v2 migration。
- `packages/research/research-core/src/sessions.ts` — Session 绑定、Inbox、checkpoint、finalize。
- `packages/research/research-core/src/outbox.ts` — 持久 outbox、claim、retry、recover。
- `packages/research/research-core/src/events.ts` — 双水位 event processor、gap、恢复、reconcile。
- `packages/research/research-core/src/index.ts` — 暴露 Session/outbox/event 服务。
- `packages/research/research-core/package.json` / `tsconfig.json` — 移除对 Session Query 的依赖;Reader 由 Host 注入。
- `packages/research/research-core/src/errors.ts` — session/event/outbox/workspace/model 错误码。
- `packages/research/research-tools/src/composition.ts` — prompt/context/scoped tool 安装、幂等与卸载。
- `packages/research/research-tools/src/session-creator.ts` — `ctx.agents.create({ setup })` 创建路径。
- `packages/research/research-tools/src/views.ts` — Session wire views。
- `packages/research/research-tools/src/types.ts` — Session request/view 类型。
- `packages/research/research-tools/src/index.ts` — Session Remote、lifecycle listeners、startup reconcile。
- `packages/research/research-tools/tsconfig.host.json` / `tsconfig.client.json` — 拆分 Host 服务面与 Client wire-type 面。
- `packages/api/remotes/tsconfig.host.json` / `tsconfig.client.json` — 引用 research-tools 对应编译面。
- `tsconfig.host.json` — 根聚合改为引用 research-tools Host 面。
- `packages/research/research-core/locale/*.json`、`packages/research/research-tools/locale/*.json`、`packages/client/ui-research-workspace/locale/*.json` — 8 种发布语言的插件元数据。
- `scripts/product-package-policy.ts` — 将 Research Core、Research UI 与 Research Bundle 声明为可选产品包。
- `scripts/rescope-vendor.ts` — 跳过 cordis preset id 的误报，并对齐 vendored README 的 V17 标记。
- `packages/client/ui-research-workspace/src/client/ResearchPanel.tsx` — Session/Inbox UI。
- `packages/client/ui-research-workspace/src/client/index.ts` — Session Remote wiring、`uiWorkspace.openSession`。
- `packages/client/ui-research-workspace/src/client/locales.ts` — Session/Inbox 文案。
- `packages/experimental/liveshare/src/endpoint-classification.ts` — Session Remote owner-only 分类。
- `packages/research/research-core/README.md` / `.zh.md` — Phase 2 数据库与 checkpoint 说明。
- `packages/research/research-tools/README.md` / `.zh.md` — Session API、composition、fallback 说明。
- `packages/client/ui-research-workspace/README.md` / `.zh.md` — Session/Inbox UI 说明。
- `packages/research/README.md` / `.zh.md` — Batch A 范围说明。
- `packages/bundle/research-workspace/README.md` / `.zh.md` — Phase 2 bundle 说明。
- `docs/research-workspace/EXECUTION_STATUS.md` — Batch A 状态。
- `docs/research-workspace/reports/BATCH_A_COMPLETION.md` — 本报告。

## 4. 实际执行的测试

```sh
corepack pnpm exec vitest run \
  packages/research/research-core/tests \
  packages/research/research-tools/tests \
  packages/client/ui-research-workspace/tests
```

结果：**9 个测试文件，44 个测试全部通过**。

覆盖：

- Idea CRUD、乐观锁、状态转换、归档、父子关系、关系类型、timeline。
- SQLite v1→v2 upgrade、schema presence、reopen persistence。
- Session pending→active、Inbox、link/unlink、finalize、同一 Idea 多 Session。
- checkpoint seen/success/gap/summary、inherited prefix、重复事件幂等。
- outbox enqueue/claim/complete/retry/recover、崩溃恢复、duplicate key。
- Research Session setup 首次请求可见 Idea brief + `research_session` tool。
- 标准 `ctx.agents.create`（无 setup）的 `agent/created` fallback 首次请求可见。
- Session resume 的 `agent/created` fallback 首次请求可见。
- 非研究 Inbox Session 不注入 Research prompt/tools。
- live link 后安装、unlink 后移除 scoped tool。
- Session dispose 不 finalize；finalize 后 DSH Session 仍存在。
- UI Session 创建/打开、Inbox 绑定、finalize、归档过滤。
- 浏览器插件注册与 disposal。

```sh
corepack pnpm run typecheck
```

结果：5 个 gate 全部通过（Host Typert、host compiler、client compiler、host aggregate check、client aggregate check）。

```sh
corepack pnpm run build:lib:host
corepack pnpm run build:lib:client
corepack pnpm run build:check
```

结果：Host/Client 构建成功；`build:check` 两个 aggregate check 全部通过。

```sh
corepack pnpm run hygiene
```

结果：23 个 gate 全部通过（含 vendor rescope、plugin locale metadata、client UI i18n、product package classification、publint、package dependencies）。

```sh
corepack pnpm run lint
corepack pnpm run constraints
corepack pnpm run verify-md-links
corepack pnpm run verify-package-readme-model-experience
corepack pnpm run verify-package-readme-limitations
corepack pnpm run verify-translation-pairing <README pairs>
corepack pnpm run verify-tool-catalog
```

结果：全部通过；lint 仅保留既有的 `client-ui-cot-translation` unused-directive warning。`verify-client-ui-i18n` 通过（1259 个 Client UI 源文件使用 locale-owned copy）。

## 5. Batch A 验收门禁

| 验收项 | 结果 |
|---|---|
| 1. Idea CRUD 集成测试 | Passed |
| 2. Idea 关系测试 | Passed |
| 3. 状态转换测试 | Passed |
| 4. SQLite Migration 和重启测试 | Passed（含 v1→v2 upgrade） |
| 5. Session 创建与绑定测试 | Passed |
| 6. Inbox Session 测试 | Passed |
| 7. 首次请求 Prompt / Tool 可见性测试 | Passed（setup 与 agent/created fallback） |
| 8. 重复 Event 处理测试 | Passed |
| 9. Checkpoint 恢复测试 | Passed |
| 10. Session Dispose 和重启一致性测试 | Passed（dispose 不 finalize；resume fallback） |

Batch A 验收门禁通过。

## 6. 已知限制与遗留问题

- 真实 Web 浏览器 E2E 未执行；UI 证据为 jsdom 组件测试 + 真实 Cordis/SlotRegistry 注册测试。
- `hygiene` 中发现并修复了 Phase 1 遗留的 locale metadata、Client UI 硬编码文案与可选产品包分类问题；`scripts/rescope-vendor.ts` 的两处基线断言按当前仓库内容对齐。
- `agent/created` fallback 已验证 Prompt/Context/Tool 首次请求可见；安装失败目前只记录 Host warning，尚未向用户显示 UI notice。
- Session event 处理是单进程串行 outbox pump；多进程/多 writer 并发不在 Phase 2 v1 范围内。
- Outbox gap 重试使用 1 秒 timer；跨越进程重启的 gap 需要下次启动 reconciliation 补齐。
- `research_sessions.branch_id` 与 `research_branches` 未实现；分支属于后续阶段。
- Research-created Session 不设置自定义 title；Session title 仍由 DSH 原生流程管理。
- Research Session 的 Agent preset 选择未实现；创建时使用当前默认模型。
- Workspace 绑定 API 已支持，UI 尚未暴露 Workspace 选择器。

## 7. 延后内容

- Phase 3：Claim、Evidence、Hypothesis、ResearchQuestion、ResearchGap、Discovery、Artifact、Branch。
- Phase 4：完整 Idea Workspace UI。
- Phase 5–6：Memory、Context Assembly。
- Phase 7–8：Knowledge Graph、Discovery Engine。
- Phase 9：Autonomous Research Orchestrator。

## 8. 下一批次准入

Batch A 通过全部验收门禁，按整体授权进入 Batch B / Phase 3。Phase 3 尚待实现，不得将其视为已完成。
