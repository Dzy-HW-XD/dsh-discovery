# DSH Research Workspace — Implementation Plan

- 状态：Phase 1–4 已完成；Phase 5.0 审查通过，Phase 5.1 Memory Store 完成，等待 Phase 5.2 授权
- 修订：2026-11-13 Phase 0 Review — 增加 Phase 1 边界、Agent setup 主路径、恢复 watermark
- 标记：DSH 运行时结论为 **Verified**；实施为 **Proposed**；未验证项显式标 **Unverified/Deferred**
- 目标版本：DSH `0.2.2-rc.1`
- 约束：不修改 Agent Loop；不复制聊天历史；不依赖 GPU；Mock LLM 可完整测试
- 交付方式：分阶段实现，每阶段结束提交验收材料并停止

---

## 1. 总体策略

### 1.1 先领域，后智能

顺序必须是：

```text
Idea / Session / 结构化数据
  → Memory / Context
  → Knowledge Graph
  → Discovery / Hypothesis / Critic
  → Autonomous Orchestrator
```

不能先做“自动发现”，再补数据模型；否则所有发现都不可追溯。

### 1.2 先可追溯，后自动化

每个阶段都必须保留：

- `origin_session_id`
- `origin_event_seq` 或 `tool_call_id`
- `source_ids`
- `epistemic_status`
- `review_history`

自动化只能产生 `candidate`，不能直接产生“已确认事实”。

### 1.3 尽量少改 DSH

允许的改动：

- 新增 `packages/research/*`
- 新增 `packages/client/ui-research-workspace`
- 新增 `packages/bundle/research-workspace`
- 在 `packages/api/remotes` 增加 Research Remote contribution 与事件白名单
- 在 profile 中增加 Research bundle/rows
- 文档与生成目录更新

禁止的改动：

- `packages/core/agent-loop`
- `packages/core/agent`
- `packages/core/session` 的格式/语义
- 现有工具行为
- 现有 SessionController API 的破坏性变更

### 1.4 先 SQLite + FTS5，后向量

第一版不引入 Neo4j、Milvus、Elasticsearch、Qdrant。理由：

- DSH 已有 `node:sqlite` 先例。
- 研究规模在单机可控范围。
- 关系查询用 SQL + recursive CTE 足够。
- FTS5 trigram 支持中英文子串检索。
- 向量检索是可替换的召回通道，不是事实来源。

---

## 2. 推荐 Package 结构

```text
packages/
  research/
    research-core/
      src/
        index.ts                 # service + plugin
        db/
          schema.ts              # DDL / migrations
          connection.ts          # node:sqlite open, PRAGMA, transaction
          repositories/
        ideas/
        sessions/
        artifacts/
        timeline/
        outbox/
        errors.ts
      tests/
    research-knowledge/
      src/
        sources/
        concepts/
        claims/
        evidence/
        relations/
        retrieval/
        graph/
      tests/
    research-memory/
      src/
        extraction/
        validation/
        dedup/
        promotion/
        context/
        projections/
      tests/
    research-discovery/
      src/
        gaps/
        bridges/
        contradictions/
        counterfactual/
        novelty/
        hypotheses/
        critic/
        orchestrator/
      tests/
    research-tools/
      src/
        index.ts                 # Host Remote + session registry + Inbox
        controller.ts            # @Remote namespace "research"
        session-registry.ts      # pending ledger, reconciliation
        composition.ts           # setup primary + agent/created fallback: prompt context + scoped tools
        tools/                   # defineTool definitions
      tests/
  client/
    ui-research-workspace/
      src/
        index.ts                 # client plugin
        client/
          panel.tsx              # main keyed slot "research"
          dashboard.tsx
          workspace.tsx
          tabs/...
          graph.tsx
          timeline.tsx
          memory.tsx
          store.ts
          slots.ts
      tests/
  bundle/
    research-workspace/
      cordis.patch.yml
      package.json
      README.md
```

### 2.1 包职责

| 包 | 职责 | 依赖 |
|---|---|---|
| `@deepseek-ai/dsh-research-core` | SQLite、Idea、Session 绑定、Artifact CRUD、Timeline、Outbox、迁移 | `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-home-paths` |
| `@deepseek-ai/dsh-research-knowledge` | Source/Concept/Claim/Evidence/Relation、FTS、Graph Query | `research-core`, `dsh-web`, `dsh-session-query` |
| `@deepseek-ai/dsh-research-memory` | Extraction/Validation/Dedup/Promotion/Context Assembly | `research-core`, `research-knowledge`, `dsh-llm`, `dsh-session-query` |
| `@deepseek-ai/dsh-research-discovery` | Gap/Bridge/Contradiction/Counterfactual/Novelty/Hypothesis/Critic/Cycle | `research-core`, `research-knowledge`, `research-memory`, `dsh-llm`, `dsh-jobs` |
| `@deepseek-ai/dsh-research-tools` | Host Remote、Session registry、`AgentSetup` composition + `agent/created` fallback、model tools | 以上全部 + `dsh-tools`, `dsh-agent`, `dsh-system-prompt`, `dsh-typert-protocol` |
| `@deepseek-ai/dsh-client-ui-research-workspace` | Idea Dashboard/Workspace/Graph/Timeline/Memory UI | client packages, `api-remotes`, `ui-slots`, `ui-workspace` |
| `@deepseek-ai/dsh-research-workspace` (bundle) | 组合 rows、默认配置 | 以上全部 |

