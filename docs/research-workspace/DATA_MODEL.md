# DSH Research Workspace — Data Model

- 状态：Phase 0 设计稿（未创建数据库；除引用 DSH 源码的约束外，均为 **Proposed**）
- 数据库：SQLite（`node:sqlite`，Node.js >= 24.9）
- 默认位置：`$DSH_HOME/research/database.sqlite`
- 设计目标：可追溯、可版本化、可恢复、可迁移、与 DSH Session Log 解耦
- 关联原则：Research DB 只存研究业务数据与 Session/Event 引用，不复制完整聊天记录
- 修订：2026-11-13 Phase 0 Review — Idea relation 方向性、Phase allocation、Claim/Summary 版本与两个 watermark

---

## 1. 设计原则

1. **Idea 是研究内容的归属单位。** 研究实体通常有 `idea_id`；Source 是跨 Idea 共享的外部材料，使用 `origin_idea_id` + `research_idea_sources` 关联；Global Memory 的 `idea_id` 为空。
2. **Session 是执行单位。** `origin_session_id` 指向 DSH Session；原始消息仍由 DSH Session Log 保存。
3. **事件位置是一等引用。** 需要模型可见证据时，保存 `session_id + event_seq`，而不是复制整段对话。
4. **知识状态与生命周期分离。**
   - `epistemic_status` 回答“这条知识有多可信”。
   - `review_status` 回答“这条记忆走到哪一步”。
   - `status` 是各实体自己的业务状态。
5. **已参与推理的历史不可硬删除。** 只允许 `rejected`、`superseded`、`disputed`、`deprecated`、`archived`。
6. **所有更新可版本化。** Hypothesis、Claim、Session Summary、Memory 至少保留不可变版本/快照；其他实体至少保留 `version` 与审查历史。
7. **所有时间使用 epoch milliseconds（INTEGER）。** 与 DSH SessionEvent 的 `time` 一致，便于排序和跨表比较；API 层可以再格式化为 ISO 字符串。
8. **所有 ID 为不透明字符串。** Research 实体建议前缀：`idea_`、`src_`、`clm_`、`evd_`、`hyp_`、`q_`、`gap_`、`dsc_`、`mem_`、`art_`；Session 主键直接使用 DSH 的 `session-...` id，不另造前缀。
9. **JSON 只用于不稳定/扩展字段。** 可查询、可约束的字段必须是独立列；JSON 列使用 `CHECK(json_valid(...))`。
10. **数据库是 Research 业务权威。** Session Log 是会话事实权威；两者通过幂等投影和对账保持一致。

---

### 1.1 Phase allocation（避免提前设计）

| 数据 | 引入 Phase | 说明 |
|---|---|---|
| `research_schema_migrations` | Phase 1 | 迁移账本 |
| `research_ideas` 最小列 | Phase 1 | 不含 workspace/last_session |
| `research_idea_relations` 最小列 | Phase 1 | 不含 source_session |
| `research_timeline_events` 最小列 | Phase 1 | 不含 branch_id/session_id |
| `research_ideas.workspace_*` / `last_session_id` | Phase 2 | Session 创建需要 |
| `research_sessions` / links / checkpoints | Phase 2 | Session binding |
| `research_outbox` | Phase 2 | 跨介质/异步副作用 |
| `research_sources` / concepts / claims / evidence / relations | Phase 3 | Knowledge |
| `research_questions` / gaps / hypotheses / discoveries / branches / decisions / artifacts | Phase 3 | Research artifacts |
| `research_claim_versions` | Phase 3（表）/ Phase 5（写入） | Claim 修改历史 |
| `research_hypothesis_reviews` | Phase 8 | Critic 审查记录 |
| `research_ingest_keys` | Phase 5 | 自动提取幂等 |
| `research_memory_records` / versions / links / sources | Phase 5 | Memory |
| `research_context_snapshots` | Phase 6 | Context explainability |
| `research_session_summaries` | Phase 5 | Summary snapshot |
| `research_jobs` | Phase 5（提取）/ Phase 9（cycle） | 研究任务状态 |
| `research_embeddings` | Deferred | 可选向量索引 |
| `research_fts` | Phase 5 | 记忆检索；Phase 1 可用 LIKE |

> Phase 1 的迁移不得创建上表中 Phase 2+ 的表；TypeScript 接口可以保留未来字段的可选类型，但不能产生空表或假数据。

## 2. 枚举

### 2.1 Idea 状态

```text
seed → exploring → developing → reviewing → mature → archived
```

允许回退（例如 `mature → developing`）。`archived` 只表示不再活跃，不删除关联数据。

### 2.2 Session 绑定状态

| 值 | 含义 |
|---|---|
| `pending` | 已预生成 session_id，正在创建 DSH Session |
| `active` | 绑定成功，Session 可运行 |
| `inbox` | 未归属 Idea 的临时 Session |
| `finalizing` | 正在做 Session 总结/提取 |
| `finalized` | 已完成最终提取 |
| `failed` | 创建或绑定失败 |
| `archived` | 不再出现在默认列表 |

### 2.3 Memory 生命周期

```text
candidate → reviewed → promoted
     ↘ rejected
     ↘ superseded
     ↘ disputed
     ↘ deprecated
```

- `candidate`：刚提取，未审查。
- `reviewed`：通过基本校验，可进入 Idea Memory。
- `promoted`：确认具有跨 Idea 价值，进入 Global Memory。
- `rejected`：审查拒绝，保留原因。
- `superseded`：被新版本替代，保留历史。
- `disputed`：存在冲突证据，暂不作为稳定知识。
- `deprecated`：曾经有效，但当前不再推荐使用。

### 2.4 Epistemic Status

| 值 | 含义 | 最低要求 |
|---|---|---|
| `observed` | 系统直接观察到的内容 | 必须能定位到 Session event 或工具结果 |
| `reported` | 来源明确报告的内容 | 必须有 Source + locator（页码/URL 片段/行号） |
| `inferred` | 根据现有证据推导 | 必须列出 derived_from / 推理链 |
| `speculative` | 证据不足的推测 | 必须标记不确定性 |
| `disputed` | 存在冲突证据/观点 | 必须至少有一个支持与一个反对引用 |
| `rejected` | 已被反证或逻辑审查否定 | 必须保留反证/审查记录 |

