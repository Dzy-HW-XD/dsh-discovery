# Phase 1 — Idea Manager 完成报告

- 日期：2026-11-14
- 阶段：Batch A / Phase 1
- 状态：Completed
- 数据库：v1（`research_schema_migrations`、`research_ideas`、`research_idea_relations`、`research_timeline_events`）
- 结论：Phase 1 验收门禁通过；Phase 2 尚未开始

## 1. 已实现范围

- Idea create / list / get / update / archive。
- 显式状态转换表与回退；同状态写入为 no-op；状态变化写入 timeline。
- 归档不删除；默认列表隐藏，`includeArchived` 可见；恢复状态清除 `archived_at`。
- Parent/Child 仅通过 `research_ideas.parent_idea_id` 表达；无环、单父、`parentOf` / `childrenOf` 查询。
- `related_to`（对称、字典序规范化）、`derived_from`、`merged_from`、`references` 有向关系；重复关系幂等；移除为 `superseded`，不硬删除。
- SQLite v1 migration、WAL、外键、busy timeout、乐观锁 `version`。
- 只追加 Idea timeline：created / updated / status_changed / parent_changed / archived / relation_added / relation_removed。
- `research_idea` 合并工具与 `research` Remote 命名空间。
- 最小 Idea Dashboard：列表、创建、详情、状态、父级、关系、时间线、归档、侧边栏入口。
- Host `research/changed` 版本化事件（`schemaVersion: 1`）与 `api-remotes` 转发白名单。

## 2. 修改的 Packages 与 Files

新增：

- `packages/research/research-core/`
  - `src/types.ts`, `src/errors.ts`, `src/database.ts`, `src/rows.ts`, `src/ideas.ts`, `src/index.ts`
  - `tests/ideas.spec.ts`, `tests/service.spec.ts`
  - `README.md`, `README.zh.md`, `README.i18n.yaml`
- `packages/research/research-tools/`
  - `src/types.ts`, `src/index.ts`
  - `tests/research-idea.spec.ts`, `tests/controller.spec.ts`
  - `README.md`, `README.zh.md`, `README.i18n.yaml`
- `packages/client/ui-research-workspace/`
  - `src/index.ts`, `src/client/index.ts`, `src/client/ResearchPanel.tsx`, `src/client/ResearchPanelIcon.tsx`, `src/client/locales.ts`
  - `tests/research-panel.client.spec.tsx`, `tests/browser-plugin.client.spec.tsx`
  - `README.md`, `README.zh.md`, `README.i18n.yaml`
- `packages/bundle/research-workspace/`
  - `cordis.patch.yml`, `src/index.ts`
  - `README.md`, `README.zh.md`, `README.i18n.yaml`
- `packages/research/README.md`, `README.zh.md`, `README.i18n.yaml`

修改：

- `packages/api/remotes/src/client/index.ts` — 装配 `research` Remote。
- `packages/api/remotes/src/remote-events.ts` — 转发 `research/changed`。
- `packages/api/remotes/package.json`, `tsconfig.client.json`, `tsconfig.host.json` — Research 依赖与工程引用。
- `packages/experimental/liveshare/src/endpoint-classification.ts` — Phase 1 Research Remote endpoint 的 owner-only 分类。
- `tsconfig.base.json`, `tsconfig.host.json`, `tsconfig.client.json` — Research 包路径与工程引用。
- `scripts/verify-package-readme-model-experience.ts` — 登记 Research core / UI / bundle 的 Model Experience 分类。

## 3. 数据库变更

- 新增 `research_schema_migrations`：版本、名称、校验和、应用时间。
- 新增 `research_ideas`：最小 Phase 1 列；无 `workspace_id` / `workspace_path` / `last_session_id`。
- 新增 `research_idea_relations`：有向关系、状态、`group_id`、`supersedes_relation_id`、唯一 active 边。
- 新增 `research_timeline_events`：只追加的 Idea 历史。
- 未创建 `research_sessions`、`research_session_idea_links`、`research_session_checkpoints`、`research_outbox` 或任何 Phase 3+ 表。

