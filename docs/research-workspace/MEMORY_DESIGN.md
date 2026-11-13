# DSH Research Workspace — Memory Design

- 状态：Phase 0 设计稿
- 修订：2026-11-13 Phase 0 Review — 增加 Hypothesis/Claim/Evidence/Summary 的 provenance 与版本设计
- 目标：让 Agent 在多个 Session 之间保持研究连续性，而不是把全部聊天历史塞进上下文
- 核心原则：Idea owns research；Session owns execution；Memory owns continuity
- 依赖：DSH Session Event Log / Session Query / System Prompt / LLM seam / Jobs

### 标记

- **Proposed**：设计建议，Phase 5+ 实现。
- **Verified**：已由 DSH 源码/测试验证的运行时行为。
- **Deferred**：明确留给后续 Phase。
- **Unverified**：尚未验证，不能作为稳定依赖。

---

## 1. 为什么不能用“聊天摘要”做 Memory

普通聊天摘要存在四个问题：

1. **不可追溯**：摘要里的结论找不到原始论文页码或 Session event。
2. **不可审查**：模型生成的摘要容易把推测写成事实。
3. **不可复用**：摘要按会话切分，无法按 Claim / Evidence / Concept 跨 Idea 复用。
4. **不可演化**：新证据出现时，无法只更新某条知识及其反证关系。

因此 Research Workspace 的 Memory 是**结构化知识的检索与生命周期层**，摘要只是其中一种低优先级记录。

---

## 2. 四层 Memory

```text
L1 Session Memory
  ├─ DSH Session Event Log（原始消息、tool calls/results、turn/step）
  ├─ Session Summary（导航层）
  └─ Session checkpoint（last_seen_seq / last_successfully_processed_seq）

L2 Idea Memory
  ├─ Idea Summary / Objectives / Research Question
  ├─ Active Hypotheses
  ├─ Open Questions
  ├─ Research Gaps
  ├─ Key Claims / Evidence
  ├─ Research Decisions
  ├─ Research Branches
  └─ Recent Session Summaries

L3 Knowledge Memory
  ├─ Sources / Concepts / Claims / Evidence
  ├─ Relations / Contradictions
  └─ Cross-Idea reusable knowledge

L4 Global Memory
  ├─ Confirmed general concepts
  ├─ Cross-Idea relations
  ├─ Validated counterexamples / rejected paths
  └─ Research lessons
```

### 2.1 L1 Session Memory

**存储：**

- 原始事件：DSH Session Persistence（JSONL/zstd），Research DB 不复制。
- Session Summary：`research_session_summaries`。
- Session 绑定与处理游标：`research_sessions`、`research_session_checkpoints`。

**职责：**

- 提供可重放的会话事实。
- 为 L2 提取提供输入。
- 支持“回到某次会话的某个事件”。

**不负责：**

- 不作为跨 Session 的稳定知识。
- 不直接把整段对话注入新 Session。

### 2.2 L2 Idea Memory

**存储：**

- 结构化实体表（`research_claims`、`research_hypotheses` 等）。
- `research_memory_records(layer='idea')` 作为统一检索投影。
- `research_context_snapshots` 记录每次注入的内容。

**职责：**

- 新 Session 恢复研究状态的主要来源。
- 维护 Idea 的当前摘要、开放问题、活跃假设、分支。
- 让 Agent 知道“这个研究项目现在进行到哪里”。

### 2.3 L3 Knowledge Memory

**存储：**

- `research_sources` / `research_source_locations`
- `research_concepts`
- `research_claims`
- `research_evidence`
- `research_relations`

**职责：**

- 跨 Session、跨 Idea 复用。
- 保留来源、引用位置、支持/反驳关系。
- 支持知识图谱查询和矛盾发现。

### 2.4 L4 Global Memory

**存储：**

- `research_memory_records(layer='global', idea_id=NULL, review_status='promoted')`
- 通过 `research_memory_sources` 保留来源。

**职责：**

- 存放经过审查、具有跨项目价值的知识。
- 存放已验证的反例、失败路径、研究经验。
- 不自动接收所有 Idea 内容。

**Promotion 默认策略：**

- 默认 **手动/独立 Critic 审查后才提升**。
- 不因为“模型觉得重要”就自动提升。
- 不因为“出现次数多”就自动提升。
- Promotion 需要至少一个明确理由：跨 Idea 复用、通用方法、已验证反例、稳定概念。