**禁止自动升级：** `inferred` 不能因为模型重复表述就变成 `reported`；`speculative` 不能因为被引用次数多就变成 `observed`。

### 2.5 Hypothesis 状态

`candidate`、`under_review`、`supported`、`disputed`、`rejected`、`superseded`。

### 2.6 ResearchQuestion 状态

`open`、`investigating`、`answered`、`deferred`、`rejected`。

### 2.7 ResearchGap 类型

`literature_gap`、`knowledge_gap`、`methodological_gap`、`contradiction_gap`、`cross_domain_gap`。

### 2.8 Knowledge Relation 类型

`supports`、`refutes`、`contradicts`、`extends`、`depends_on`、`equivalent_to`、`specializes`、`causes`、`correlates_with`、`derived_from`、`analogous_to`、`potentially_related_to`。

### 2.9 Branch 状态

`active`、`paused`、`merged`、`split`、`rejected`、`promoted_to_idea`。

### 2.10 Artifact 类型

`research_report`、`literature_review`、`technical_analysis`、`markdown`、`html`、`graph_export`、`diagram`、`dataset`、`other`。

### 2.11 Job 状态

`queued`、`running`、`paused`、`stopping`、`completed`、`failed`、`cancelled`。

---

## 3. ER 总览

```mermaid
erDiagram
  RESEARCH_IDEAS ||--o{ RESEARCH_SESSIONS : owns
  RESEARCH_IDEAS ||--o{ RESEARCH_BRANCHES : has
  RESEARCH_IDEAS ||--o{ RESEARCH_IDEA_SOURCES : links
  RESEARCH_IDEA_SOURCES }o--|| RESEARCH_SOURCES : cites
  RESEARCH_IDEAS ||--o{ RESEARCH_CONCEPTS : has
  RESEARCH_IDEAS ||--o{ RESEARCH_CLAIMS : has
  RESEARCH_IDEAS ||--o{ RESEARCH_QUESTIONS : has
  RESEARCH_IDEAS ||--o{ RESEARCH_GAPS : has
  RESEARCH_IDEAS ||--o{ RESEARCH_HYPOTHESES : has
  RESEARCH_IDEAS ||--o{ RESEARCH_DISCOVERIES : has
  RESEARCH_IDEAS ||--o{ RESEARCH_ARTIFACTS : has
  RESEARCH_IDEAS ||--o{ RESEARCH_TIMELINE_EVENTS : has
  RESEARCH_IDEAS ||--o{ RESEARCH_MEMORY_RECORDS : has

  RESEARCH_SESSIONS ||--o| RESEARCH_SESSION_SUMMARIES : summarizes
  RESEARCH_SESSIONS ||--o{ RESEARCH_MEMORY_RECORDS : originates

  RESEARCH_SOURCES ||--o{ RESEARCH_SOURCE_LOCATIONS : locates
  RESEARCH_SOURCES ||--o{ RESEARCH_EVIDENCE : provides
  RESEARCH_CLAIMS ||--o{ RESEARCH_EVIDENCE : supported_by
  RESEARCH_HYPOTHESES ||--o{ RESEARCH_HYPOTHESIS_VERSIONS : versions
  RESEARCH_HYPOTHESES ||--o{ RESEARCH_HYPOTHESIS_EVIDENCE : evaluated_by
  RESEARCH_EVIDENCE ||--o{ RESEARCH_HYPOTHESIS_EVIDENCE : links

  RESEARCH_MEMORY_RECORDS ||--o{ RESEARCH_MEMORY_VERSIONS : versions
  RESEARCH_MEMORY_RECORDS ||--o{ RESEARCH_MEMORY_LINKS : links
  RESEARCH_MEMORY_RECORDS ||--o{ RESEARCH_MEMORY_SOURCES : cites

  RESEARCH_IDEAS ||--o{ RESEARCH_IDEA_RELATIONS : from
  RESEARCH_IDEAS ||--o{ RESEARCH_IDEA_RELATIONS : to
```

---

## 4. 表定义

> 以下 DDL 是设计稿，不是已执行迁移。实现时应放进编号迁移文件，并用 `research_schema_migrations` 记录。所有 `TEXT` 时间列不存在；统一使用 `INTEGER` epoch ms。实际迁移按依赖顺序创建：`research_ideas` → `research_branches` → `research_sessions` → `research_idea_relations`（含 session 来源列）→ 其余表；Phase 1 只建其中最小的 ideas/relations/timeline。下方按领域分组展示，不严格等于执行顺序。

### 4.1 Idea

```sql
CREATE TABLE research_ideas (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  research_question TEXT NOT NULL DEFAULT '',
  objectives_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(objectives_json)),
  status            TEXT NOT NULL DEFAULT 'seed'
                    CHECK (status IN ('seed','exploring','developing','reviewing','mature','archived')),
  parent_idea_id    TEXT REFERENCES research_ideas(id) ON DELETE RESTRICT,
  current_summary   TEXT NOT NULL DEFAULT '',
  -- Phase 2 迁移增加：
  workspace_id      TEXT,
  workspace_path    TEXT,
  last_session_id   TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived_at       INTEGER,
  version           INTEGER NOT NULL DEFAULT 1,
  created_by        TEXT NOT NULL DEFAULT 'user'
);

CREATE INDEX idx_ideas_status_updated ON research_ideas(status, updated_at DESC);
CREATE INDEX idx_ideas_parent ON research_ideas(parent_idea_id);
```

`related_idea_ids` 不放在 JSON 列，使用关系表，避免无法反向查询。

