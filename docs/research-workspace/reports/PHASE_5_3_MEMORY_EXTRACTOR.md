# Phase 5.3 — Memory Extractor Completion Report

- 日期：2026-11-14
- 阶段：Batch C / Phase 5.3
- 状态：完成，等待 Phase 5.4 授权
- 数据库：Research schema v6

## 1. Change Impact Analysis

| 组件 | 影响 |
|---|---|
| `research-core` | Migration v6 扩展 memory source；SummaryStore 原子入队 Extraction job；Outbox topic 过滤复用 |
| `research-memory` | 新增 Extractor、ExtractorCoordinator；SummaryCoordinator 不变 |
| `research-tools` | 构造并启动 ExtractorCoordinator；`summarizeSession` flush extraction |
| Research DB | 不修改 Claim/Evidence/Hypothesis 权威实体；Memory 只派生 |
| Summary | 只读取，不反向修改 |
| Memory Store | 复用 create/update/source/conflict API；新增 source provenance 列 |
| Outbox | 新 topic `research/session-memory-extraction`，与 Summary/Event topic 隔离 |
| Timeline | Memory Store 继续写 Memory timeline；Extractor 不写新权威实体 |
| Session lifecycle | Summary 完成即产生 Extraction job；无 Session 直接依赖 |
| Client boundary | Extractor/Coordinator 仅在 `research-memory` Host-only 包 |
| Tests | 新增真实 SQLite、真实 Summary/Memory Store、Outbox、完整链路 |

关键决策：

1. **Summary 如何触发 Extractor？** SummaryStore 在同一事务插入 Extraction Outbox 行。
2. **是否复用 Summary Outbox？** 复用机制，不复用 topic；独立 topic 防止 Summary worker 与 Extractor worker 互相消费。
3. **是否需要独立 topic？** 是，`research/session-memory-extraction`。
4. **防止同一 Summary 重复提取？** Outbox 幂等键 + Memory source 的 `summary_id/summary_version` 检查。
5. **防止历史 Summary 重复生成 Memory？** 同一 Summary 版本已提取则跳过；更高 Summary 版本才允许更新。
6. **多 Session 补充同一 Claim？** Claim 事实候选可由多个 Summary/Evidence source 追加；新 Summary 版本可更新同一 Candidate 并保留旧版本。
7. **已存在时更新还是新建？** 精确 hash 追加来源；高相似度且同向更新版本；中等相似度新建并标记 possible duplicate；相反 epistemic 新建并标记 contradiction。
8. **来源与历史？** 每个 Memory source 记录 summary id/version、entity id/version、extraction job id、role；Memory 更新写不可变版本。
9. **避免把未验证假设写成已验证？** 假设只生成 Hypothesis Candidate；Fact 只有 Claim + Evidence 支持才为 supported；Extractor 不自动 active/verified。
10. **Client 边界？** `research-memory` 是 Host-only；不进入 `api/remotes` Client 图。

### ADR

- Procedure 不新增 memory_type：使用 `strategy` + `structured.kind = "procedure"`，来源为祈使句 Decision。
- Preference 不自动推断：没有明确用户表达来源时不生成；Phase 5.1 已有 preference source 约束。
- Migration v6 只增列，不重建 Memory 表。
- Summary + Extraction job 在同一事务提交；Extractor 在事务外读取 Summary 后写 Memory。

## 2. Extraction Pipeline

```text
SummaryStore.insert
  → transaction: summary + extraction outbox
  → ExtractorCoordinator
      → claim extraction topic
      → load Summary
      → read canonical Research DB entities
      → CandidateDraft[]
      → exact dedup / near duplicate / conflict
      → MemoryStore create/update/conflict
      → outbox complete
```

Extractor 支持输入：

- Summary 结构化字段与 sourceReferences。
- Sources、Claims、Evidence、Hypotheses、Questions、Gaps、Decisions、Discoveries、Artifacts。
- 同 Idea 的历史 Memory（active/candidate/superseded/archived）。

## 3. Candidate 规则

- Claim + supporting Evidence -> `fact`，`epistemic_status = supported`。
- Claim 无 Evidence -> `fact`，`unverified`，不写成 verified。
- Hypothesis -> `hypothesis`，supported/refuted/disputed/unverified 由 Research DB 状态决定。
- Decision -> `decision`；祈使句 Decision 额外生成 `strategy` Procedure。
- Rejected Hypothesis / refuting Evidence -> `failure`，保留实体，不删除。
- Question / Gap -> `open_question`。
- Discovery -> `finding`。
- 空 Summary -> 0 candidate。
- 所有 Extractor candidate：`lifecycle_status = candidate`。
- 不生成 Preference；Preference 需要显式用户来源。

## 4. Provenance

Migration v6 为 `research_memory_sources` 增加：