---

## 3. 数据模型映射

| Memory 层 | 主要表 | 说明 |
|---|---|---|
| L1 | `research_sessions`, `research_session_summaries`, `research_session_checkpoints` | 原始事件仍在 DSH |
| L2 | `research_ideas`, `research_questions`, `research_gaps`, `research_hypotheses`, `research_branches`, `research_decisions` + `research_memory_records(layer='idea')` | Idea 状态 |
| L3 | `research_sources`（共享）+ `research_idea_sources`（Idea 关联）+ `research_concepts`, `research_claims`, `research_evidence`, `research_relations` | 结构化知识；Source 可跨 Idea 复用 |
| L4 | `research_memory_records(layer='global')` + links/sources | 跨项目知识 |

`research_memory_records` 是统一的检索投影，不是唯一事实来源。一个 Claim 可以同时：

- 存在于 `research_claims`（事实实体）；
- 有一条 `research_memory_records(memory_type='claim', layer='knowledge')` 投影（便于检索）；
- 通过 `research_memory_links` 指回 Claim。

**同步规则：**

- 实体写入时，在同一个 transaction 更新 Memory 投影和 FTS。
- 不允许只有 Memory 投影、没有实体来源的“空中知识”。
- 如果投影与实体不一致，以实体为准，重建投影。

---

## 4. Memory Record 结构

逻辑字段（对应 `research_memory_records`）：

```ts
interface MemoryRecord {
  id: string
  ideaId?: string
  layer: 'session' | 'idea' | 'knowledge' | 'global'
  memoryType:
    | 'session_summary' | 'idea_summary' | 'claim' | 'evidence' | 'concept'
    | 'question' | 'gap' | 'hypothesis' | 'discovery' | 'decision'
    | 'relation' | 'rejected_path' | 'research_lesson' | 'other'
  title: string
  content: string
  structured: unknown

  epistemicStatus: 'observed' | 'reported' | 'inferred' | 'speculative' | 'disputed' | 'rejected'
  reviewStatus: 'candidate' | 'reviewed' | 'promoted' | 'rejected' | 'superseded' | 'disputed' | 'deprecated'
  confidence: number

  sourceSessionId?: string
  sourceEventSeqs: number[]
  sourceIds: string[]
  originToolCallId?: string

  contentHash: string
  version: number
  supersedesId?: string

  promotedAt?: number
  lastUsedAt?: number
  useCount: number
  createdAt: number
  updatedAt: number
}
```

**注意：**

- `epistemicStatus` 与 `reviewStatus` 是正交的。
  - 一条 `reported` Claim 可以是 `candidate`（尚未审查）。
  - 一条 `inferred` Hypothesis 可以是 `reviewed`（逻辑上通过，但仍是推断）。
- `confidence` 不是“科学概率”，只是系统内部排序参考。
- `contentHash` 是对规范化内容的 hash，用于去重和幂等。

---

## 5. Memory 生命周期

```text
                     ┌──────────────┐
                     │  Candidate   │
                     └──────┬───────┘
                            │ validation / dedup / review
                     ┌──────▼───────┐
                     │   Reviewed   │
                     └──────┬───────┘
                            │ cross-idea promotion review
                     ┌──────▼───────┐
                     │   Promoted   │
                     └──────────────┘

Candidate ── reject ──→ Rejected
Reviewed  ── conflict ─→ Disputed
Any       ── new version ─→ Superseded
Promoted  ── obsolete ─→ Deprecated
```

### 5.1 Candidate

进入条件：

- 来自 Session 提取、工具创建、Discovery Engine、人工输入。
- 必须有 `sourceSessionId` 或 `sourceIds` 或明确标记为 `speculative`。
- 不能直接进入 Context Assembly 的 P0/P1；最多作为低优先级候选。

禁止：

- 直接标记为 `reported` 而没有 locator。
- 直接把模型生成的“结论”写成 `observed`。
- 直接把 Hypothesis 写成 Claim。

### 5.2 Reviewed

进入条件（全部满足）：

1. 实体类型正确（Claim/Evidence/Hypothesis/... 没有混淆）。
2. 来源字段完整；`reported` 有 Source + locator。
3. 与现有实体不重复，或已合并。
4. 没有被更强的反证直接否定。
5. 属于当前 Idea（或明确是跨 Idea 引用）。
6. 内容不是纯模型重复（有独立来源或推理链）。
7. 版本/审查记录已写入。