```sql
CREATE TABLE research_idea_relations (
  id                    TEXT PRIMARY KEY,
  from_idea_id          TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  to_idea_id            TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  relation_type         TEXT NOT NULL
                        CHECK (relation_type IN ('related_to','derived_from','merged_from','references')),
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','superseded','rejected')),
  note                  TEXT NOT NULL DEFAULT '',
  group_id              TEXT,
  created_by            TEXT NOT NULL DEFAULT 'user',
  created_at            INTEGER NOT NULL,
  -- Phase 2 迁移增加（完整 schema 的最终形态；Phase 1 最小迁移不含这两列）：
  source_session_id     TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  source_event_seq      INTEGER,
  supersedes_relation_id TEXT REFERENCES research_idea_relations(id) ON DELETE RESTRICT,
  metadata_json         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  CHECK (from_idea_id <> to_idea_id),
  CHECK (relation_type <> 'related_to' OR from_idea_id < to_idea_id),
  UNIQUE (from_idea_id, to_idea_id, relation_type)
);

CREATE INDEX idx_idea_relations_to ON research_idea_relations(to_idea_id);
CREATE INDEX idx_idea_relations_group ON research_idea_relations(group_id) WHERE group_id IS NOT NULL;
```

#### 4.1.1 Idea 关系语义

| 语义 | 存储 | 方向 | 说明 |
|---|---|---|---|
| `parent_of` | `research_ideas.parent_idea_id` | 子 → 父（查询时反向得到 `parent_of`） | 单父；创建/更新时检查无环；不写关系表，避免双份真相 |
| `child_of` | 同上 | 父 → 子（查询 `WHERE parent_idea_id = ?`） | 是 `parent_idea_id` 的反向视图 |
| `related_to` | `research_idea_relations` | 对称 | 服务层强制按字典序存 `from < to`，查询时双向匹配；重复添加幂等 |
| `derived_from` | `research_idea_relations` | `from` = 派生出的 Idea，`to` = 来源 Idea | 可多来源；不等同于 parent；用于思想/知识谱系 |
| `merged_from` | `research_idea_relations` | `from` = 合并结果 Idea，`to` = 被合并来源 Idea | 一次合并可有多行，用 `group_id` 分组；来源 Idea 可归档但保留 |
| `references` | `research_idea_relations` | `from` = 引用方，`to` = 被引用方 | 跨 Idea 知识引用；不改变 primary 归属 |

关系记录的字段：

- `created_at` / `created_by`：谁在何时建立。
- `note`：人类可读的理由。
- `group_id`：合并/批量派生的分组。
- `status`：`active` / `superseded` / `rejected`；不硬删除。
- `supersedes_relation_id`：修正关系时保留旧边。
- `source_session_id` / `source_event_seq`：Phase 2 起记录关系产生的会话来源（需要 `research_sessions` 表）。
- `metadata_json`：可扩展的强类型外字段，例如合并策略、置信度、审查记录。

**演化追踪：**

- 每次关系添加/撤销/替代都写 `research_timeline_events`。
- Parent 变更必须写 timeline，并检查不会形成环。
- Merge 不删除来源 Idea；来源 Idea 的 `status` 可变为 `archived`，但 `merged_from` 关系保留。
- Derived 关系可以跨多代；查询谱系时使用 recursive CTE，并设置深度上限。

> Parent/Child 的树关系由 `research_ideas.parent_idea_id` 唯一表达；`research_idea_relations` 只表达 Related / Derived / Merged / References，避免两套父子真相。

### 4.2 Session 绑定

```sql
CREATE TABLE research_sessions (
  session_id        TEXT PRIMARY KEY,
  idea_id           TEXT REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id         TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  role              TEXT NOT NULL DEFAULT 'primary'
                    CHECK (role IN ('primary','inbox','child','reference')),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','active','inbox','finalizing','finalized','failed','archived')),
  binding_source    TEXT NOT NULL DEFAULT 'research'
                    CHECK (binding_source IN ('research','inbox','manual','schedule','tool')),
  workspace_id      TEXT,
  cwd               TEXT,
  agent_preset      TEXT,
  origin            TEXT NOT NULL DEFAULT 'ui'
                    CHECK (origin IN ('ui','tool','schedule','subagent','unknown')),
  last_summary_id   TEXT,
  created_at        INTEGER NOT NULL,
  bound_at          INTEGER,
  finalized_at      INTEGER,
  last_error        TEXT,
  version           INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_sessions_idea_status ON research_sessions(idea_id, status, created_at DESC);
CREATE INDEX idx_sessions_status ON research_sessions(status);
CREATE INDEX idx_sessions_pending ON research_sessions(status) WHERE status IN ('pending','finalizing');
```

- `idea_id IS NULL` 就是 Inbox（同时 `role='inbox'`, `status='inbox'`）。
- 一个 Session 只有一个 primary Idea；其他 Idea 用下面的 link 表。
- `branch_id` 可空；一个 Session 可以聚焦某个分支。

```sql
CREATE TABLE research_session_idea_links (
  session_id   TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  idea_id      TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  link_type    TEXT NOT NULL DEFAULT 'reference'
               CHECK (link_type IN ('reference','derived','child','knowledge_reuse')),
  note         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, idea_id, link_type)
);
```

### 4.3 Branch

```sql
CREATE TABLE research_branches (
  id                TEXT PRIMARY KEY,
  idea_id           TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  parent_branch_id  TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','paused','merged','split','rejected','promoted_to_idea')),
  merged_into_id    TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_branches_idea_status ON research_branches(idea_id, status, updated_at DESC);
```

### 4.4 Source

```sql
CREATE TABLE research_sources (
  id              TEXT PRIMARY KEY,
  -- 首次导入该来源的 Idea；来源本身可被多个 Idea 引用，不构成所有权。
  origin_idea_id  TEXT REFERENCES research_ideas(id) ON DELETE RESTRICT,
  source_type     TEXT NOT NULL
                  CHECK (source_type IN ('paper','preprint','web','documentation','repository','book','dataset','other')),
  title           TEXT NOT NULL,
  authors_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(authors_json)),
  year            INTEGER,
  venue           TEXT,
  doi             TEXT,
  arxiv_id        TEXT,
  url             TEXT,
  canonical_url   TEXT,
  abstract        TEXT,
  metadata_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  content_hash    TEXT,
  retrieved_at    INTEGER,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','archived','retracted','unavailable')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX ux_sources_doi ON research_sources(doi) WHERE doi IS NOT NULL;
CREATE UNIQUE INDEX ux_sources_arxiv ON research_sources(arxiv_id) WHERE arxiv_id IS NOT NULL;
CREATE INDEX idx_sources_origin ON research_sources(origin_idea_id, created_at DESC);

-- Source 与 Idea 的多对多关联；引用一支论文不复制论文实体。
CREATE TABLE research_idea_sources (
  idea_id      TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  source_id    TEXT NOT NULL REFERENCES research_sources(id) ON DELETE RESTRICT,
  relevance    TEXT NOT NULL DEFAULT 'cited'
               CHECK (relevance IN ('primary','cited','context','rejected')),
  note         TEXT NOT NULL DEFAULT '',
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (idea_id, source_id)
);

CREATE INDEX idx_idea_sources_source ON research_idea_sources(source_id);
```