### 2.2 为什么不拆 Service Definition / Provider

第一阶段只有 SQLite 实现，拆成 `research-core` + `research-core-sqlite` 会增加包数量和构建复杂度。建议：

- 在 `research-core` 内部保持 `ResearchDatabase` 接口与 `SqliteResearchDatabase` 实现分离。
- 如果未来需要 Postgres/远程后端，再抽出 seam；当前不预拆。

### 2.3 为什么不需要 Agent preset

`research-tools` 提供 `installResearchComposition(agentCtx, agent, binding)`：

- **Research 自建 Session**：在 `ctx.agents.create({ setup })` 中调用；setup 是源码/测试保证的首次请求前组合窗口（Verified）。
- **标准 UI 恢复/Inbox 链接**：在 `agent/created` serial listener 中调用同一个 installer；该路径的 prompt/tools 首次请求可见性目前为 Unverified，Phase 2 必须加测试。

因此：

- 不需要为 Research 定义专用 Agent preset。
- 不需要从 preset 的 scoped context 反推 Agent/Session 身份。
- 标准 UI 创建的 Inbox Session、恢复的旧 Session、fork 的子 Session 都能统一处理（fallback 验证通过后）。
- Agent preset 仍可作为后续可选优化（例如在 UI 上标记“Research session”），但不是核心依赖。

---

## 3. 运行时组合

### 3.1 Bundle 插入的 rows（示意）

```yaml
# packages/bundle/research-workspace/cordis.patch.yml
- insert:
    - id: research-core
      name: '@deepseek-ai/dsh-research-core'
      config:
        root: !!js dshHomePath('research')
        journalMode: wal
    - id: research-knowledge
      name: '@deepseek-ai/dsh-research-knowledge'
    - id: research-memory
      name: '@deepseek-ai/dsh-research-memory'
      config:
        extraction:
          enabled: true
          debounceMs: 30000
        context:
          briefTokens: 1800
    - id: research-discovery
      name: '@deepseek-ai/dsh-research-discovery'
      config:
        autoPromote: false
        defaultBudgets:
          maxLlmCalls: 12
          maxTokens: 60000
          maxMinutes: 20
    - id: research-tools
      name: '@deepseek-ai/dsh-research-tools'
    - id: ui-research-workspace
      name: '@deepseek-ai/dsh-client-ui-research-workspace'
```