进入后：

- 可以进入 L2 Idea Memory。
- 可以作为 Context Assembly 的 P3-P7 候选。
- 仍不能自动进入 Global Memory。

### 5.3 Promoted

进入条件：

1. 已经 `reviewed`。
2. 具有跨 Idea 复用价值，或属于通用概念/方法/反例。
3. 通过独立 Critic 或人工 Review。
4. Promotion 理由写入 `review_history`。
5. 来源仍可追溯。

Promotion 不是“升级为事实”；`epistemicStatus` 不变。

### 5.4 其他状态

- **Rejected**：审查拒绝。保留 `review_history`、反证、拒绝理由。可被后续新证据重新打开为新 Candidate。
- **Superseded**：被新版本替代。旧版本保留，`supersedesId` 指向新记录（或新记录指向旧记录，二者选一，建议新记录 `supersedesId=旧 id`）。
- **Disputed**：存在冲突证据。Context Assembly 必须同时展示支持与反对，不能只取一方。
- **Deprecated**：曾经有效，但当前不再推荐。保留历史，不删除。

---

## 6. 提取（Memory Extraction）

### 6.1 触发

| 触发 | 时机 | 处理范围 |
|---|---|---|
| 工具显式写入 | Agent 调用 research 工具 | 单实体，最高质量 |
| Turn checkpoint | `turn/end` 后 debounce | 自 `last_successfully_processed_seq + 1` 起的新事件；`last_seen_seq` 只记录读到哪 |
| Session Finalize | 用户/Agent 显式 | 全量未处理事件 + 总结 |
| Session Dispose | 进程内 Session 移除 | 尽力而为，失败入队 |
| 启动对账 | Host 启动 | 所有 `pending/finalizing` 和落后游标 |
| 手动重跑 | UI/命令 | 指定 Session 范围 |

### 6.2 输入

使用 DSH `ctx.sessionQuery`：

- `readSession(sessionId)`：完整 raw log（turn/tool/event 边界）。
- `readSurface(sessionId)`：模型实际看到的 current surface。
- `filterEvents(sessionId, filters)`：语义文本文档（message/tool call/result），适合提取。
- `readEvent({ sessionId, seq, before, after })`：单事件上下文。
- `traceEvent`：来源/替换关系。

不要自己解压 `.jsonl.zstd`。

### 6.3 提取阶段

```text
1. Flush session
2. Read events since checkpoint
3. Deterministic pass:
   - tool calls/results → explicit artifacts (claims, evidence, hypotheses...)
   - turn boundaries → session activity
   - sources cited in tool arguments/results
4. LLM pass (optional, budgeted):
   - summarize session
   - propose new candidate claims/questions/gaps
   - identify contradictions
5. Normalize:
   - canonical text, entity type, source refs, event seqs
6. Validate:
   - schema, provenance, duplicates, conflicts
7. Write transaction:
   - entities + memory projections + FTS + ingest keys + checkpoint
8. Emit research/changed
```

### 6.4 确定性优先

优先从工具调用结果中提取，因为：

- 工具有结构化参数/返回值。
- `exec.callId` 可作为幂等键。
- Agent 已经做了研究判断。

LLM 提取只用于：

- Session 总结。
- 未被工具显式记录的新问题/矛盾。
- 对长对话的候选实体发现。

LLM 提取的每条结果必须：

```json
{
  "entity_type": "claim",
  "statement": "...",
  "epistemic_status": "inferred",
  "confidence": 0.42,
  "source_session_id": "session-...",
  "source_event_seqs": [12, 18],
  "source_ids": ["src_..."],
  "derived_from": ["clm_..."],
  "reasoning": "...",
  "needs_review": true
}
```

缺少 `source_event_seqs` 或 `source_ids` 且不是 `speculative` 的结果直接拒绝。

### 6.5 禁止事项

- 禁止把 Assistant 的自然语言结论直接标为 `observed`。
- 禁止把“多个模型都这么说”当作来源。
- 禁止把摘要中的句子反向当作原始论文引用。
- 禁止在没有 locator 的情况下标 `reported`。
- 禁止把 `research_gap_create` 的“没检索到论文”直接写成“领域无人研究”；必须标记不确定性。

---

## 7. 验证（Memory Validation）

### 7.1 八项检查

对应设计文档，但落成可执行规则：