```sql
CREATE TABLE research_source_locations (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES research_sources(id) ON DELETE RESTRICT,
  locator_type  TEXT NOT NULL
                CHECK (locator_type IN ('page','section','paragraph','line','url_fragment','char_range','figure','table')),
  locator       TEXT NOT NULL,
  page          INTEGER,
  char_start    INTEGER,
  char_end      INTEGER,
  quote         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_source_locations_source ON research_source_locations(source_id);
```

### 4.5 Concept / Claim / Evidence / Relation

```sql
CREATE TABLE research_concepts (
  id                 TEXT PRIMARY KEY,
  idea_id            TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  name               TEXT NOT NULL,
  definition         TEXT NOT NULL DEFAULT '',
  aliases_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  parent_concept_id  TEXT REFERENCES research_concepts(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','merged','deprecated')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX ux_concepts_idea_name ON research_concepts(idea_id, name);
```

```sql
CREATE TABLE research_claims (
  id                 TEXT PRIMARY KEY,
  idea_id            TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  statement          TEXT NOT NULL,
  normalized_statement TEXT NOT NULL DEFAULT '',
  epistemic_status   TEXT NOT NULL DEFAULT 'reported'
                     CHECK (epistemic_status IN ('observed','reported','inferred','speculative','disputed','rejected')),
  confidence         REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','disputed','rejected','superseded','archived')),
  source_ids_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_ids_json)),
  origin_session_id  TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq   INTEGER,
  origin_tool_call_id TEXT,
  content_hash       TEXT NOT NULL,
  supersedes_id      TEXT REFERENCES research_claims(id) ON DELETE RESTRICT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX ux_claims_tool_call ON research_claims(origin_tool_call_id)
  WHERE origin_tool_call_id IS NOT NULL;
CREATE INDEX idx_claims_idea_status ON research_claims(idea_id, status, updated_at DESC);
CREATE INDEX idx_claims_hash ON research_claims(content_hash);
```

```sql
CREATE TABLE research_claim_versions (
  id             TEXT PRIMARY KEY,
  claim_id       TEXT NOT NULL REFERENCES research_claims(id) ON DELETE RESTRICT,
  version        INTEGER NOT NULL,
  snapshot_json  TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  change_reason  TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (claim_id, version)
);

CREATE INDEX idx_claim_versions_claim ON research_claim_versions(claim_id, version DESC);
```

```sql
CREATE TABLE research_evidence (
  id                 TEXT PRIMARY KEY,
  idea_id            TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  claim_id           TEXT REFERENCES research_claims(id) ON DELETE RESTRICT,
  source_id          TEXT NOT NULL REFERENCES research_sources(id) ON DELETE RESTRICT,
  location_id        TEXT REFERENCES research_source_locations(id) ON DELETE RESTRICT,
  evidence_type      TEXT NOT NULL
                     CHECK (evidence_type IN ('supports','refutes','context','contradicts')),
  strength           REAL NOT NULL DEFAULT 0.5 CHECK (strength >= 0 AND strength <= 1),
  quote              TEXT NOT NULL DEFAULT '',
  notes              TEXT NOT NULL DEFAULT '',
  epistemic_status   TEXT NOT NULL DEFAULT 'reported'
                     CHECK (epistemic_status IN ('observed','reported','inferred','speculative','disputed','rejected')),
  origin_session_id  TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq   INTEGER,
  origin_tool_call_id TEXT,
  content_hash       TEXT NOT NULL,
  supersedes_id      TEXT REFERENCES research_evidence(id) ON DELETE RESTRICT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_evidence_claim ON research_evidence(claim_id, evidence_type);
CREATE INDEX idx_evidence_source ON research_evidence(source_id);
```

```sql
CREATE TABLE research_relations (
  id               TEXT PRIMARY KEY,
  idea_id          TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  from_entity_type TEXT NOT NULL,
  from_entity_id   TEXT NOT NULL,
  to_entity_type   TEXT NOT NULL,
  to_entity_id     TEXT NOT NULL,
  relation_type    TEXT NOT NULL
                   CHECK (relation_type IN (
                     'supports','refutes','contradicts','extends','depends_on','equivalent_to',
                     'specializes','causes','correlates_with','derived_from','analogous_to',
                     'potentially_related_to')),
  confidence       REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  epistemic_status TEXT NOT NULL DEFAULT 'inferred'
                   CHECK (epistemic_status IN ('observed','reported','inferred','speculative','disputed','rejected')),
  source_ids_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_ids_json)),
  origin_session_id TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq INTEGER,
  created_at       INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','disputed','rejected','superseded')),
  CHECK (from_entity_id <> to_entity_id),
  UNIQUE (idea_id, from_entity_type, from_entity_id, to_entity_type, to_entity_id, relation_type)
);

CREATE INDEX idx_relations_from ON research_relations(from_entity_type, from_entity_id);
CREATE INDEX idx_relations_to ON research_relations(to_entity_type, to_entity_id);
```

> `from_entity_type` / `to_entity_type` 使用受控字符串（`source`、`concept`、`claim`、`evidence`、`hypothesis`、`question`、`gap`、`discovery`、`memory`）。SQLite 无法跨表外键，因此由 service 层保证引用存在；每日对账任务检查孤儿关系。

### 4.6 Research Question / Gap

