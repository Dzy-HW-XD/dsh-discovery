# Phase 5.1 — Memory Store Completion Report

- 日期：2026-11-14
- 阶段：Batch C / Phase 5.1
- 状态：完成，等待 Phase 5.2 授权
- 数据库：Research schema v4
- 范围：仅 Memory Store；未实现 Summary、Extractor、Retrieval、FTS、Workspace UI

## 1. 实现范围

### 数据库

Migration v4 新增：

- `research_memory_records`
- `research_memory_versions`
- `research_memory_sources`
- `research_memory_relations`
- `research_memory_conflicts`
- `research_memory_selections`

关键约束：

- `epistemic_status`：`verified / supported / inferred / unverified / disputed / refuted`。
- `lifecycle_status`：`candidate / active / superseded / rejected / archived`。
- 两者是独立列，不合并。
- `(idea_id, memory_type, content_hash)` 唯一，用于精确去重。
- 所有 Memory 按 `idea_id` 隔离。
- 版本、来源、关系、冲突、Selection 均持久化。
- 更新 Memory 写新版本，历史版本不覆盖。
- 冲突只标记，不删除、不自动合并。
- Selection 记录注入层级、rank、原因与 token 估算。

### 代码

新增：

- `packages/research/research-core/src/memory-types.ts` — 类型、枚举、品牌 id。
- `packages/research/research-core/src/memory-repository.ts` — SQL/row mapping。
- `packages/research/research-core/src/memory-store.ts` — 领域校验、事务、版本、来源、冲突。
- `packages/research/research-core/src/timeline.ts` — 共享 timeline 写入。
- `packages/research/research-core/tests/memory.spec.ts` — Store 与迁移测试。

修改：

- `packages/research/research-core/src/database.ts` — schema v4 / migration v4。
- `packages/research/research-core/src/errors.ts` — Memory 错误码。
- `packages/research/research-core/src/index.ts` — 暴露 `ctx.researchCore.memory`。
- `packages/research/research-tools/src/index.ts` — Remote 错误码映射。
- `packages/research/research-core/README.md` / `.zh.md` — Memory Store 说明。
- 现有迁移测试更新为 v1–v4。

## 2. 领域行为

- `createMemory`：
  - 校验 Idea、标题、内容、confidence。
  - 校验 Source/Relation 端点。
  - Fact/Finding 的 `verified/supported` 必须有 provenance。
  - Preference 必须有显式 Session 来源。
  - 精确重复内容返回既有 Memory，并附加新来源，不重复创建。
  - 同一事务写 Memory、Source、Relation、Version 1、Timeline。
- `updateMemory`：
  - 必须提供 `changeReason`、`changeSource`、`createdBy`。
  - 生命周期转换受控；不合法转换拒绝。
  - 写新版本快照，旧版本保留。
  - 来源/关系在事务内一致写入；失败回滚。
- `archiveMemory` / `restoreMemory`：
  - 只改生命周期与时间，不删除行。
- `addSource` / `addRelation`：
  - 幂等；跨 Idea 实体拒绝。
- `createConflict` / `resolveConflict`：
  - 两条 Memory 必须同 Idea，互不删除。
  - 冲突重复创建幂等。
  - 关闭冲突需 resolution。
- `recordSelection`：
  - Session 必须属于同 Idea。
  - Memory 必须属于同 Idea。
  - 重复 Selection 幂等，不重复增加 `use_count`。
- `counts`：
  - 返回 total、lifecycle 分布、type 分布。

## 3. 迁移验证

- 全新数据库：v1 → v2 → v3 → v4。
- v3 → v4 升级：保留现有行。
- 重复打开：不重复执行 migration。
- 迁移失败：事务回滚，`user_version` 保持 3，已应用迁移记录保持 1–3。
- v4 内存表存在且可读写。

## 4. 实际执行的测试

```sh
corepack pnpm exec vitest run \
  packages/research/research-core/tests \
  packages/research/research-tools/tests \
  packages/client/ui-research-workspace/tests
```

覆盖：

- Memory 创建、读取、版本 1。
- Epistemic / lifecycle 分离。
- 更新版本、旧快照保留、change reason/source。
- Fact/Finding provenance 要求。
- Preference Session 来源要求。
- 精确去重与来源追加。
- 生命周期转换、归档、恢复。
- 关系端点校验、跨 Idea 拒绝。
- 冲突保留双方、幂等、解决。
- Selection 幂等与 useCount。
- Idea 隔离（Memory、版本、冲突、Selection）。
- 更新失败回滚。
- 全新库、v3→v4、重复打开、迁移失败回滚。

结果：**11 个测试文件，66 个测试全部通过**；其中新增 Memory 测试 12 个。

## 5. 质量门禁

```sh
corepack pnpm run typecheck        # 5 gates passed
corepack pnpm run build:lib:host
corepack pnpm run build:lib:client
corepack pnpm run build:check      # 2 gates passed
corepack pnpm run lint             # passed, one pre-existing warning
corepack pnpm run hygiene          # 23 gates passed
corepack pnpm run verify-md-links
corepack pnpm run verify-package-readme-model-experience
corepack pnpm run verify-package-readme-limitations
corepack pnpm run verify-tool-catalog
corepack pnpm run verify-translation-pairing packages/research/research-core/README.md
```

## 6. 已知限制

- 未实现 Summary Engine、Extractor、Retrieval、Context Builder。
- 未实现 FTS5 搜索（Phase 5.6）。
- 未实现 Memory Review/Promotion Remote 与 UI（Phase 5.5/5.7）。
- 未实现 Memory 工具（Phase 5.3/5.8）。
- 当前去重是精确内容哈希；近似重复与冲突检测规则在 Phase 5.3 实现。
- `research/changed` 尚未新增 Memory 变更 kind；Phase 5.7/5.8 接入 Workspace 时补充。

## 7. 下一阶段准入

Phase 5.1 完成。经确认后进入 Phase 5.2 Session Summary Engine；本阶段不提前实现。