- `summary_id`
- `summary_version`
- `extraction_job_id`
- `entity_version`
- `source_role` (`direct/supporting/contradicting/inferred`)

每个 Memory source 仍保留 session、entity、source、location、quote。Memory version 快照保留当时的 source/relation。

## 5. Deduplication 与 Conflict

- Exact：`(idea_id, memory_type, content_hash)` 复用并追加来源。
- Near：token Jaccard，默认 update 0.85 / duplicate 0.65 / conflict 0.5，可配置。
- `>= updateThreshold` 且 epistemic 同向：更新已有 Candidate，写新版本。
- `duplicateThreshold..updateThreshold`：新建并标记 `possible_duplicate`。
- epistemic 相反且 `>= conflictThreshold`：新建并标记 `contradiction`，不合并、不删除。
- 同一 Summary 版本已提取则跳过；更高 Summary 版本可更新。
- 不自动合并、不自动批准、不自动设置 active。

## 6. Job、幂等与恢复

- Topic：`research/session-memory-extraction`。
- 幂等键：`session-memory-extraction:<summaryId>:<version>`。
- Summary + Job 同一事务；崩溃不会得到“有 Summary 无 Job”。
- Worker 只 claim extraction topic；失败指数退避，10 次 dead。
- `start()` 恢复该 topic 的 processing 行，并扫描已有 Summary 补齐缺失 Job。
- 部分提取后崩溃：重试时已带同一 Summary source 的候选跳过，未处理候选继续。
- 多 Idea 隔离由 Memory Store 的 idea_id 校验保证。

## 7. 实际修改文件

- `packages/research/research-core/src/database.ts` — v6 migration。
- `packages/research/research-core/src/summary-store.ts` — Summary 原子入队 Extraction。
- `packages/research/research-core/src/summary-types.ts` — extraction topic/key。
- `packages/research/research-core/src/memory-types.ts` — source provenance 字段。
- `packages/research/research-core/src/memory-repository.ts` — source 列映射/写入。
- `packages/research/research-core/src/memory-store.ts` — summary source 校验与 source key。
- `packages/research/research-memory/src/memory-extractor.ts` — Extractor。
- `packages/research/research-memory/src/extractor-coordinator.ts` — worker/recovery。
- `packages/research/research-memory/src/index.ts` — exports。
- `packages/research/research-tools/src/index.ts` — coordinator 生命周期与 summarize flush。
- `packages/research/research-memory/tests/extractor.spec.ts` — 8 个提取测试。
- `packages/research/research-tools/tests/summary-lifecycle.spec.ts` — 全链路 memory 断言。
- 迁移测试更新到 v6。
- README / i18n / status / report。

## 8. 测试结果

```sh
corepack pnpm exec vitest run \
  packages/research/research-core/tests \
  packages/research/research-tools/tests \
  packages/research/research-memory/tests \
  packages/client/ui-research-workspace/tests
```

结果：**14 个测试文件，84 个测试全部通过**。

覆盖：

- Fact/Finding/Hypothesis/Decision/Procedure/Failure/Open Question 提取。
- Preference 不自动推断；Memory Store 既有来源约束保持。
- Evidence → Fact supported；无 Evidence → unverified。
- Rejected Hypothesis 保留并生成 failure。
- Candidate 生命周期始终 candidate。
- Summary/Claim/Evidence/Entity version/Job provenance。
- Exact dedup、版本更新、possible duplicate、contradiction conflict。
- 多 Session Claim 引用、多 Idea 隔离。
- Extraction Outbox 幂等、processing 恢复、重复执行。
- 真实链路：Agent Session → Summary → Summary Store → Extraction Outbox → Extractor → Memory Store。

## 9. 质量门禁

```sh
corepack pnpm run typecheck        # 5 gates
corepack pnpm run build:lib:host
corepack pnpm run build:lib:client
corepack pnpm run build:check      # 2 gates
corepack pnpm run lint
corepack pnpm run hygiene          # 23 gates
corepack pnpm run constraints
corepack pnpm run verify-md-links
corepack pnpm run verify-client-ui-i18n
corepack pnpm run verify-package-readme-model-experience
corepack pnpm run verify-package-readme-limitations
corepack pnpm run verify-tool-catalog
corepack pnpm run verify-translation-pairing
```

## 10. 已知限制

- 近似重复/冲突使用确定性 Jaccard 与 epistemic 方向；不做语义 embedding。
- Procedure 通过祈使句 Decision 启发式识别，不是独立的 Procedure 实体。
- Preference 需要显式用户来源，Extractor 不自动生成。
- 其他 Session 更新 Hypothesis 状态仍缺少 update-session 列，跨 Session 状态归因有限。
- 未实现 Retrieval、Context Builder、FTS、Review UI、Memory 工具。
- 未自动批准或合并 Memory。

## 11. 下一阶段

Phase 5.3 完成并暂停；等待 Phase 5.4 Retrieval 授权。