| # | 检查 | 失败处理 |
|---|---|---|
| 1 | 是否已存在相同/高度相似实体？ | 合并或标 superseded |
| 2 | 是否有明确来源？ | 标 `speculative` 或拒绝 |
| 3 | 是否有引用位置？ | `reported` 必须有 locator |
| 4 | 是否与已有 Claim 冲突？ | 建立 contradiction relation / 标 `disputed` |
| 5 | 是否只是模型推测？ | 标 `inferred`/`speculative` |
| 6 | 是否属于当前 Idea？ | 拒绝或转为跨 Idea reference |
| 7 | 是否值得长期记忆？ | 低价值内容留在 session summary，不建实体 |
| 8 | 是否需要人工确认？ | `candidate` + review queue |

### 7.2 来源质量

建议 `source_quality` 子分数（0..1）：

- 同行评审论文 / 官方文档：高。
- arXiv 预印本：中高，但标记 `preprint`。
- 技术博客 / 仓库 README：中。
- 二手总结 / 论坛：低。
- 模型生成：不作为来源。

`confidence` 可由以下因素组成，但必须可解释：

```text
confidence =
  0.35 * source_quality
+ 0.25 * evidence_directness
+ 0.20 * independent_corroboration
+ 0.10 * recency
+ 0.10 * consistency_with_existing
```

这只是一个内部排序分数，不是科学概率。Context Assembly 必须展示来源，而不是只展示分数。

### 7.3 冲突处理

当新 Claim/Evidence 与已有知识冲突：

1. 不覆盖旧记录。
2. 建立 `research_relations(relation_type='contradicts'/'refutes')`。
3. 把相关 Memory 标为 `disputed`（如果冲突未被解决）。
4. 在 Context Assembly 中成对呈现。
5. 生成 Research Question / Gap 候选。
6. 等待新的证据或人工裁决。

### 7.4 去重

三层：

1. **精确 hash**：规范化文本 + 实体类型 + 来源集合。
2. **近似文本**：FTS5 / trigram 相似；或 SQLite `LIKE` + 长度阈值。
3. **语义**（可选）：embedding 余弦相似度；只作为候选，最终由规则/审查决定。

去重结果：

- `duplicate`：合并来源，保留最早记录。
- `near_duplicate`：建立 `equivalent_to` / `extends` 关系。
- `distinct`：新建。

**不要**用 LLM 单独判定“相同”并自动合并；必须保留合并记录和来源。

---

## 8. Promotion（提升到 Global Memory）

### 8.1 评估维度

| 维度 | 问题 |
|---|---|
| 跨项目价值 | 是否只对当前 Idea 有意义？ |
| 复用频率 | 是否已在多个 Idea/Session 被引用？ |
| 稳定性 | 是否有独立来源/多次验证？ |
| 通用性 | 是否是概念/方法/反例，而非局部实验细节？ |
| 风险 | 如果未来被推翻，影响范围多大？ |
| 来源 | 是否仍可追溯？ |

### 8.2 流程

```text
Candidate (Idea layer)
  → Reviewer/Critic 提议 promotion
  → 检查跨 Idea 证据
  → 人工或独立 Critic 批准
  → 写入 Global Memory
  → 保留原 Idea 链接与来源
  → 记录 promotion history
```

默认：

- `autoPromote = false`。
- 批量 promotion 必须逐条有理由。
- 被拒绝的 promotion 也保留记录（`review_status='reviewed'` + review note）。

### 8.3 反例与失败路径

Global Memory 不只存“正确知识”，也存：

- 已验证的反例。
- 已被否定的研究路径。
- 失败的方法/配置。
- 研究经验（例如“某类论文的引用不可靠”）。

这些记录必须标明 `epistemic_status='rejected'` 或专门的 `rejected_path` 类型，避免被误用为正面证据。

---

## 9. Context Assembly Engine

### 9.1 目标

在每次新 Session 或模型请求前，根据任务动态加载相关记忆；**禁止全量注入**。

### 9.2 输入

- `idea_id`
- `session_id`（新会话可空）
- `branch_id`（可选）
- 当前任务/用户输入（可选）
- token budget
- 目的：`session_start` / `resume` / `tool_preview` / `cycle`

### 9.3 优先级