## 4. API / Tool / UI 变更

- Remote：`listIdeas`、`getIdea`、`createIdea`、`updateIdea`、`archiveIdea`、`addIdeaRelation`、`removeIdeaRelation`、`listIdeaRelations`、`listTimeline`。
- Tool：单个 `research_idea`，action 为 create / list / get / update / archive / add_relation / remove_relation / list_relations / timeline。
- Event：`research/changed` 在事务提交后发出；listener 失败被隔离，不回滚已提交数据。
- UI：`main` keyed panel `research` 与 `sidebar.panellist` 入口；不修改原生 Conversation 面板或 Session 导航。

## 5. 实际执行的测试

```sh
corepack pnpm exec vitest run \
  packages/research/research-core/tests \
  packages/research/research-tools/tests \
  packages/client/ui-research-workspace/tests
```

结果：**6 个测试文件，26 个测试全部通过**。

覆盖：

- Idea CRUD、乐观锁冲突、状态转换与回退。
- 归档隐藏 / 显式可见 / 恢复。
- Parent/Child 单父、无环、`parentOf` / `childrenOf`。
- `related_to` 规范化、derived / merged / references、幂等、superseded。
- SQLite v1 migration 幂等与重开持久化。
- `research/changed` 版本化 envelope 与 listener 失败隔离。
- `research_idea` 工具 CRUD、关系、失败路径。
- Remote 成功结果与 `research/version-conflict` 映射。
- Dashboard 空状态、列表、详情、创建、错误提示、状态变更、归档过滤、父子关系设置。
- 浏览器插件注册 `main` / `sidebar.panellist`，并在 fiber dispose 后移除。

```sh
corepack pnpm run typecheck
```

结果：5 个 gate 全部通过（Host Typert、host compiler、client compiler、host aggregate check、client aggregate check）。

```sh
corepack pnpm run build:lib:host
corepack pnpm run build:lib:client
corepack pnpm run build:check
```

结果：Host 与 Client 构建成功；`build:check` 的 host/client 两个 aggregate check 全部通过。

```sh
corepack pnpm run lint
corepack pnpm run constraints
corepack pnpm run verify-md-links
```

结果：lint 退出码 0（仅 `packages/experimental/client-ui-cot-translation/src/index.ts` 的既有 unused-directive warning）；constraints 通过；Markdown 链接检查 2354 个文件全部通过。

```sh
corepack pnpm run verify-package-readme-model-experience
corepack pnpm run verify-package-readme-limitations
corepack pnpm run verify-translation-pairing <five README pairs>
corepack pnpm run verify-tool-catalog
```

结果：全部通过。

## 6. 已知限制

- Phase 1 工具全局注册；Session 级组装属于 Phase 2。
- Dashboard 在每次操作后重新读取 Host 状态；尚未订阅转发事件做自动刷新。
- SQLite 调用同步执行；适合小型 Idea CRUD，不适合批量导入。
- 无删除 API；归档与 supersede 是唯一退役路径。
- 当前环境没有 `git`，无法提供 commit 或 staged diff；以文件清单和实际命令输出作为验收证据。

## 7. 延后实现

- Session–Idea binding、Inbox、checkpoint、outbox：Phase 2。
- Claim / Hypothesis / Evidence / ResearchQuestion / ResearchGap / Discovery / Artifact：Phase 3。
- Memory / Context Assembly：Phase 5–6。
- Knowledge Graph / Discovery Engine：Phase 7–8。
- Autonomous Research Orchestrator：Phase 9。

## 8. 下一批次准入

Phase 1 验收门禁通过。Batch A 尚未完成，因为 Phase 2 的 Session–Idea Binding 与首次请求集成测试尚未实现。下一步为 Phase 2，不提前进入 Batch B。