### 3.2 Profile 启用

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-research-workspace"
      ]
    }
  }
}
```

开发期也可以只在 `cordis.patch.yml` 插入 rows，不正式发布 bundle。

### 3.3 Client Remote 装配

两条路径：

- **推荐（正式）**：在 `packages/api/remotes/src/client/index.ts` 增加：
  - `import researchRemote from '@deepseek-ai/dsh-research-tools/remote'`
  - 在 `$mount` 列表中加入 `researchRemote`
  - 在 `packages/api/remotes/src/remote-events.ts` 加入 `{ event: 'research/changed', mode: 'emit' }`
- **避免改装配（备选）**：Research UI client plugin 自己 `ctx.remote.$mount(researchRemote)`，并轮询/手动刷新代替 forwarded event。此方案非标准，Phase 4 前需验证 HMR/卸载行为。

Phase 1 建议采用推荐路径；影响范围见 `CHANGE_IMPACT_ANALYSIS.md`。

---

## 4. Phase 0 — 已完成

### 交付

- `ARCHITECTURE_AUDIT.md`
- `IMPLEMENTATION_PLAN.md`
- `DATA_MODEL.md`
- `MEMORY_DESIGN.md`
- `CHANGE_IMPACT_ANALYSIS.md`

### Gate

- 用户审查架构审计与 Phase 1 方案。
- 确认数据根目录、会话结束语义、Inbox 默认行为、是否启用 Research UI 默认入口。
- 未确认前不创建代码、不建库。

---

## 5. Phase 1 — Idea Manager（详细方案）

### 5.0 Phase 1 Scope Boundary（修订）

#### A. Phase 1 必须实现（Must）

- Idea CRUD：create / list / get / update。
- Idea Status：`seed → exploring → developing → reviewing → mature → archived`，允许回退；状态变化写 timeline。
- Archive：归档不删除；默认列表隐藏，显式查询可见。
- Parent / Child：`research_ideas.parent_idea_id`（child → parent），强制无环、单父；查询层提供 `parentOf` / `childrenOf`。
- Related / Derived / Merged：`research_idea_relations` 的 `related_to`（对称）、`derived_from`（派生 → 来源）、`merged_from`（合并结果 → 来源）、`references`（引用 → 被引用）。
- SQLite Persistence：`research_schema_migrations` + `0001_ideas.sql`；WAL、外键、busy_timeout。
- 最小 Dashboard：列表、创建、详情、状态修改、归档、关系编辑、侧边栏入口。
- `research_idea` 合并工具。
- Remote API：Idea CRUD + relation + timeline。
- 最小 timeline：Idea created/updated/status changed/relation added/removed。
- 单元、集成、UI 测试。

#### B. Phase 1 可预留的接口/数据结构（Reserved）

这些是**类型/接口占位**，不是空实现，也不产生数据库表：

- `ResearchIdea` 类型保留未来可选字段 `workspacePath?`、`lastSessionId?`；Phase 1 不持久化，Phase 2 迁移再加列。
- `IdeaStatus` 从第一天包含完整生命周期值；Phase 1 只使用 `seed/exploring/developing/reviewing/mature/archived`。
- `IdeaRelationType` 从第一天包含 `related_to`、`derived_from`、`merged_from`、`references`；Phase 1 只实现这些关系。
- `research/changed` 事件 payload 使用版本化 envelope；Phase 1 只发 `idea.*` 变更，不预留 memory/discovery 字段。
- `ResearchCoreService` 接口可以保留未来方法的**文档注释**，但不得注册返回假数据的 stub。

#### C. Phase 1 明确禁止（Forbidden）

- `research_sessions` 及任何 Session–Idea binding。
- `research_session_idea_links`、`research_session_checkpoints`。
- `research_outbox`（推迟到 Phase 2；Phase 1 直接写 DB + emit `research/changed`）。
- `research_claims`、`research_evidence`、`research_sources`、`research_hypotheses`、`research_questions`、`research_gaps`、`research_discoveries`。
- `research_memory_records`、`research_memory_versions`、Context Assembly。
- Knowledge Graph、Discovery Engine、Scientific Critic、Autonomous Orchestrator。
- `agent/created` Research installer、research Agent preset。
- `research_session` / `research_claim` / `research_memory` / `research_cycle` 等工具。
- 任何 Memory UI、Knowledge 图、Discovery 页面。
- 任何“未来会用”但实际上 Phase 1 不查询的数据库列/表。
- 任何伪造的空实现或返回 mock 数据的 Host API。

#### D. Phase 1 表结构最小化

Phase 1 的 `0001_ideas.sql` 只建：

```text
research_schema_migrations
research_ideas
  id, title, description, research_question, objectives_json,
  status, parent_idea_id, current_summary,
  created_at, updated_at, archived_at, version, created_by
research_idea_relations
  id, from_idea_id, to_idea_id, relation_type, status, note, group_id,
  supersedes_relation_id, created_by, created_at
research_timeline_events
  id, idea_id, event_type, entity_type, entity_id, summary,
  payload_json, created_at