| 优先级 | 内容 | 默认预算占比 |
|---|---|---|
| P0 | Current Idea Objective + Research Question | 10% |
| P1 | Current Idea Summary | 15% |
| P2 | Recent Session Summaries（最近 2–3 个） | 15% |
| P3 | Active Hypotheses | 15% |
| P4 | Open Questions | 10% |
| P5 | Relevant Claims + Evidence | 20% |
| P6 | Relevant Sources | 5% |
| P7 | Contradictions + Rejected Paths | 5% |
| P8 | Related Idea Knowledge | 3% |
| P9 | Global Memory | 2% |

实际比例可配置；上表是初始值。P0–P4 是“研究状态”，P5–P9 是“证据与扩展”。

### 9.4 排序公式

对候选记忆：

```text
score =
  0.30 * priority_weight
+ 0.20 * relevance
+ 0.15 * confidence
+ 0.10 * recency
+ 0.10 * source_quality
+ 0.10 * status_weight
+ 0.05 * usage_weight
- 0.15 * redundancy_penalty
```

其中：

- `relevance`：FTS/关键词/可选 embedding；任务相关。
- `recency`：时间衰减只作为排序因素，**不得自动删除知识**。
- `status_weight`：reviewed/promoted 高，candidate 低，disputed 需要成对展示。
- `redundancy_penalty`：与已选内容重复则降权。

### 9.5 Token Budget

建议默认：

| 用途 | 预算 |
|---|---|
| 稳定研究协议（system section） | 300–600 tokens |
| Idea Brief（dynamic context） | 1,200–2,000 tokens |
| 工具返回的按需检索 | 1,000–2,000 tokens/次 |
| Session Summary 生成 | 1,500–3,000 tokens |
| Discovery/Critic | 独立预算，见 Orchestrator |

必须支持：

- 总预算配置。
- 单项上限。
- 截断策略：先截断低优先级/长文本，不截断来源 ID 与关键结论。
- Token 估算：保守字符/token 比（英文 ~4 chars/token，中文 ~1.5–2 chars/token），或可选 tokenizer；估算值写入 `research_context_snapshots`。

### 9.6 组装流程

```text
load Idea row
  → load summary/questions/hypotheses/gaps
  → query relevant claims/evidence via FTS
  → load contradictions/rejected paths
  → load related Idea promoted memory
  → load global memory
  → dedupe by content_hash/entity_id
  → rank
  → fit budget
  → render with source attribution
  → record snapshot (included/omitted/reasons)
```

### 9.7 渲染格式（示例）

```markdown
## Research Idea
**Title:** Bounded Activation and SDC Propagation in LLMs
**Objective:** ...
**Research question:** ...
**Status:** developing
**Summary:** ...

## Active Hypotheses
- [H1] ... (status: under_review, confidence: 0.6)
  Evidence: [E12] supports; [E19] refutes (disputed)

## Open Questions
- [Q3] ... (priority: 1)

## Recent Sessions
- Session 2026-11-10: ... (summary)

## Relevant Knowledge
- [C7] ... (reported; source: arXiv:2501.xxxxx §4.2; confidence 0.8)
- [E21] ... (refutes C7; source: ...)

## Contradictions / Rejected Paths
- ...

## Sources
- [S1] Author et al., 2025, arXiv:..., DOI:...
```

必须包含：

- 实体 ID（便于工具引用）。
- 来源 ID + locator。
- epistemic status。
- 冲突成对展示。

### 9.8 Explainability

每次组装写 `research_context_snapshots`：

```json
{
  "purpose": "session_start",
  "token_budget": 2000,
  "token_estimate": 1760,
  "included": [
    { "entity_type": "claim", "entity_id": "clm_...", "priority": "P5", "score": 0.82, "reason": "FTS match + reviewed" }
  ],
  "omitted": [
    { "entity_type": "claim", "entity_id": "clm_...", "reason": "budget_exceeded" }
  ]
}
```

UI 的 Memory Explorer / Context Preview 能回答：“为什么这条记忆被加载？”

### 9.9 注入 DSH 的实际方式

推荐：

1. **Stable protocol**：`agentCtx.systemPrompt.section({ name: 'research:protocol', order: ..., text: PROTOCOL })`。
2. **Idea Brief**：`agentCtx.systemPrompt.context({ name: 'research:idea-brief', order: ..., required: true, text: brief })`。
   - 在 `AgentSetup`（主路径）或 `agent/created`（fallback，Unverified）时生成一次并固定，避免每轮追加。
   - 恢复时重新生成。