```sql
CREATE TABLE research_questions (
  id                   TEXT PRIMARY KEY,
  idea_id              TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id            TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  question             TEXT NOT NULL,
  motivation           TEXT NOT NULL DEFAULT '',
  origin               TEXT NOT NULL DEFAULT 'session'
                       CHECK (origin IN ('seed','session','gap','discovery','user','critic')),
  priority             INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  status               TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','investigating','answered','deferred','rejected')),
  related_claim_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related_claim_ids_json)),
  related_hypothesis_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related_hypothesis_ids_json)),
  answer_summary       TEXT NOT NULL DEFAULT '',
  origin_session_id    TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq     INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_questions_idea_status ON research_questions(idea_id, status, priority, updated_at DESC);
```

```sql
CREATE TABLE research_gaps (
  id                 TEXT PRIMARY KEY,
  idea_id            TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id          TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  gap_type           TEXT NOT NULL
                     CHECK (gap_type IN ('literature_gap','knowledge_gap','methodological_gap','contradiction_gap','cross_domain_gap')),
  gap_description    TEXT NOT NULL,
  related_work       TEXT NOT NULL DEFAULT '',
  missing_connection TEXT NOT NULL DEFAULT '',
  evidence           TEXT NOT NULL DEFAULT '',
  novelty_assessment TEXT NOT NULL DEFAULT '',
  uncertainty        REAL NOT NULL DEFAULT 0.5 CHECK (uncertainty >= 0 AND uncertainty <= 1),
  status             TEXT NOT NULL DEFAULT 'candidate'
                     CHECK (status IN ('candidate','reviewed','accepted','rejected','superseded')),
  origin_session_id  TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq   INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_gaps_idea_status ON research_gaps(idea_id, status, updated_at DESC);
```

### 4.7 Hypothesis

```sql
CREATE TABLE research_hypotheses (
  id                      TEXT PRIMARY KEY,
  idea_id                 TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id               TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL,
  theoretical_reasoning   TEXT NOT NULL DEFAULT '',
  assumptions_json        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(assumptions_json)),
  boundary_conditions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(boundary_conditions_json)),
  alternative_explanations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternative_explanations_json)),
  falsification_conditions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(falsification_conditions_json)),
  related_work_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related_work_json)),
  status                  TEXT NOT NULL DEFAULT 'candidate'
                          CHECK (status IN ('candidate','under_review','supported','disputed','rejected','superseded')),
  current_version         INTEGER NOT NULL DEFAULT 1,
  origin_session_id       TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq        INTEGER,
  origin_tool_call_id     TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE INDEX idx_hypotheses_idea_status ON research_hypotheses(idea_id, status, updated_at DESC);
```

```sql
CREATE TABLE research_hypothesis_versions (
  id             TEXT PRIMARY KEY,
  hypothesis_id  TEXT NOT NULL REFERENCES research_hypotheses(id) ON DELETE RESTRICT,
  version        INTEGER NOT NULL,
  snapshot_json  TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  change_reason  TEXT NOT NULL DEFAULT '',
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (hypothesis_id, version)
);
```

```sql
-- Phase 8 使用：独立 Critic 的审查记录；不覆盖 hypothesis 本体。
CREATE TABLE research_hypothesis_reviews (
  id             TEXT PRIMARY KEY,
  hypothesis_id  TEXT NOT NULL REFERENCES research_hypotheses(id) ON DELETE RESTRICT,
  version        INTEGER NOT NULL,
  verdict        TEXT NOT NULL
                 CHECK (verdict IN ('pass','revise','reject','insufficient_evidence')),
  scores_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scores_json)),
  reasoning      TEXT NOT NULL,
  reviewer_type  TEXT NOT NULL CHECK (reviewer_type IN ('human','critic','system')),
  model_provider TEXT,
  model_id       TEXT,
  prompt_version TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX idx_hypothesis_reviews_hypothesis
  ON research_hypothesis_reviews(hypothesis_id, created_at DESC);
```

```sql
CREATE TABLE research_hypothesis_evidence (
  hypothesis_id  TEXT NOT NULL REFERENCES research_hypotheses(id) ON DELETE RESTRICT,
  evidence_id    TEXT NOT NULL REFERENCES research_evidence(id) ON DELETE RESTRICT,
  relation       TEXT NOT NULL CHECK (relation IN ('supports','refutes','context')),
  weight         REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
  note           TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (hypothesis_id, evidence_id, relation)
);
```

### 4.8 Discovery / Decision / Artifact

```sql
CREATE TABLE research_discoveries (
  id                       TEXT PRIMARY KEY,
  idea_id                  TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id                TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  discovery_type           TEXT NOT NULL
                           CHECK (discovery_type IN ('research_gap','knowledge_bridge','contradiction','counterfactual','novelty','other')),
  description              TEXT NOT NULL,
  reasoning_chain          TEXT NOT NULL DEFAULT '',
  supporting_entity_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supporting_entity_ids_json)),
  contradicting_entity_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(contradicting_entity_ids_json)),
  novelty_score            REAL CHECK (novelty_score BETWEEN 0 AND 1),
  gap_quality_score        REAL CHECK (gap_quality_score BETWEEN 0 AND 1),
  evidence_quality_score   REAL CHECK (evidence_quality_score BETWEEN 0 AND 1),
  logical_consistency_score REAL CHECK (logical_consistency_score BETWEEN 0 AND 1),
  falsifiability_score     REAL CHECK (falsifiability_score BETWEEN 0 AND 1),
  potential_impact_score   REAL CHECK (potential_impact_score BETWEEN 0 AND 1),
  total_score              REAL CHECK (total_score BETWEEN 0 AND 1),
  score_explanation_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(score_explanation_json)),
  reviewer_verdict         TEXT
                           CHECK (reviewer_verdict IN ('pass','revise','reject','insufficient_evidence')),
  status                   TEXT NOT NULL DEFAULT 'candidate'
                           CHECK (status IN ('candidate','reviewed','accepted','rejected','superseded')),
  origin_session_id        TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq         INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  version                  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_discoveries_idea_status ON research_discoveries(idea_id, status, total_score DESC);
```