```

不在 Phase 1 建：

- `workspace_id` / `workspace_path` / `last_session_id`（Phase 2 迁移增加）。
- `source_session_id` / `source_event_seq`（Phase 2 迁移增加）。
- `branch_id`（Phase 3 迁移增加）。
- `review_history_json` / 版本快照表（Phase 3/5 按需增加）。
- FTS 索引（Phase 5 需要记忆检索时再建；Idea 标题/描述搜索可以先 `LIKE`）。

### 5.1 范围

实现：

- Idea CRUD。
- 状态流转（允许回退）。
- Parent / Child / Related / Derived / Merged 关系。
- SQLite 持久化与迁移 v1。
- `research_idea` 工具（create/list/get/update/archive）。
- Remote API：`research.*`（listIdeas/getIdea/createIdea/updateIdea/archiveIdea/addRelation/removeRelation）。
- 最小 Idea Dashboard：列表、创建、详情、状态修改、归档。
- 时间线事件（Idea created/updated/status changed/relation added）。

不做：

- Session 绑定（Phase 2）。
- Hypothesis/Claim 等研究实体（Phase 3）。
- Memory/Context（Phase 5/6）。
- Discovery（Phase 8）。

### 5.2 数据表

Phase 1 只建：

- `research_ideas`（最小列，见 5.0.D）
- `research_idea_relations`
- `research_timeline_events`
- `research_schema_migrations`

迁移文件：

```text
src/db/migrations/0001_ideas.sql
```

`research_outbox` 推迟到 Phase 2；Phase 1 的写入是单库事务，成功后直接 emit `research/changed`。

### 5.3 服务 API（示意）

```ts
interface ResearchCoreService {
  createIdea(input: CreateIdeaInput): Promise<ResearchIdea>
  getIdea(id: string): Promise<ResearchIdea | undefined>
  listIdeas(filter?: IdeaFilter): Promise<ResearchIdea[]>
  updateIdea(id: string, patch: UpdateIdeaInput, expectedVersion: number): Promise<ResearchIdea>
  archiveIdea(id: string, reason?: string): Promise<ResearchIdea>
  addIdeaRelation(input: IdeaRelationInput): Promise<void>
  removeIdeaRelation(input: IdeaRelationInput): Promise<void>
  listTimeline(ideaId: string, limit?: number): Promise<TimelineEvent[]>
}
```

规则：

- `updateIdea` 使用乐观锁 `version`；冲突返回 `research/version-conflict`。
- 状态流转由 service 校验；允许回退，但记录 `timeline`。
- 归档不删除；`archived` 状态仍可读。
- 关系不允许自指；`related_to` 按字典序规范化方向；重复关系幂等。
- Parent 变更检查祖先链，禁止环；合并/派生关系写 timeline。
- `removeIdeaRelation` 实际是 `status='superseded'/'rejected'`，不硬删除。

### 5.4 工具

只注册一个合并工具，避免 5 个独立工具：

```ts
research_idea({
  action: 'create' | 'list' | 'get' | 'update' | 'archive' | 'add_relation' | 'remove_relation',
  ...fields
})
```

参数：

- `create`: title, description, researchQuestion, objectives?, workspacePath?
- `get`: ideaId
- `list`: status?, query?, limit?
- `update`: ideaId, expectedVersion, patch
- `archive`: ideaId, reason?
- relation: fromIdeaId, toIdeaId, relationType, note?

输出：

- 结构化 JSON（idea 或 list），`output.render` 生成简洁的人类可读摘要。
- 不把完整 description 塞进 tool result 如果太长；提供 `research_idea_get` 获取全文。

工具位置：

- Phase 1 可全局注册；Phase 2 后通过 setup/fallback installer 只对 research session 注册。
- 为避免非研究 Session 看到工具，Phase 1 最小 UI 即可；如果全局注册，需在描述中说明“用于研究项目”。

### 5.5 Remote API

`ResearchController extends TypertRemoteService`，namespace `research`：

```text
listIdeas
getIdea
createIdea
updateIdea
archiveIdea
addIdeaRelation
removeIdeaRelation
listTimeline
```

失败码（示例）：

- `research/idea-not-found`
- `research/version-conflict`
- `research/invalid-transition`
- `research/relation-invalid`
- `research/database-unavailable`

### 5.6 UI（最小）

`main` keyed slot `research`：

- Idea 列表：标题、状态、更新时间、research question 摘要。
- 新建 Idea 表单。
- Idea 详情：Overview 的最小版本（objective、question、summary、status）。
- 状态切换、归档。
- 关系编辑（parent/related）。
- 侧边栏 `sidebar.panellist` 入口。
- 空状态：解释 Idea 是研究入口。

不做：Sessions/Hypotheses/Knowledge/Graph/Discovery/Artifacts/Memory/Timeline 全量 tabs；Phase 4 完成。

### 5.7 测试

单元：

- CRUD。
- 状态流转与回退。
- 乐观锁冲突。
- 关系唯一性/自指拒绝。
- 归档后仍可读。
- 迁移 v1 幂等。
- Outbox 写入。

工具：

- `research_idea` 参数校验。
- 输出 schema。
- 失败路径。

Remote：

- 成功/失败码。
- 版本冲突。
- 资源不存在。

UI：

- 列表渲染、创建、更新、归档。
- 错误提示。
- 侧边栏入口与 panel 切换。

集成：

- 创建 Idea → SQLite → 重启 → 读取。
- 创建 parent/child → 查询关系。
- 归档 → 默认列表隐藏，显式查询仍可见。

### 5.8 验收

用户能够：

1. 从侧边栏打开 Research 面板。
2. 创建 Idea（标题、描述、研究问题、目标）。
3. 查看 Idea 列表与详情。
4. 修改状态（含回退）。
5. 建立 parent/child/related 关系。
6. 归档 Idea，并在归档过滤器中查看。
7. 重启 DSH 后数据仍在。

### 5.9 风险

- `node:sqlite` 的同步阻塞：Idea CRUD 很小，可接受；批量导入时用事务 + 分批。
- UI panel 首次渲染与 `ctx.layout.selectPanel` 的启动顺序：Phase 1 只注册入口，不强制默认打开；Phase 4 再决定启动策略。
- Remote 装配改动：Phase 1 先做最小 API，若审批不通过则退回工具-only。

---

## 6. Phase 2 — Session–Idea Binding

### 6.1 范围

- `research_sessions`、`research_session_idea_links`、`research_session_checkpoints`。
- `research_outbox`（Phase 2 引入，用于跨介质/异步副作用）。
- Pending 创建账本：
  1. 预生成 session id。
  2. 插入 `pending` 行。
  3. 调用 **ResearchSessionCreator**：
     ```ts
     await mkdir(cwd, { recursive: true })
     ctx.agents.create({
       sessionId,
       meta: { cwd },
       agentOptions: currentDefaultAgentOptions(),
       setup: (agentCtx, agent) => installResearchComposition(agentCtx, agent, binding),
     })
     ```
     该路径绕过 SessionController 的 blank-session 复用/title 逻辑；Research 自己负责 cwd 创建、Workspace attach 和可选 title。Phase 2 的产品语义是：从 Idea 新建 Session 总是创建新会话，不复用全局 blank Session。
  4. 如需 Workspace，创建成功后调用 `workspace.attachSession(sessionId)`。
  5. 成功后置 `active`；setup 失败置 `failed`。
- `setup` 是主要安装位置（Verified）：
  - 查绑定；
  - 注册研究协议 section；
  - 注册 Idea Brief context（Phase 6 前可先用最小摘要）；
  - 注册研究工具（Phase 2 先注册 `research_session` 工具）。
- `agent/created` fallback：
  - 仅用于标准 UI 恢复已绑定 Session（SessionController 不传 setup）以及 live Inbox 链接；
  - 安装必须幂等（推荐 `Symbol.for('dsh.research.installed')` 标记 + 模块内 `WeakSet<Agent>`）；
  - prompt/tools 首次请求可见性当前 **Unverified**，Phase 2 必须新增测试；失败则降级并显示提示。
- Inbox 链接：
  - `research_session_link_idea` 工具/Remote；
  - live agent 链接后调用同一个 installer 追加 scoped composition；
  - 冷会话建议走 `researchSessionOpen`（`ctx.agents.resume({ setup })`）。
- Session 列表/详情 API。
- `research_session_finalize` 空实现（只更新状态、触发 Phase 5 后处理）。

### 6.2 创建流程

```text
UI "New research session"
  → research.createSession({ ideaId, branchId?, workspaceId? })
  → pre-mint session id
  → INSERT research_sessions(status='pending', idea_id=...)
  → ctx.agents.create({
       sessionId,
       meta: { cwd },
       agentOptions,
       setup: installResearchComposition
     })
  → setup 中 lookup binding by agent.id
       - register prompt/context/tools (mode: primary)
       - failure → creation rejects, binding failed
  → 如指定 Workspace：workspace.attachSession(sessionId)
  → UPDATE research_sessions SET status='active'
  → ctx.uiWorkspace.openSession(sessionId)