3. **按需**：`research_context_preview` / `research_memory_search` 工具返回文本，模型自行决定是否引用。
4. **通知**：重大变化时 `agent.inject({ content, source: { kind: 'research' } })`；必须声明 `MessageSourceMap` 的 `research` kind。

**不要：**

- 用 `agent/pre-step` 每轮重写用户消息来注入 Memory。
- 把完整 DB 查询结果塞进 system prompt。
- 在 `session/event` listener 中同步做重 LLM 调用。

---

## 10. Provenance and Versioning（Phase 0 修订）

> **核心原则：Memory 不是覆盖式摘要，而是可审查、可追溯、可回滚的研究记录。**
> 本节是 **Proposed** 设计；Phase 5 实现 Memory，Phase 3 先建表；Phase 1 不实现。

### 10.1 统一溯源链

```text
Source (DOI/arXiv/URL)
  → SourceLocation (page/section/line/url fragment + quote)
  → Evidence (supports/refutes/context)
  → Claim (reported/inferred/speculative)
  → Hypothesis (version + review)
  → Discovery / Decision
  → MemoryRecord (projection)
  → ContextSnapshot (what was loaded)
```

每个箭头都必须可反查：

- Claim → Source / Evidence / Session event / tool call。
- Hypothesis → supporting/contradicting Evidence，以及生成它的 Session/Discovery。
- MemoryRecord → 原始实体 + Source + Review history。
- ContextSnapshot → 本次加载了哪些实体、为什么、丢弃了哪些。

### 10.2 Hypothesis Versioning（Proposed / Phase 3 schema, Phase 8 review）

**何时创建新版本：**

- 标题、描述、理论推理变化。
- assumptions / boundary conditions / alternative explanations / falsification conditions 变化。
- 支持/反对证据集合发生实质变化。
- Critic 要求 revise。
- 状态从 `supported` 回退到 `disputed`/`under_review`。

**记录：**

```text
research_hypotheses
  current_version = N
research_hypothesis_versions
  (hypothesis_id, version=N, snapshot_json, change_reason, created_by, created_at)
research_hypothesis_reviews
  (hypothesis_id, version=N, verdict, scores_json, reasoning,
   reviewer_type, model_provider, model_id, prompt_version, created_at)
```

规则：

- 旧版本不可修改。
- 新版本必须引用 `supersedes` 逻辑（通过版本号），但 `research_hypothesis_versions` 本身不可变。
- 版本快照包含当时的 evidence links 与 status；不能只存正文。
- 审查记录绑定到 `version`；对 v1 的 pass 不能自动适用于 v2。
- Critic 的 verdict 不写回 Generation 的 reasoning；两者独立存储。

### 10.3 Claim Provenance（Proposed / Phase 3 schema, Phase 5 write）

**每条 Claim 必须能回答：**

1. 这句话是观察、来源报告、推断，还是推测？
2. 来源是哪篇论文/文档的哪一页/哪一节？
3. 哪个 Session、哪个 event、哪个 tool call 产生？
4. 是否被后续 Claim 替代/反驳？
5. 修改历史是什么？

**字段：**

```text
research_claims
  statement, normalized_statement, epistemic_status, confidence,
  source_ids_json, origin_session_id, origin_event_seq, origin_tool_call_id,
  content_hash, supersedes_id, version
research_claim_versions
  (claim_id, version, snapshot_json, change_reason, created_by, created_at)
```

规则：

- `reported` 必须有至少一个 Source + locator；否则只能是 `inferred`/`speculative`。
- `origin_tool_call_id` 唯一，保证同一 tool call 重放不重复。
- Claim 修改必须写 `research_claim_versions`；不能原地覆盖历史表述。
- 被反驳的 Claim 标 `disputed`/`rejected`，并建立 `refutes`/`contradicts` 关系。
- `content_hash` 用于去重和幂等，不替代来源。

### 10.4 Evidence Source Traceability（Proposed / Phase 3）

**每条 Evidence 必须绑定：**

- `source_id`：论文/文档/仓库。
- `location_id`：页码、章节、段落、行号、URL fragment、字符范围。
- `quote`：原文摘录；不能只写“论文说了”。
- `evidence_type`：supports / refutes / context / contradicts。
- `strength`：内部排序参考，不是客观概率。
- `epistemic_status`：observed / reported / inferred / speculative / disputed / rejected。
- `origin_session_id` / `origin_event_seq` / `origin_tool_call_id`。
- `supersedes_id`：新证据替代旧证据时保留链。

**Source 撤回/不可用：**

