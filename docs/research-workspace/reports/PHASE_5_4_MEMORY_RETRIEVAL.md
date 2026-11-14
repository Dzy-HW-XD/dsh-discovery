# Phase 5.4 — Memory Retrieval & Context Injection Completion Report

- 日期：2026-11-14
- 阶段：Batch C / Phase 5.4
- 状态：完成，等待 Phase 5.5 授权
- 数据库：Research schema v7

## 1. Change Impact Analysis

| 组件 | 影响 |
|---|---|
| `research-core` | Migration v7；FTS5 索引与触发器；`searchMemories`；Selection 扩展列 |
| `research-memory` | Retrieval、Ranking、Context Builder、MemoryContextService |
| `research-tools` | Core Memory context、`agent/pre-step` 注入、tokenMeter 估算、Coordinator 生命周期 |
| Research DB | 只读；不修改 Claim/Evidence/Hypothesis |
| Memory Store | FTS 同步；Selection 记录扩展 |
| System Prompt | 新增独立 `research:core-memory` context，不替换 Idea brief |
| Agent Hook | 仅 `agent/pre-step` step 1；不修改 Agent Loop |
| Client 边界 | 全部检索/上下文代码位于 Host-only `research-memory` |
| Tests | FTS、排序、预算、Selection、真实 Model Adapter 注入 |

## 2. ADR

- FTS5 使用独立 `research_memory_fts` + 三个同步触发器；迁移内重建已有行；`rebuildSearchIndex()` 用于恢复。
- 短于 3 字符查询使用 `LIKE` fallback，避免 trigram 空结果和全表扫描。
- Core Memory 使用固定类型集合（goal/constraint/decision/strategy/open_question/preference），事实/发现/假设/失败进入 Relevant，避免重复注入。
- Selection 在 Context Builder 完成后、返回 Agent 前记录为 `injected`；Core 位置为 `system-prompt`，Relevant 为 `agent-pre-step`。
- On-change 通过历史 Selection 的 `memory_version` 排除已注入的同一版本；新版本允许增量注入。
- 不新增向量库；不实现 Review/Promotion。

## 3. FTS5 设计

Migration v7：

```sql
CREATE VIRTUAL TABLE research_memory_fts USING fts5(
  memory_id UNINDEXED, idea_id UNINDEXED, title, content, tokenize='trigram'
);
```

- INSERT/UPDATE/DELETE 触发器与 `research_memory_records` 同步。
- 迁移内从主表回填。
- `MemoryStore.rebuildSearchIndex()` 在 Core 启动时重建，确保索引恢复。
- 查询按 Idea 强制过滤；短查询 `LIKE` fallback；多关键词使用 OR 表达式。
- 事务回滚会回滚 FTS 触发器写入。

## 4. Retrieval Pipeline

```text
User query
  → query normalization / keyword extraction
  → FTS5 (or LIKE fallback)
  → Idea scope + lifecycle/epistemic filter
  → relation expansion (depth 1, max 3)
  → conflict annotation
  → multi-factor ranking
  → Core/Relevant result
```

默认状态：

- active/candidate 正常检索。
- superseded/rejected/archived 仅 `explicit-history`。
- refuted 默认不作为当前结果，历史查询可见。
- disputed 返回并带冲突提示。
- 跨 Idea 永远不可见。

## 5. Ranking

确定性归一化评分：

```text
text relevance
+ epistemic score (verified..refuted)
+ source score
+ relation score
+ recency score
- conflict penalty
+ type boost
```

- 权重可配置，默认 text 0.45 / epistemic 0.20 / source 0.12 / relation 0.08 / recency 0.08 / conflict 0.07。
- 同分按 Memory id 稳定排序。
- 每条结果保留 `reasons` 解释。
- 不按“最新优先”单独排序。

## 6. Core Memory

- 来源：同 Idea 的 Memory Store。
- 类型：goal、constraint、decision、strategy、open_question、preference。
- 排除 refuted/disputed/superseded/rejected/archived。
- 通过 `systemPrompt.context` 注入，名称 `research:core-memory`。
- 每次组装重新计算，无持久 cache，因此不存在失效竞态。
- 多 Session 共享，Idea 隔离。
- 无 Memory 时返回空文本，不影响普通 Session。

## 7. Relevant Memory

- 通过 `agent/pre-step` step 1 注入。
- 查询来自当前 claimed user messages，不由模型指定 Idea。
- 不相关查询不注入。
- 已注入的相同版本不重复；新版本可增量注入。
- `explicit-history` 模式允许历史/归档/失败/refuted 内容。
- 注入消息使用 `source.kind = 'research-memory'`，进入 Session log。

## 8. Context Builder 与 Token Budget