```

### 6.3 失败恢复

- 创建抛错：`status='failed'`，保留 `last_error`。
- 进程崩溃在创建与更新之间：启动时对 `pending` 行调用 `sessionQuery.observeSession` 或 persistence `stat`；存在则 `active`，不存在则 `failed`。
- 重复创建：同一 `session_id` 已 active 则返回现有绑定，不重复创建。

### 6.4 Inbox

- 标准 UI 创建 Session：`session/created` listener 插入 `status='inbox', idea_id=NULL`。
- 该 listener 必须 try/catch，不能因为 Research DB 故障 veto Session 创建。
- 启动扫描 `ctx.sessionQuery.listSessions()`，为缺失的普通 Session 补 Inbox 行；跳过 `origin='subagent'`。
- Inbox 可链接到 Idea；链接后 `status='active'`、`role='primary'`。

### 6.5 验收

- 从 Idea 创建 Session，Session 出现在 Idea 的 Sessions tab。
- 标准 UI 新建的 Session 出现在 Inbox。
- 重启后绑定仍在。
- Pending 崩溃可恢复。
- 打开旧 Session 时，`researchSessionOpen({ setup })` 或已验证的 `agent/created` fallback 能恢复 research context/tools。
- 必须新增 integration test：在 `agent/created` 中注册 `systemPrompt.section/context` 与 scoped tool，发送第一个 prompt，断言 adapter request 包含它们；未通过则不能把 fallback 当稳定能力。
- 非研究 Session 不受影响。

---

## 7. Phase 3 — Research Artifact Database

### 7.1 范围

实现表与服务：

- `research_sources`（跨 Idea 共享）、`research_idea_sources`、`research_source_locations`
- `research_concepts`
- `research_claims` + `research_claim_versions`
- `research_evidence`
- `research_relations`
- `research_questions`
- `research_gaps`
- `research_hypotheses` + versions + evidence links
- `research_discoveries`
- `research_decisions`
- `research_artifacts`
- `research_branches`
- `research_session_summaries`（结构先建，Phase 5 填充）
- `research_timeline_events`（扩展事件类型）

工具（合并）：

- `research_source`（import/search）
- `research_claim`（create/search）
- `research_evidence`（create）
- `research_graph`（query）
- `research_question`（create/update）
- `research_gap`（create/update）
- `research_hypothesis`（create/update）
- `research_discovery`（create）
- `research_artifact`（create）
- `research_branch`（create/update）
- `research_decision`（create）

不实现：

- Hypothesis review（Phase 8）。
- Discovery engine（Phase 8）。
- Memory extraction（Phase 5）。

### 7.2 关键规则

- 所有实体必须带 `origin_session_id` + `origin_event_seq` 或 `origin_tool_call_id`。
- Claim/Evidence 必须有 epistemic status；`reported` 必须有 Source + locator。
- Hypothesis 修改写版本。
- Relation 两端存在；service 层校验。
- Artifact 文件写临时文件 + rename + hash；DB 行权威。
- Timeline 在每次关键写入时追加。

### 7.3 验收

- Agent 在 Session 中能创建 Claim/Evidence/Question/Gap/Hypothesis/Artifact。
- 能按 Idea 查询所有实体。
- 能查询实体关系和来源。
- Hypothesis 修改有版本历史。
- Artifact 可在 UI/文件系统找到，且 hash 可校验。
- 所有实体可追溯到 Session event/tool call。

---

## 8. Phase 4 — Idea Workspace UI

### 8.1 范围

在 `main` panel `research` 内实现：

- Idea Dashboard（列表、状态、计数、最近发现、待审查）。
- Idea Workspace：
  - Overview
  - Sessions
  - Hypotheses
  - Questions
  - Knowledge
  - Research Graph
  - Discoveries
  - Artifacts
  - Memory
  - Timeline

### 8.2 交互

- 点击 Idea → Workspace。
- 点击 Session → `ctx.uiWorkspace.openSession(sessionId)`。
- 点击 Hypothesis/Question/Claim → 详情抽屉。
- Graph：节点/边、过滤、点击定位实体。
- Timeline：按时间倒序/正序，事件类型过滤。
- Memory：审查队列（Phase 5 后可用）。
- “New Session”按钮 → Phase 2 API → 打开会话。
- “Finalize Session”按钮 → Phase 5 finalize。

### 8.3 数据获取

- Remote `research.*` 返回 host 数据。
- Session 列表状态用 `useSessions`（Client 标准 hook）过滤研究 session ids，避免复制 Host session 状态。
- `research/changed` 事件触发刷新；若未启用 forwarded event，则轮询/手动刷新。

### 8.4 验收

- 用户可以从 Idea 页面看到该 Idea 的全部 Session 与研究产出。
- 所有 tab 可用，空状态清晰。
- 不出现“假数据”；未实现的能力显示明确空状态，不伪造内容。
- 刷新后至少恢复到最近打开的 Idea（localStorage/Remote 状态），具体行为在 Phase 4 设计确认。

---

## 9. Phase 5 — Memory Manager

### 9.1 范围

- Session Summary 生成。
- 从工具结果确定性提取。
- 可选 LLM 提取（candidate）。
- Validation / Dedup / Versioning。
- `research_memory_records` 投影 + FTS。
- 手动 Review（candidate → reviewed）。
- Manual Promotion（reviewed → promoted）。
- Finalize 流程。
- Turn checkpoint / retry / recovery。
- 两个 watermark：`last_seen_seq` 与 `last_successfully_processed_seq`。
- 只有实体 + 投影 + FTS + ingest keys + checkpoint 同一事务提交成功后，才推进成功水位。

### 9.2 触发

- `turn/end` → debounce → checkpoint。
- `research_session_finalize` → 全量。
- `session/disposed` → 尽力而为。
- 启动对账。

### 9.3 验收

- Session 结束后，Idea 出现结构化 Summary 和候选实体。
- 无来源内容不会被标为 `reported`。
- 重复提取不产生重复实体。
- 失败可重试；`last_successfully_processed_seq` 不丢、不冒进。
- 崩溃/重复 job 后从成功水位重放，不产生重复实体。
- 用户可以在 Memory tab 审查/拒绝/提升。
- Promotion 默认需要人工/Critic 批准。

---

## 10. Phase 6 — Context Assembly Engine

### 10.1 范围

- Idea Brief 组装。
- Relevance ranking（FTS + 结构化优先级）。
- Token budget。
- Context dedupe。
- Source attribution。
- Context Preview。
- 注入 DSH：
  - `systemPrompt.section`（协议）。
  - `systemPrompt.context`（Brief，setup 时固定）。
  - `research_context_preview` 工具（按需）。
- `research_context_snapshots` 记录 included/omitted/reason。

### 10.2 验收

- 新 Session 不需要用户重复描述历史。
- Brief 不超过预算。
- 每条加载的记忆都能解释“为什么加载”。
- 不加载其他 Idea 的私有 candidate。
- 恢复 Session 时能刷新 Brief。

---

## 11. Phase 7 — Knowledge Graph

### 11.1 范围

- Concept/Claim/Evidence/Relation 的图查询。
- Contradiction 检测。
- Cross-Idea relationships。
- Graph API + UI。
- 关系置信度/来源。
- 孤儿关系对账。

### 11.2 验收

- 能从任意实体出发查询 N 跳关系。
- 能列出支持/反驳同一 Claim 的证据。
- 能展示跨 Idea 的 promoted 知识连接。
- 图查询有深度/节点数上限。

---

## 12. Phase 8 — Discovery Engine

### 12.1 范围

- Research Gap Discovery。
- Knowledge Bridge Discovery。
- Contradiction Discovery。
- Counterfactual Reasoning。
- Novelty Exploration。
- Hypothesis Generator。
- Scientific Critic（独立调用）。
- `research_hypothesis_reviews`：verdict 绑定 hypothesis version，不能覆盖正文。
- Discovery scoring + reviewer verdict。

### 12.2 关键约束

- Generator 与 Critic 逻辑分离，不能共享同一次调用的隐藏推理。
- Critic 必须独立检索/引用；不能只复述 Generator 理由。
- 所有发现是 `candidate`，等待审查。
- Novelty score 不是客观概率；必须有相似论文检索/引用追踪。
- 不因为“没检索到”就断言“无人研究”。

### 12.3 验收

- 能从现有 Claim/Evidence 提出新的 Research Question 和 Hypothesis。
- 能给出推理链、支持/反对证据、替代解释、证伪条件。
- Critic 能给出 pass/revise/reject/insufficient_evidence 和理由。
- 所有输出可追溯到实体和来源。

---

## 13. Phase 9 — Autonomous Research Orchestrator

### 13.1 范围

- Research Cycle。
- Task planning。
- Branch management。
- Budget（task/LLM/token/time/branch/retrieval）。
- Checkpoint / pause / resume / retry / cancel / recovery。
- 与 `ctx.jobs`、`ctx.schedule` 集成。
- Cycle 状态 UI。

### 13.2 流程

```text
load Idea
  → analyze state
  → identify gaps
  → generate tasks
  → retrieve literature/knowledge
  → analyze claims/relations
  → generate questions
  → generate hypotheses
  → independent critic
  → evaluate discoveries
  → update Idea memory
  → update timeline
  → choose next direction
  → checkpoint