```sql
CREATE TABLE research_decisions (
  id             TEXT PRIMARY KEY,
  idea_id        TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id      TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  title          TEXT NOT NULL,
  decision       TEXT NOT NULL,
  rationale      TEXT NOT NULL DEFAULT '',
  alternatives_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternatives_json)),
  consequences   TEXT NOT NULL DEFAULT '',
  origin_session_id TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq INTEGER,
  created_at     INTEGER NOT NULL,
  created_by     TEXT NOT NULL
);
```

```sql
CREATE TABLE research_artifacts (
  id              TEXT PRIMARY KEY,
  idea_id         TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id       TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  artifact_type   TEXT NOT NULL
                  CHECK (artifact_type IN ('research_report','literature_review','technical_analysis','markdown','html','graph_export','diagram','dataset','other')),
  title           TEXT NOT NULL,
  path            TEXT,
  mime_type       TEXT,
  content_hash    TEXT,
  size_bytes      INTEGER,
  markdown        TEXT,
  metadata_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','ready','missing','failed','archived')),
  origin_session_id TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_artifacts_idea ON research_artifacts(idea_id, created_at DESC);
CREATE INDEX idx_artifacts_status ON research_artifacts(status);
```

> Artifact 文件是派生介质。数据库行是权威；`path` 缺失或 hash 不匹配时可以重建/标记 `missing`，不能静默丢弃记录。

### 4.9 Session Summary

```sql
CREATE TABLE research_session_summaries (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  idea_id         TEXT REFERENCES research_ideas(id) ON DELETE RESTRICT,
  summary         TEXT NOT NULL,
  open_questions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(open_questions_json)),
  hypotheses_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hypotheses_json)),
  artifacts_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifacts_json)),
  event_start_seq INTEGER NOT NULL,
  event_end_seq   INTEGER NOT NULL,
  input_hash      TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'candidate'
                  CHECK (status IN ('candidate','reviewed','superseded','rejected')),
  supersedes_id   TEXT REFERENCES research_session_summaries(id) ON DELETE RESTRICT,
  model_provider  TEXT,
  model_id        TEXT,
  prompt_version  TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE (session_id, event_start_seq, event_end_seq, version)
);

CREATE INDEX idx_summaries_session ON research_session_summaries(session_id, created_at DESC);
```

> Summary 是**快照**，不是覆盖式摘要。同一事件范围重新总结必须产生新 `version`/新行；旧行标 `superseded`，不得原地改写。

### 4.10 Memory

```sql
CREATE TABLE research_memory_records (
  id                TEXT PRIMARY KEY,
  idea_id           TEXT REFERENCES research_ideas(id) ON DELETE RESTRICT,
  layer             TEXT NOT NULL
                    CHECK (layer IN ('session','idea','knowledge','global')),
  memory_type       TEXT NOT NULL
                    CHECK (memory_type IN (
                      'session_summary','idea_summary','claim','evidence','concept','question','gap',
                      'hypothesis','discovery','decision','relation','rejected_path','research_lesson','other')),
  title             TEXT NOT NULL,
  content           TEXT NOT NULL,
  structured_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(structured_json)),
  epistemic_status  TEXT NOT NULL DEFAULT 'inferred'
                    CHECK (epistemic_status IN ('observed','reported','inferred','speculative','disputed','rejected')),
  review_status     TEXT NOT NULL DEFAULT 'candidate'
                    CHECK (review_status IN ('candidate','reviewed','promoted','rejected','superseded','disputed','deprecated')),
  confidence        REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  source_session_id TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  source_event_seqs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_event_seqs_json)),
  source_ids_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_ids_json)),
  origin_tool_call_id TEXT,
  content_hash      TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  supersedes_id     TEXT REFERENCES research_memory_records(id) ON DELETE RESTRICT,
  promoted_at       INTEGER,
  last_used_at      INTEGER,
  use_count         INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK (layer <> 'global' OR idea_id IS NULL)
);

CREATE UNIQUE INDEX ux_memory_hash_layer ON research_memory_records(layer, IFNULL(idea_id, ''), content_hash);
CREATE INDEX idx_memory_idea_review ON research_memory_records(idea_id, layer, review_status, updated_at DESC);
CREATE INDEX idx_memory_session ON research_memory_records(source_session_id);
```

```sql
CREATE TABLE research_memory_versions (
  id             TEXT PRIMARY KEY,
  memory_id      TEXT NOT NULL REFERENCES research_memory_records(id) ON DELETE RESTRICT,
  version        INTEGER NOT NULL,
  snapshot_json  TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  change_reason  TEXT NOT NULL DEFAULT '',
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (memory_id, version)
);
```

```sql
CREATE TABLE research_memory_links (
  memory_id      TEXT NOT NULL REFERENCES research_memory_records(id) ON DELETE RESTRICT,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  relation_type  TEXT NOT NULL DEFAULT 'about'
                 CHECK (relation_type IN ('about','derived_from','supports','refutes','supersedes','related')),
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (memory_id, entity_type, entity_id, relation_type)
);
```

```sql
CREATE TABLE research_memory_sources (
  memory_id    TEXT NOT NULL REFERENCES research_memory_records(id) ON DELETE RESTRICT,
  source_id    TEXT REFERENCES research_sources(id) ON DELETE RESTRICT,
  location_id  TEXT REFERENCES research_source_locations(id) ON DELETE RESTRICT,
  quote        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (memory_id, source_id, location_id)
);
```

> `research_memory_sources` 的 `source_id`/`location_id` 允许至少一个为 NULL，但 service 层必须要求：`epistemic_status='reported'` 时至少有一个非空 source + location；否则必须显式是 `inferred`/`speculative`/`observed`。

### 4.11 Timeline / Context / Job / Outbox

```sql
CREATE TABLE research_timeline_events (
  id           TEXT PRIMARY KEY,
  idea_id      TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  -- Phase 3 迁移增加：
  branch_id    TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  event_type   TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  summary      TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  session_id   TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_timeline_idea_time ON research_timeline_events(idea_id, created_at DESC);
```

```sql
CREATE TABLE research_context_snapshots (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  idea_id        TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  turn           INTEGER,
  step           INTEGER,
  purpose        TEXT NOT NULL
                 CHECK (purpose IN ('session_start','resume','tool_preview','cycle')),
  token_budget   INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  included_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(included_json)),
  omitted_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(omitted_json)),
  rendered_text  TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX idx_context_session_time ON research_context_snapshots(session_id, created_at DESC);
```