- Source `status='retracted'/'unavailable'`。
- 相关 Evidence 不删除，标 `disputed` 或 `rejected`，并保留原因。
- Context Assembly 必须显示来源状态，不能把撤回来源当有效证据。

### 10.5 Summary Snapshot（Proposed / Phase 5）

Session Summary 是**快照**，不是覆盖式摘要：

```text
research_session_summaries
  (session_id, event_start_seq, event_end_seq, input_hash,
   version, status, supersedes_id, summary,
   open_questions_json, hypotheses_json, artifacts_json,
   model_provider, model_id, prompt_version, created_at)
```

规则：

- 同一事件范围重新生成 → 新 `version`/新行；旧行 `status='superseded'`。
- `input_hash` 绑定输入事件范围；输入变了，旧 summary 不能冒充新 summary。
- Summary 只用于导航；结构化 Claim/Evidence 仍以实体表为准。
- 生成失败不覆盖旧 summary；checkpoint 不推进。

### 10.6 Rejected / Superseded 历史保留（Proposed）

- **Rejected**：保留 `status='rejected'`、拒绝理由、审查者、时间、反证链接。
- **Superseded**：保留旧行，新行通过 `supersedes_id` 指向旧行；查询默认 current，历史可显式读取。
- **Disputed**：保留支持与反对双方，Context Assembly 必须成对展示。
- **Deprecated**：保留内容与来源，标为不推荐；不删除。
- **Global Memory demotion**：已 promoted 的知识被推翻时，保留 `promoted_at` 与 demotion 记录，不静默删除。

### 10.7 研究结论修改历史（Proposed）

“结论”可能落在 Claim / Hypothesis / Decision / Discovery 上。统一规则：

1. 每次改变结论的写入，都产生版本或新实体行。
2. 记录 `change_reason`：`new_evidence`、`critic_revision`、`user_edit`、`dedup_merge`、`contradiction`。
3. 记录 `created_by`：`user`、`agent:<session_id>`、`critic:<model>`、`import`。
4. 记录 `source_session_id` / `event_seq` / `tool_call_id`（若适用）。
5. 旧结论不删除；通过 `supersedes_id` 或版本链保留。
6. Context Assembly 默认只使用 current，但“为什么改变”可从版本历史重建。

### 10.8 Supersede 链

```text
hyp_1 v1 → hyp_1 v2 (current)
  ↑
supersedes_id 指向旧 memory/claim（如适用）
```

- 不删除旧版本。
- Context Assembly 默认只用 current version；需要历史时显式查询。
- 如果新版本被拒绝，保留旧版本为 current。
- 版本链不能成环；service 层检查。

---

## 11. LLM 无关性

### 11.1 存储层

- 所有知识是纯文本 + JSON + 关系，不含 provider 私有结构。
- 不存 LLM 的 hidden reasoning；只存可展示的 reasoning chain（明确标记为模型生成）。
- `assistant/message` 的 provider replay state 留在 DSH Session Log，不进入 Research DB。

### 11.2 提取层

- `ctx.llm.stream()` 调用；不使用某个 provider 的专用 API。
- 每次提取记录：
  - `model_provider`
  - `model_id`
  - `prompt_version`
  - `extractor_version`
  - `created_at`
- 失败时回退到确定性提取（工具结果、标题、来源），不阻塞 checkpoint。

### 11.3 检索层

- 默认 FTS5；embedding 可选。
- embedding 记录 `model`、`dimension`、`content_hash`。
- 更换模型时后台重建；旧索引保留直到新索引 ready。
- Context Assembly 不依赖具体 tokenizer；预算用保守估算。

### 11.4 评审层

- Generator 与 Critic 可以不同模型。
- Critic 的 verdict 与理由存 DB；不依赖模型会话状态。
- 更换模型不会改变既有 verdict；新评审产生新记录。

---

## 12. 失败恢复与一致性

### 12.0 两个 watermark

```text
last_seen_seq
  = 已读取/观察到的最高事件 seq
  = 可以超前于已提交处理
  = 只用于避免重复读取和诊断
  = 绝不能作为“已处理完”的依据

last_successfully_processed_seq
  = 已完整处理并提交的连续前缀
  = 只有 entities + projections + FTS + ingest keys + checkpoint 同一 transaction 提交成功后才推进
  = 恢复时从这里 + 1 开始重放
```