```

### 13.3 约束

- 不无限递归：深度/分支/调用/token/time 上限。
- 每个 cycle 有 durable checkpoint。
- 失败可恢复，不重复创建实体。
- 允许多个 Branch 并行，但每个 Branch 有独立预算。
- 默认不自动 promotion；默认不自动把 candidate 当事实。

### 13.4 验收

- 启动一个 cycle 后，Host 重启可恢复。
- Pause/Resume/Cancel 生效。
- 预算耗尽时安全停止并保存 checkpoint。
- Cycle 的每一步在 timeline/job 表可见。
- 不产生不可追溯的“发现”。

---

## 14. 横切工作

### 14.1 数据库与迁移

- 每个 Phase 增加编号迁移。
- 启动时检查 `research_schema_migrations` + `PRAGMA user_version`。
- 迁移前自动备份。
- 失败回滚并拒绝写入。
- 提供 `research_db_backup` / `research_db_reconcile` 运维命令（Phase 5 起）。

### 14.2 Outbox / 对账

- Phase 2 建立 `research_outbox`；Phase 1 只有单库事务，不需要 Outbox。
- 消费者幂等。
- 启动对账：
  - pending sessions。
  - `last_seen_seq` / `last_successfully_processed_seq` vs Session seq。
  - artifacts vs files。
  - orphan relations。
  - FTS vs entities。
- 对账结果写入日志/UI 诊断。

### 14.3 测试策略

| 类型 | 内容 |
|---|---|
| Unit | CRUD、状态机、版本、关系、validation、context ranking |
| Integration | Idea → Session → Artifact → Finalize → Context restore |
| Mock LLM | 固定 JSON 输出、失败、超时、恶意输出 |
| Hallucination | 虚构论文、错误 DOI、无 locator 的 reported、把推测当事实 |
| Recovery | 进程中断、SQLite busy、写入失败、重复 job、event/DB 不一致 |
| UI | 列表/详情/空状态/错误/刷新 |
| Performance | 10k claims、1k sessions、graph 3 跳、FTS 查询 |

Mock LLM 要求：

- 不依赖 GPU。
- 使用 `dsh-llm-mock-server` 或测试内 fake adapter。
- 覆盖：正常 JSON、非法 JSON、超时、部分结果、矛盾结果、hallucinated citation。

### 14.4 文档

每个 Phase 更新：

- `docs/research-workspace/ARCHITECTURE.md`（如新增）
- `docs/research-workspace/DATA_MODEL.md`
- `docs/research-workspace/IMPLEMENTATION_STATUS.md`
- `docs/research-workspace/CHANGELOG.md`

Phase 0 已交付的五份文档是基线；后续文档必须反映真实实现，不能只复制目标。

### 14.5 验收材料

每个 Phase 结束必须提供：

1. 修改文件清单。
2. 架构变化。
3. 新增功能。
4. 依赖变化。
5. 测试结果（实际执行；未执行要明确说明）。
6. 未解决问题。
7. 已知风险。
8. 下一阶段建议。

---

## 15. 环境与前置条件

| 项 | 当前状态 | 需要 |
|---|---|---|
| Node.js | `v24.22.3` | ✅ 满足 `>=24.9.0` |
| pnpm | 未安装 | 需要 `corepack enable` 或安装 `pnpm@11.28.5` |
| git | 未安装 | 实现/提交需要；当前审计用源码 tarball |
| DSH 源码 | 已下载到 `/tmp/opencode/dsh-src` | 正式开发应在 DSH 仓库工作区 |
| GPU | 无 | 不需要 |
| 网络 | 可用 | 论文抓取需要 |
| SQLite | Node 内置 `node:sqlite` | ✅ |

> 当前工作区 `/home/duziyu/dsh-discovery` 只有文档。Phase 1 开始前需要确定实际代码仓库位置（建议在 DSH 源码仓库内新增 packages），并安装 pnpm。

---

## 16. 依赖图与顺序

```text
Phase 1 Idea
  └─ Phase 2 Session Binding
       └─ Phase 3 Artifact DB
            ├─ Phase 4 UI
            └─ Phase 5 Memory
                 └─ Phase 6 Context
                      └─ Phase 7 Graph
                           └─ Phase 8 Discovery
                                └─ Phase 9 Orchestrator