```sql
CREATE TABLE research_jobs (
  id             TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,
  idea_id        TEXT REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id      TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','paused','stopping','completed','failed','cancelled')),
  phase          TEXT NOT NULL DEFAULT 'init',
  budget_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(budget_json)),
  used_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(used_json)),
  checkpoint_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checkpoint_json)),
  parent_job_id  TEXT REFERENCES research_jobs(id) ON DELETE RESTRICT,
  error          TEXT,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  updated_at     INTEGER NOT NULL,
  finished_at    INTEGER
);

CREATE INDEX idx_jobs_idea_status ON research_jobs(idea_id, status, updated_at DESC);
```

```sql
CREATE TABLE research_session_checkpoints (
  session_id        TEXT PRIMARY KEY REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  -- 已观察/读取到的最高事件 seq；失败时也可以推进，不能用来跳过处理。
  last_seen_seq     INTEGER NOT NULL DEFAULT -1,
  -- 已完整处理并提交的连续前缀；只有 transaction 成功后才能推进。
  last_successfully_processed_seq INTEGER NOT NULL DEFAULT -1,
  -- 已被 Session Summary 覆盖的连续前缀。
  last_summarized_seq INTEGER NOT NULL DEFAULT -1,
  status            TEXT NOT NULL DEFAULT 'idle'
                    CHECK (status IN ('idle','processing','failed','complete')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  updated_at        INTEGER NOT NULL,
  CHECK (last_seen_seq >= last_successfully_processed_seq),
  CHECK (last_successfully_processed_seq >= last_summarized_seq)
);
```

> `last_seen_seq` 只表示“读到哪儿”，不能用于恢复；`last_successfully_processed_seq` 才是安全水位。并行/乱序处理不在 v1 范围；若未来需要，增加 per-event processing 表（Deferred）。

```sql
CREATE TABLE research_outbox (
  id               TEXT PRIMARY KEY,
  topic            TEXT NOT NULL,
  aggregate_type   TEXT NOT NULL,
  aggregate_id     TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  payload_json     TEXT NOT NULL CHECK (json_valid(payload_json)),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','processing','done','failed','dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  processed_at     INTEGER
);

CREATE INDEX idx_outbox_pending ON research_outbox(status, next_attempt_at);
```

```sql
CREATE TABLE research_schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  INTEGER NOT NULL
);
```

---

## 5. FTS 与可选向量索引

### 5.1 SQLite FTS5

Research 语料主要是英文论文摘要和中文笔记，默认使用 `trigram` tokenizer，兼顾中英文子串检索；若运行环境的 SQLite 不支持 trigram，再退回 `unicode61`。

```sql
CREATE VIRTUAL TABLE research_fts USING fts5(
  title,
  content,
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  idea_id UNINDEXED,
  tokenize = 'trigram'
);
```

维护方式：

- 在写入 Claim / Evidence / Source / Question / Gap / Hypothesis / Discovery / Memory 的同一 SQLite transaction 中删除旧行、插入新行。
- 不要用异步进程维护，否则会与主写入不一致。
- FTS 是派生索引，可以由全量重建任务恢复。

### 5.2 可选 Embedding 索引

```sql
CREATE TABLE research_embeddings (
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  idea_id       TEXT,
  model         TEXT NOT NULL,
  dimension     INTEGER NOT NULL,
  vector        BLOB NOT NULL,
  content_hash  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, model)
);

CREATE INDEX idx_embeddings_idea ON research_embeddings(idea_id, entity_type);
```

- 第一版不必实现；Context Assembly 可先使用 FTS5 + 结构化优先级。
- 若实现，向量只作为召回通道，最终排序仍由结构化分数与来源质量决定。
- 更换 embedding 模型时，新旧索引并存并按 `model` 选择；后台重建，不阻塞研究数据。

---

## 6. 关键不变量

1. **Idea 归属**：除 `layer='global'` 的 Memory 与共享 Source 外，所有研究实体必须有有效 `idea_id`；Source 通过 `origin_idea_id` + `research_idea_sources` 与 Idea 关联。
2. **来源规则**：
   - `epistemic_status='reported'` ⇒ 至少一个 Source + locator；
   - `observed` ⇒ 至少一个 Session event/tool result；
   - `inferred` ⇒ 至少一个 `derived_from` 或 reasoning chain；
   - `speculative` ⇒ 明确 uncertainty；
   - `rejected` ⇒ 保留反证/审查记录。
3. **版本规则**：Hypothesis / Claim / Memory 每次修改必须写版本快照；`current_version`/`version` 与版本表一致。Session Summary 也是不可变快照，重新生成产生新行。
4. **删除规则**：`reviewed` / `promoted` / 已参与推理的实体不允许硬删除；使用状态与 `superseded_id`。
5. **关系端点**：`research_relations` 的两端必须存在；每日对账检查孤儿。
6. **Session 引用**：`origin_session_id` 必须存在于 `research_sessions`；Session 行本身不允许删除，只允许归档。
7. **幂等**：`origin_tool_call_id` 唯一；自动提取实体使用 `idempotency_key`（建议增加 `research_ingest_keys` 表或在实体上建唯一索引）。
8. **Global Memory**：`layer='global'` 必须有 `review_status='promoted'`，且 `idea_id IS NULL`；来源仍通过 `research_memory_sources` 保留。
9. **Outbox**：业务事务中写 outbox，消费者幂等执行；失败可重试，不丢事件。
10. **时间**：`updated_at` 必须单调不减；service 层负责。

### 6.1 自动提取幂等键

建议增加一张轻量表，避免在多个实体表上重复实现：

```sql
CREATE TABLE research_ingest_keys (
  idempotency_key TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  event_seq       INTEGER NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_ingest_session ON research_ingest_keys(session_id, event_seq);
```

自动提取器在同一个 transaction 中先 `INSERT OR IGNORE` 该键；`changes()=0` 表示已处理，直接跳过。

---

## 7. 常用查询模式