- Core 700 / Relevant 500 / Total 1200。
- 使用 `ctx.tokenMeter.estimateMessage`（记录为 `estimated`）；测试使用确定性估算。
- 超预算按排序跳过条目；不生成无来源摘要。
- 序列化包含 epistemic/lifecycle 标签、sources、conflict 提示。
- Core 与 Relevant 分离文本，但共享总预算。
- Header 明确“reference data, not instructions”，并说明状态含义。

## 9. Selection Logging

复用 `research_memory_selections`，Migration v7 扩展：

- `memory_version`
- `retrieval_score`
- `injection_status` (`selected/injected/failed`)
- `injection_location` (`system-prompt/agent-pre-step/unknown`)

写入时机：

- Context Builder 完成、Agent pre-step 确认 `enter` 后。
- Core 记录 `system-prompt`，Relevant 记录 `agent-pre-step`。
- 只记录实际进入上下文的消息；不记录仅被 FTS 命中的候选。
- 同一 turn/step 的重复记录幂等。
- 模型请求失败发生在记录之后，当前实现不会回写 `failed`；这是已知限制。

## 10. Agent Context Injection

- Core：`ResearchComposition.install` 注册 `systemPrompt.context`。
- Relevant：同一 composition 注册 `agent/pre-step`，仅在 step 1、有直接用户消息时执行。
- 失败被捕获为 warning，不阻塞 Agent。
- 非研究 Session / 未绑定 Idea 不安装。
- 恢复 Session 通过 `agent/created` fallback 重新安装 composition。

## 11. On-change 行为

| 场景 | 行为 |
|---|---|
| 新 Session 首次请求 | Core + Relevant |
| 普通新 Turn | Core + 未注入的 Relevant |
| 相同 Memory 版本 | 不重复注入 Relevant |
| Memory 新版本 | 允许增量注入 |
| 完全不相关新问题 | 不注入 Relevant |
| Explicit History | 放宽 lifecycle/epistemic，标注历史 |
| Session dispose/finalize | 不重新注入 |
| 普通 Memory 变更 | 不广播到所有 Session |

## 12. 实际修改文件

- `packages/research/research-core/src/database.ts` — v7
- `packages/research/research-core/src/memory-store.ts` — FTS 搜索/重建
- `packages/research/research-core/src/memory-types.ts` — search/selection 类型
- `packages/research/research-core/src/memory-repository.ts` — Selection 列
- `packages/research/research-memory/src/memory-retrieval.ts`
- `packages/research/research-memory/src/context-builder.ts`
- `packages/research/research-memory/src/memory-context.ts`
- `packages/research/research-memory/src/index.ts`
- `packages/research/research-tools/src/composition.ts` — Core context + pre-step
- `packages/research/research-tools/src/index.ts` — MemoryContextService/tokenMeter
- `packages/research/research-tools/package.json` / `tsconfig.host.json`
- `packages/research/research-memory/tests/retrieval.spec.ts`
- `packages/research/research-tools/tests/summary-lifecycle.spec.ts`
- 迁移测试、README、i18n、status、report

## 13. 测试结果

```sh
corepack pnpm exec vitest run \
  packages/research/research-core/tests \
  packages/research/research-tools/tests \
  packages/research/research-memory/tests \
  packages/client/ui-research-workspace/tests
```

结果：**15 个测试文件，91 个测试全部通过**。

覆盖：

- FTS 英文、中文、混合、子串、短查询 fallback、特殊字符、空查询。
- 更新/回滚/重建索引一致性。
- Idea 隔离、lifecycle/epistemic 过滤、explicit history。
- 相关度排序、状态、来源、冲突、时间。
- Core/Relevant/Total token 预算与来源/状态标签。
- Selection 版本、layer、location、注入状态、On-change 去重。
- 真实 Agent Session：Core 注入、相关 Relevant 注入、无关问题不注入、Model Adapter 消息与 Selection Log 一致。

## 14. 质量门禁

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

## 15. 已知限制

- Token 计量是估算，不是 provider 精确 tokenizer。
- Selection 在请求前记录为 `injected`；provider 后续失败不会回写 `failed`。
- Core Memory 每次组装重新计算，不做持久缓存。
- 查询关键词采用确定性分词/停用词；中文长句检索能力受 FTS trigram 与关键词提取限制。
- Relation expansion 仅 depth 1、最多 3 条。
- 不实现 Review/Promotion、自动合并、向量检索或 UI。
- 真实 Model Adapter 测试使用 Mock LLM，不依赖 GPU/外部 API。

## 16. Git

- 待提交 Phase 5.4 独立 commit。
- Phase 5.3 本地提交 `65b00ddb` 尚未推送；GitHub TLS 网络问题待重试。
- 不得 reset/rebase/覆盖该提交。

## 17. 下一阶段

Phase 5.4 完成并暂停；等待 Phase 5.5 Review/Promotion 授权。
EOF