`last_seen_seq >= last_successfully_processed_seq`；如果处理失败，前者可以推进，后者保持不变。Session Summary 另有 `last_summarized_seq`，只在其覆盖的连续前缀已总结后推进。

### 12.1 提取失败

```text
session/event turn/end
  → debounce
  → job starts
  → flush session
  → read events since checkpoint
  → LLM extract (budget)
  → validate
  → BEGIN IMMEDIATE
       insert entities/projections/FTS/ingest keys
       update checkpoint.last_successfully_processed_seq
     COMMIT
  → emit research/changed
```

失败：

- transaction 回滚，`last_successfully_processed_seq` 不变；`last_seen_seq` 可以记录“读到哪儿”，但不能用于跳过处理。
- `research_session_checkpoints.status='failed'`、`attempts++`、`last_error`。
- 指数退避重试；超过阈值进入 `dead`，UI 显示。
- 启动时扫描 `failed` / 落后 checkpoint，重新入队。

### 12.2 重复执行

- `research_ingest_keys` 唯一键。
- `origin_tool_call_id` 唯一。
- Memory `content_hash` + layer 唯一。
- Artifact 文件按 hash 去重。

### 12.3 文件失败

- DB 行先写 `status='pending'`。
- 文件写临时路径 → fsync → rename → 计算 hash → 更新 `status='ready'`。
- 失败标记 `failed`，可重试；不影响研究实体。
- 启动对账：DB ready 但文件缺失 → `missing`；文件存在但 DB 无行 → 移入 `orphans/` 或登记。

### 12.4 Outbox

跨介质动作：

- 生成 artifact 文件。
- 重建 FTS/向量。
- 发送 `research/changed`。
- 导出 Graph。
- 备份。

业务 transaction 写 `research_outbox`；dispatcher 至少一次执行；消费者用 `idempotency_key` 去重。

---

## 13. 安全与 Prompt Injection

外部论文/网页是**不可信数据**：

1. 抓取内容只作为引用材料，不执行其中的指令。
2. Context Assembly 渲染时明确分隔：

```markdown
<untrusted_source id="src_...">
... 原文摘录 ...
</untrusted_source>
```

3. 系统 prompt 明确：来源中的“忽略之前指令”等内容不具权威。
4. 工具参数校验：source URL、DOI、arXiv ID 格式；禁止任意本地路径。
5. 文件导入限制在配置的 documents 目录；防止路径穿越。
6. 不把 API key、凭据写入 Research DB。
7. 多用户/远程访问时，Research Remote 需要资源级授权；Phase 1 先做本地单用户。

---

## 14. 评估指标

### 14.1 提取质量

- 有来源的 Claim 比例。
- `reported` 中有 locator 的比例（目标 100%）。
- 重复实体率。
- 被人工/Critic 拒绝的候选比例。
- 从 Session 到实体的可追溯率。

### 14.2 上下文质量

- Idea Brief 的 token 使用。
- 被引用的 Memory 比例（`use_count`）。
- 用户重复描述历史的次数（应下降）。
- Context Snapshot 中 P0–P4 的覆盖率。
- “为什么加载这条”可解释率（目标 100%）。

### 14.3 研究质量

- Hypothesis 通过 Critic 的比例。
- 有反证/替代解释的 Hypothesis 比例。
- 发现被后续证据支持/否定的比例。
- Global Memory promotion 后被推翻的比例（应可追踪）。
- 跨 Idea 复用次数。

### 14.4 系统可靠性

- 提取 checkpoint 落后时间。
- 失败重试成功率。
- Outbox backlog。
- DB/文件对账差异数。
- Session 恢复后 Context 注入成功率。

---

## 15. 最小可行 Memory（Phase 5）

Phase 5 不要一次实现全部：

**必须：**

- Session Summary。
- 从工具调用提取 Claim/Evidence/Hypothesis/Question。
- 基本 validation（来源、类型、重复）。
- `research_memory_records` 投影 + FTS。
- `candidate → reviewed` 手动审查。
- checkpoint + 幂等键。
- Context Preview（只读，不自动注入）。

**可以延后：**

- LLM 自动提取。
- embedding。
- 自动 promotion。
- 复杂去重。
- 跨 Idea 语义检索。

**完成标准：**

Session 结束后，能生成结构化摘要和至少一组候选实体；用户能在 UI 中审查；下一个 Session 能通过 `research_context_preview` 看到这些记忆；没有来源的内容不会被标成 `reported`。