### 7.1 Idea Dashboard

```sql
SELECT i.*,
       (SELECT COUNT(*) FROM research_sessions s WHERE s.idea_id = i.id AND s.status <> 'archived') AS session_count,
       (SELECT COUNT(*) FROM research_hypotheses h WHERE h.idea_id = i.id AND h.status IN ('candidate','under_review','supported')) AS hypothesis_count,
       (SELECT COUNT(*) FROM research_questions q WHERE q.idea_id = i.id AND q.status IN ('open','investigating')) AS open_question_count,
       (SELECT COUNT(*) FROM research_discoveries d WHERE d.idea_id = i.id AND d.status = 'candidate') AS pending_discovery_count
FROM research_ideas i
WHERE i.status <> 'archived'
ORDER BY i.updated_at DESC;
```

### 7.2 Idea Context Brief

按优先级取：

1. Idea 本身（objective / research question / current summary）。
2. 最近 3 个 Session Summary。
3. Active Hypotheses（按 updated_at）。
4. Open Questions（按 priority）。
5. Research Gaps（按 uncertainty / updated_at）。
6. 与当前问题最相关的 Claims / Evidence（FTS + 结构化排序）。
7. Contradictions / Rejected paths。
8. Related Idea 的 promoted Memory。
9. Global Memory。

### 7.3 Knowledge Graph

```sql
WITH RECURSIVE reachable(entity_type, entity_id, depth) AS (
  SELECT from_entity_type, from_entity_id, 0
  FROM research_relations
  WHERE idea_id = ? AND from_entity_type = ? AND from_entity_id = ?
  UNION ALL
  SELECT r.to_entity_type, r.to_entity_id, reachable.depth + 1
  FROM research_relations r
  JOIN reachable ON r.from_entity_type = reachable.entity_type
                AND r.from_entity_id = reachable.entity_id
  WHERE r.idea_id = ? AND r.status = 'active' AND reachable.depth < ?
)
SELECT * FROM reachable;
```

### 7.4 Timeline

```sql
SELECT * FROM research_timeline_events
WHERE idea_id = ?
ORDER BY created_at ASC, id ASC;
```

### 7.5 Cross-Idea Memory Reuse

只允许：

- `review_status='promoted'` 且 `layer='global'`；
- 或当前 Idea 通过 `research_idea_relations` 明确关联的 Idea 的 `reviewed` Memory；
- 禁止默认读取其他 Idea 的 candidate / rejected 私有知识。

---

## 8. 与设计文档实体的映射

| 设计实体 | 表 |
|---|---|
| ResearchIdea | `research_ideas` |
| ResearchSession | `research_sessions` + DSH Session Log |
| Source | `research_sources`, `research_source_locations` |
| Concept | `research_concepts` |
| Claim | `research_claims`, `research_claim_versions` |
| Evidence | `research_evidence` |
| Relation | `research_relations` |
| ResearchQuestion | `research_questions` |
| ResearchGap | `research_gaps` |
| Hypothesis | `research_hypotheses`, `research_hypothesis_versions`, `research_hypothesis_reviews` |
| Discovery | `research_discoveries` |
| ResearchBranch | `research_branches` |
| Decision | `research_decisions` |
| Artifact | `research_artifacts` |
| MemoryRecord | `research_memory_records`, versions/links/sources |
| Timeline | `research_timeline_events` |
| Context Snapshot | `research_context_snapshots` |
| Research Job | `research_jobs`, DSH `ctx.jobs` |
| Outbox | `research_outbox` |

---

## 9. 版本迁移策略

1. **只前进不后退。** 每个迁移文件有版本号、名称、checksum；启动时在事务中应用未执行的迁移。
2. **`PRAGMA user_version` 只表示物理布局版本，不等于业务 schema 版本。** 业务版本用 `research_schema_migrations`；两者都检查。
3. **新增列优先 `ALTER TABLE ADD COLUMN`，并允许 NULL 或有默认值。** 不重写大表，除非必要。
4. **删除列/表只做逻辑迁移。** 旧列保留至少一个大版本，service 层停止写入。
5. **版本化 JSON 快照**：Hypothesis/Memory 的 `snapshot_json` 里写 `schema_version`，便于离线阅读。
6. **迁移前备份**：`$DSH_HOME/research/backups/database-<version>-<timestamp>.sqlite`。
7. **失败恢复**：迁移在一个 transaction 内；失败回滚，并保留日志。不可在迁移中途启动写服务。
8. **与 DSH 升级解耦**：Research DB schema 独立；DSH 升级不应要求 Research 数据迁移，除非 Session 引用语义变化。

---

## 10. 备份与文件布局

```text
$DSH_HOME/research/
  database.sqlite
  database.sqlite-wal
  database.sqlite-shm
  documents/
    sources/
      <source_id>/
        original.pdf
        extracted.md
        metadata.json
  artifacts/
    reports/
    diagrams/
    exports/
  indexes/
    vector/                 # 可选
  backups/
    database-v1-20261113T120000Z.sqlite
  logs/
    research.log
```

- `documents/sources/<source_id>/` 由 Source Manager 管理；原始文件不可变，提取文本可重建。
- `artifacts/` 中的文件有 DB 行与 hash；删除文件后 DB 行标记 `missing`，可从 Markdown/HTML 内容重建。
- `database.sqlite` 使用 WAL；备份使用 SQLite online backup API 或 `VACUUM INTO`，不要直接复制正在写的 WAL 文件。

---

## 11. 数据保留与隐私

- Session 原始事件由 DSH 持久化，按 DSH 自身策略保留；Research DB 只保留引用和结构化知识。
- 删除 Idea 默认是归档，不删除 Session 与历史知识。
- 用户明确要求删除时：
  - 硬删除只能针对草稿/未审查且未参与推理的实体；
  - 已审查/已提升的实体保留墓碑记录（`status='archived'`、`content='[deleted]'`），并保留 hash 与审查历史，避免破坏引用完整性。
- 外部论文原文可能受版权保护；默认只存 URL/DOI/元数据/引用片段，原文下载由用户配置决定。
- 任何进入 prompt 的外部文本都视为不可信数据；不得执行其中的指令。