```

Phase 4 可以在 Phase 5 之前开始，但 Memory tab 在 Phase 5 前只显示空状态。Phase 7 依赖 Phase 3/5；Phase 8 依赖 Phase 6/7；Phase 9 依赖全部。

---

## 17. 里程碑与 Gate

| Gate | 条件 | 决策 |
|---|---|---|
| G0 | Phase 0 文档审查通过 | 允许进入 Phase 1 |
| G1 | Idea CRUD + 最小 UI + 测试 | 允许进入 Phase 2 |
| G2 | Session 绑定 + Inbox + 恢复 | 允许进入 Phase 3 |
| G3 | Artifact DB + 追溯 | 允许进入 Phase 4/5 |
| G4 | 完整 Idea Workspace | 允许进入 Phase 6 |
| G5 | Memory + 手动审查 | 允许进入 Phase 7 |
| G6 | Context 恢复研究状态 | 允许进入 Phase 8 |
| G7 | Graph 查询 | 允许进入 Phase 9 |
| G8 | Discovery + Critic | 允许进入 Phase 9 |
| G9 | Orchestrator 可恢复 | 项目第一阶段完成 |

每个 Gate 都必须有实际测试结果；没有测试就声明“未执行”，不能声称通过。

---

## 18. Phase 1 第一周执行清单（建议）

1. 确认代码仓库位置与 pnpm 环境。
2. 建立 `packages/research/research-core` 骨架、package.json、tsconfig、README。
3. 实现 `SqliteResearchDatabase`：
   - 打开 `$DSH_HOME/research/database.sqlite`。
   - `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`。
   - `research_schema_migrations` + `0001_ideas.sql`。
   - `BEGIN IMMEDIATE` 写事务。
4. 实现 Idea repository + service + timeline（Outbox 留到 Phase 2）。
5. 注册 `research_idea` 工具。
6. 建立 `research-tools` Host Remote `ResearchController`。
7. 在 `api-remotes` 加入 research contribution（最小）。
8. 建立 `ui-research-workspace` 最小 panel + sidebar entry。
9. 单元/集成/UI 测试。
10. 提交 Phase 1 验收材料。

---

## 19. 明确不做的事情

- 不在 Phase 1 建 Session/Memory/Claim 表。
- 不在 Phase 1 做自动研究循环。
- 不在 Phase 1 引入向量数据库。
- 不在 Phase 1 修改 Agent Loop。
- 不在 Phase 1 修改 Session 格式。
- 不把完整聊天记录复制进 Research DB。
- 不把模型输出直接标为事实。
- 不承诺“测试通过”而没有实际执行。
