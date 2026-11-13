# DSH Research Workspace — Change Impact Analysis

- 状态：Phase 0 设计稿；DSH 行为引用标 **Verified**，设计部分为 **Proposed**，未验证项标 **Unverified/Deferred**
- 修订：2026-11-13 Phase 0 Review — 增加 Event Processing/Recovery、两个 watermark、fallback 风险
- 目标版本：DSH `0.2.2-rc.1`
- 范围：Phase 1–9 规划中的改动对 DSH 包、服务、API、UI、数据、Session、插件兼容性的影响
- 原则：**不改 Agent Loop；不改 Session 格式；不复制聊天历史；新增能力优先通过扩展点挂载**

---

## 1. 改动总览

### 1.1 新增

```text
packages/research/research-core
packages/research/research-knowledge
packages/research/research-memory
packages/research/research-discovery
packages/research/research-tools
packages/client/ui-research-workspace
packages/bundle/research-workspace
```

### 1.2 修改现有文件（计划）

| 文件/包 | 改动 | 风险 |
|---|---|---|
| `packages/api/remotes/src/client/index.ts` | import + `$mount` Research Remote contribution | 低 |
| `packages/api/remotes/src/remote-events.ts` | 增加 `research/changed` 白名单 | 低 |
| `packages/api/remotes/package.json` | 增加 Research dev/peer 依赖 | 低 |
| root `tsconfig.host.json` / `tsconfig.client.json` | 增加新包 references | 低（机械） |
| profile `package.json` / `cordis.patch.yml` | 增加 Research bundle/rows | 低（可回滚） |
| 生成的文档/目录 | config catalog、package inventory 等 | 机械 |

### 1.3 明确不修改

- `packages/core/session` 的事件格式与语义。
- `packages/core/agent` 的 Agent 接口。
- `packages/core/agent-loop` 的 turn/step 逻辑。
- `packages/core/system-prompt` 的组装逻辑（只使用 API）。
- `packages/core/tools` 的执行管线（只注册工具）。
- `packages/api/session-controller` 的 API（只调用现有 create）。
- 现有 Session JSONL 格式（不新增 SessionEventMap 成员）。
- 现有工具行为。
- 现有 UI 的会话视图（不替换 `conversation` panel）。

---

## 2. 对 DSH 核心包的影响

### 2.1 Session / Agent Loop

**改动：无。**

原因：

- Session–Idea 绑定外置到 Research DB。
- Idea Memory 通过 `systemPrompt.section/context` 注入。
- 研究工具通过 `ctx.tools.register` 挂载。
- 后处理通过 `session/event` + `sessionQuery` + Jobs。
- 不使用 `agent/pre-step` 改写用户消息。
- 不新增 `SessionEventMap` 事件。
- Research 自建 Session 使用公开的 `ctx.agents.create({ setup })`；不修改 SessionController。

**影响：**

- 现有 Session 行为完全不变。
- 现有 Session 文件格式不变（v4）。
- 不需要 Session 格式迁移。
- 现有 Session 可以在未安装 Research 插件时正常恢复。
- 安装 Research 插件后，已有 Session 只是多出可选的 Inbox/绑定行，不会自动注入研究上下文。

**例外：**

- 如果未来要在 Session Log 里记录 research 事件，会影响 reader compatibility 和格式版本；本计划明确避免。
- 如果未来要用 `agent/pre-step` 强制注入 Memory，会增加与 compaction、hooks 的交互复杂度；本计划不采用。

### 2.2 System Prompt

**改动：仅使用公开 API。**

- `agentCtx.systemPrompt.section()` 注册稳定协议。
- `agentCtx.systemPrompt.context()` 注册 Idea Brief。
- 主要注册发生在 `AgentSetup`（Research 自建 `ctx.agents.create({ setup })` 路径；Verified 首次请求前可见）。
- 标准 SessionController resume 走 `agent/created` fallback（Unverified，Phase 2 加测试）。
- 不修改 SystemPrompt 实现。

**影响：**

- 只对 research sessions 生效（scoped）。
- 非 research sessions 的 prompt 不变。
- Brief 变化会作为新的 durable user-role snapshot 出现；设计上在 setup 时固定文本，避免每轮追加。
- 恢复会话时会重新生成 Brief，可能追加一条新 snapshot；这是预期行为。
- Token/KV cache：稳定 protocol 在 prefix；Brief 在 retained history 后；变更可能使后续 cache 失效，但不会改写前缀。

### 2.3 Tools

**改动：新增 scoped 工具。**

- 只对绑定 Idea 的 Session 注册（主要走 setup；标准 resume/live link 走 `agent/created` fallback）。
- 非 research Session 看不到研究工具。
- 工具定义遵循 `defineTool`，输出 canonical JSON。
- 不需要修改 Tool Registry。

**影响：**

- 研究工具会增加 research session 的 prompt/tool schema token。
- 工具数量需要控制；Phase 1 只暴露 `research_idea`，Phase 2 增加 `research_session`，Phase 3 分批增加。
- 工具命名使用 `research_*`，避免与现有工具冲突。
- `run_code`/PTC 会自动看到工具；这是预期能力，但需要测试。

### 2.4 Jobs

**改动：使用 `ctx.jobs.start()`。**

- 研究提取/循环使用 job。
- 需要声明 `JobKindMap` 的 `research-memory`、`research-cycle`。
- 研究 job 的持久状态在 `research_jobs`；DSH job 负责执行、取消、输出环。
- 默认使用 unowned job 做跨 Session 后处理；如需 Session 权限围栏，可用 owner。

**影响：**

- 新增 job kind 是 additive 的。
- Job 输出可能出现在 UI（如果用户打开 Jobs 面板）；需要清晰的 label。
- Host 关闭时 job 可能被取消；Research DB checkpoint 必须支持恢复。
- 不会改变现有 bash/subagent job 行为。

### 2.5 Session Query

**改动：只读使用。**

- `readSession` / `readSurface` / `filterEvents` / `listSessions`。
- 不修改 session-query。
- 不启用 base 里被禁用的全文搜索（`openAt: never`），因为 Research 使用自己的 FTS5。

**影响：**

- 读取冷 Session 会解码 JSONL；大 Session 可能较慢。
- 提取器需要设置 batch 上限和超时。
- 不依赖 session-query-sqlite 的搜索索引，避免额外配置。

### 2.6 Remote / API Gateway

**改动：新增 namespace + 装配。**

- 新增 `ResearchController extends TypertRemoteService`，namespace `research`。
- 需要修改 `packages/api/remotes`，把 Research contribution 加入 `$mount` 列表。
- 需要把 `research/changed` 加入 forwarded event 白名单（如果 UI 要实时刷新）。
- 生成 Typert artifacts（`typert.host.*`、`typert.remote-client.*`），需要 `pnpm build:lib`。

**影响：**

- Remote namespace 是 additive；不覆盖现有 namespace。
- 需要定义资源授权策略；Phase 1 单用户本地，Remote Access 默认 owner；多用户/远程是后续风险。
- 如果 Research 包未安装，Client 装配不应 import 它；因此 `api-remotes` 的依赖必须与 bundle 同步，避免“Client 有方法、Host 无服务”。
- 生成产物变更会触发大量构建文件；属于机械影响，但 PR 体积会变大。
- 如果采用“Research UI 自行 `$mount`”的备选方案，可避免改 `api-remotes`，但失去集中装配和 forwarded event 白名单，HMR/卸载需要额外验证。

### 2.7 Web Client / UI

**改动：新增 client package + slots。**

- `packages/client/ui-research-workspace` 声明 `dsh.client`，导出 `./client`。
- 注册 `main` keyed slot 的 `research` panel。
- 注册 `sidebar.panellist` 入口。
- 使用 `ctx.uiWorkspace.openSession()` 打开原生会话。
- 不改 `conversation` panel、不改现有 sidebar 行为。

**影响：**

- `main` keyed slot 已有 `conversation` 保留 key；新增 key 是 additive。
- `sidebar.panellist` 是 list slot；新增 entry 是 additive。
- 启动时是否默认选中 Research panel 会影响现有用户习惯；Phase 1 只提供入口，Phase 4 再决定默认策略。
- 没有通用 router，Idea 深链接需要 localStorage/Remote 状态；这是产品限制。
- 新增 client bundle 会增加 Web 启动资源；需要控制依赖，避免引入大型图库。
- 研究面板中的 Session 列表应复用 `useSessions`，不要复制 Client Session 状态。

### 2.8 Profile / Bundle

**改动：新增 bundle，profile 可选启用。**

- `@deepseek-ai/dsh-research-workspace` 作为新 bundle，插入 research rows。
- 不修改 `dsh-base`；不默认修改 `dsh-web-app`。
- 开发期可用 `cordis.patch.yml` 插入 rows。
- 发布/正式启用时在 profile 的 `bundles` 列表追加。

**影响：**

- 未启用 bundle 的用户完全不受影响。
- 启用后新增 Host 服务/工具/Remote/UI rows。
- 如果 bundle 行 id 与用户已有 id 冲突，需要命名空间 `research-*`。
- 如果后续引入可选的 `research` Agent preset，需要检测与用户自定义 preset 同名；当前核心方案不依赖 preset。

### 2.9 数据与存储

**新增：**

```text
$DSH_HOME/research/
  database.sqlite
  documents/
  artifacts/
  indexes/
  backups/
  logs/
```

**影响：**

- 新增磁盘占用；需要备份/清理策略。
- SQLite WAL 需要本地文件系统；网络文件系统可能不支持共享内存。
- 多 Host 同时打开同一 `$DSH_HOME` 时，SQLite 需要 busy_timeout/单写者假设；Phase 1 不做跨进程写协调。
- 不修改 `~/.dsh/sessions` 下任何现有文件。
- 不写 `settings`/`storages` 现有域，避免冲突。

### 2.10 Session 格式与插件兼容性

**明确：不新增 `SessionEventMap` 成员。**

因此：

- 不需要 `SESSION_FORMAT_VERSION` bump。
- 不需要新的格式迁移包。
- 不需要更新 `KNOWN_SESSION_EVENT_TYPES`。
- 旧版本 DSH 可以读取新版本产生的 Session（只要没有其他格式变化）。
- Research 插件卸载后，Session 仍可正常恢复；只是没有 Research context/tools。
- Research DB 中的 `session_id` 引用仍有效。

**如果未来要加 Session event：**

- 必须做 reader compatibility review。
- 必须决定 `ignorable` 还是 required。
- 必须更新格式目录、生成文件、测试。
- 不应在 Phase 1–9 的第一版中做。

---

## 3. 逐阶段影响

### Phase 1 — Idea Manager

| 维度 | 影响 |
|---|---|
| 包 | 新增 `research-core`, `research-tools`, `ui-research-workspace`（最小） |
| 服务 | 新增 `ctx.researchCore`、`ctx.researchController` |
| API | 新增 `ctx.remote.research.*`（Idea CRUD） |
| UI | 新增 `research` main panel + sidebar entry |
| 数据 | 新增 Research DB v1（ideas/relations/timeline；不含 outbox/session 表） |
| Session | 无 |
| 兼容 | 未启用 bundle 无影响；启用后 additive |
| 风险 | 中（首次引入 SQLite/Remote/UI 组合） |

### Phase 2 — Session Binding

| 维度 | 影响 |
|---|---|
| 包 | `research-core`, `research-tools` 扩展 |
| 服务 | `ctx.researchSessions`（或在 core 内） |
| API | `research.createSession/listSessions/linkSession` |
| UI | Sessions tab、New Session、Inbox |
| 数据 | 新增 `research_sessions` 等表 |
| Session | 不修改 SessionController；Research 创建走 `ctx.agents.create({ setup })`；标准 resume 用 `agent/created` fallback |
| 兼容 | 非 research sessions 不受影响；Inbox 行 additive |
| 风险 | 中高（setup 创建事务、fallback 未验证、崩溃恢复） |

### Phase 3 — Artifact DB

| 维度 | 影响 |
|---|---|
| 包 | `research-core`, `research-knowledge`, `research-tools` |
| 服务 | Knowledge/Artifact services |
| API | 新增多个 `research.*` 方法与工具 |
| UI | 数据可用；完整页面在 Phase 4 |
| 数据 | 新增大量表；迁移 v3 |
| Session | 通过工具写入；不改 Session |
| 兼容 | additive |
| 风险 | 中（schema 设计、来源校验） |

### Phase 4 — UI

| 维度 | 影响 |
|---|---|
| 包 | `ui-research-workspace` 大幅扩展 |
| 服务 | 无新 Host 服务（消费 Remote） |
| API | 可能需要分页/图查询 API |
| UI | 新 tabs/graph/timeline；`conversation` 不变 |
| 数据 | 无 |
| Session | 导航使用 `uiWorkspace.openSession` |
| 兼容 | additive；启动默认 panel 需确认 |
| 风险 | 中（UI 复杂度、性能、无 router） |

### Phase 5 — Memory

| 维度 | 影响 |
|---|---|
| 包 | `research-memory`, `research-tools` |
| 服务 | `ctx.researchMemory` |
| API | memory search/review/promote/preview |
| UI | Memory tab |
| 数据 | 新增 memory 表 + FTS |
| Session | `turn/end` 监听、finalize、dispose 兜底 |
| 兼容 | 不改变 Session 格式 |
| 风险 | 高（提取质量、幂等、LLM 依赖） |

### Phase 6 — Context

| 维度 | 影响 |
|---|---|
| 包 | `research-memory` |
| 服务 | Context Assembly |
| API | `research_context_preview` |
| UI | Context Preview / why-loaded |
| 数据 | `research_context_snapshots` |
| Session | `systemPrompt.context` scoped 注入 |
| 兼容 | 只对 research sessions；非 research 不变 |
| 风险 | 中高（token budget、注入时机、cache） |

### Phase 7 — Graph

| 维度 | 影响 |
|---|---|
| 包 | `research-knowledge` |
| 服务 | Graph query |
| API | `research_graph_query` |
| UI | Graph tab |
| 数据 | 关系表、索引 |
| Session | 无 |
| 兼容 | additive |
| 风险 | 中（图规模、递归查询上限） |

### Phase 8 — Discovery

| 维度 | 影响 |
|---|---|
| 包 | `research-discovery` |
| 服务 | Discovery/Hypothesis/Critic |
| API | discovery/hypothesis review |
| UI | Discoveries/Hypotheses 审查 |
| 数据 | discoveries/hypothesis versions |
| Session | 通过工具/Job 运行 |
| 兼容 | additive |
| 风险 | 高（幻觉、评分误导、Generator/Critic 分离） |

### Phase 9 — Orchestrator

| 维度 | 影响 |
|---|---|
| 包 | `research-discovery` |
| 服务 | Cycle/orchestrator |
| API | cycle start/status/pause/resume |
| UI | Cycle status/controls |
| 数据 | research_jobs/checkpoints |
| Session | 可创建/驱动 research sessions |
| 兼容 | additive；预算/恢复必须严格 |
| 风险 | 高（无限循环、成本、恢复、并发） |

---

## 4. API 兼容性

### 4.1 新增 Remote namespace

- namespace：`research`
- 不改现有 `session` / `workspace` / `job` namespace。
- Client 方法通过 Typert 生成；未安装 Research Host 时，Client 不应尝试调用。
- 失败码使用 `research/*` 前缀；不覆盖 `gateway/*`。
- 资源授权：Phase 1 本地单用户；Remote Access 默认 owner。多用户需要额外策略。

### 4.2 新增工具

- 工具名 `research_*`；不与现有工具冲突。
- 只对 research session 可见；非 research session 不受影响。
- 工具输出 schema 稳定；变更走版本化。
- 工具失败使用正常 tool error 路径，不抛到 Agent Loop。

### 4.3 新增 Cordis 事件

- `research/changed`（emit）：UI 刷新。
- 可选 `research/cycle-progress`。
- 不新增 SessionEventMap 事件。
- 事件 payload 必须是 lossless JSON；通过 `api-remotes` 白名单转发。
- 事件不是审计来源；审计在 `research_timeline_events`。

### 4.4 新增服务 key

- `ctx.researchCore`
- `ctx.researchKnowledge`
- `ctx.researchMemory`
- `ctx.researchDiscovery`
- `ctx.researchController`
- 可选 `ctx.researchSessions`

Service key 冲突风险低；建议在包 README 中声明。

### 4.5 Agent Preset（可选，不是核心依赖）

- 核心方案通过 `AgentSetup`（Research 自建 Session）与 `agent/created` fallback（标准 resume）安装 scoped composition，不要求专用 preset。
- 如果后续需要把“Research session”作为可持久化的组合标记，可以增加 `research` preset；届时必须：
  - 检测用户同名 preset，不能静默覆盖；
  - 处理 `SessionHeader.agentPreset` 的恢复与 `agent-preset/locked` 语义；
  - 验证 preset child 如何取得 session_id（当前不推荐依赖该路径）。
- Phase 1–9 的核心验收不依赖 preset。

---

## 5. 数据兼容性

### 5.1 新增数据库

- 与 DSH Session/Storage 数据库分离。
- 不修改 `~/.dsh/storages` 现有域。
- 不修改 `~/.dsh/sessions` 现有文件。
- 备份独立。

### 5.2 Schema 版本

- `research_schema_migrations` 记录业务 schema。
- `PRAGMA user_version` 记录物理布局。
- 迁移只前进；新增列优先可空/默认值。
- 不删除旧列/表，先停止写入一个大版本。

### 5.3 与 Session 的引用

- `session_id` 是逻辑外键；DSH 不提供跨库外键。
- Session 可能被归档/删除（用户操作）；Research DB 行保留，UI 显示“Session 不可用”。
- 启动对账检查引用；不自动删除研究实体。
- Session ID 不重用；DSH 的 fork 会生成新 ID。

### 5.4 文件兼容

- Artifact 文件有 hash；DB 行权威。
- Source 原文/提取文本可重建。
- 备份包含 DB + documents + artifacts；恢复时按 manifest 对账。

---

## 6. Event Processing and Recovery（Phase 0 修订）

> 本节是 **Proposed** 设计；真正实现从 Phase 2/5 开始。目标是把“Session Log 与 Research DB 无共享事务”的缺口变成可重放、可对账、可恢复的流程。

### 6.1 两个 watermark：last_seen 与 last_successfully_processed

```text
last_seen_seq
  = 已读取/观察到的最高 Session event seq
  = 可以在处理失败时推进
  = 只用于“避免重复读”“诊断落后”
  = 不能用于决定从哪继续处理

last_successfully_processed_seq
  = 已完整处理并提交的连续前缀
  = 只有同一 SQLite transaction 成功后才能推进
  = 恢复时从 last_successfully_processed_seq + 1 开始
```

规则：

- `last_seen_seq >= last_successfully_processed_seq`。
- 失败时不能为了“看起来处理完了”而推进成功水位。
- 处理必须按 seq 顺序进行；v1 不支持并行跳段。若未来需要并行，增加 per-event processing 表并维护连续前缀（**Deferred**）。
- `last_summarized_seq` 只表示 Summary 覆盖的连续前缀，不等于实体处理完成。

### 6.2 Session Event 重放

```text
on turn/end or finalize:
  await ctx.sessions.flush(session)          // live session
  snapshot = await ctx.sessionQuery.readSession(sessionId)
  from = checkpoint.last_successfully_processed_seq + 1
  events = snapshot.events.filter(e => e.seq >= from)
  for each event in seq order:
     process deterministically / idempotently
  commit entities + projections + ingest keys + checkpoint
```

约束：

- 只读 raw log 与 current surface；不要解压 `.jsonl.zstd`。
- `readSession` 是 live-preferred；冷 Session 也能读。
- 事件范围以 `event_start_seq`/`event_end_seq` 记录到 Summary 与 ContextSnapshot。
- 不复制完整聊天记录；只存实体、引用、摘要。
- 重放必须产生相同结果；LLM 提取的随机性通过 `prompt_version` + candidate 审查隔离。

### 6.3 Checkpoint 提交协议

```sql
BEGIN IMMEDIATE;

INSERT OR IGNORE INTO research_ingest_keys (...);
-- 若 changes() = 0，说明该事件已处理，跳过实体写入
INSERT INTO research_claims (...);
INSERT INTO research_claim_versions (...);
INSERT INTO research_evidence (...);
INSERT INTO research_memory_records (...);
DELETE FROM research_fts WHERE ...;
INSERT INTO research_fts (...);
UPDATE research_session_checkpoints
SET last_successfully_processed_seq = :newSeq,
    last_seen_seq = MAX(last_seen_seq, :seenSeq),
    status = 'idle',
    attempts = 0,
    last_error = NULL,
    updated_at = :now
WHERE session_id = :sessionId;

COMMIT;
```

- 实体、FTS、幂等键、checkpoint 必须同一事务。
- `last_seen_seq` 可以在读取后单独更新（或与成功事务一起更新），但不能替代成功水位。
- 失败：`ROLLBACK`；`last_successfully_processed_seq` 不变；记录 `status='failed'`、`attempts++`、`last_error`。
- 重试从旧成功水位重放；幂等键避免重复实体。

### 6.4 Job 重复执行

DSH `ctx.jobs` 是进程内运行时；Host 崩溃/重启后不保证 job 只执行一次。Research 侧必须假设 **at-least-once**：

- 每个 job 有 `research_jobs.id` + `idempotency_key`。
- 单飞约束：同一 `session_id` 的提取 job 同时最多一个；同一 `idea_id` 的 cycle 同时最多一个（或按 branch）。
- `research_jobs.status` 状态机：`queued → running → completed|failed|cancelled`；`paused`/`stopping` 是受控中间态。
- 启动时：
  - `running` 且无 live job → 标 `failed`/`interrupted`，重新入队；
  - `queued` → 重新入队；
  - `completed` → 不重复。
- Job 的产出仍通过 SQLite 事务提交；不能只依赖 job 完成状态。
- `ctx.jobs` 的 owner 选择：提取可用 unowned job（跨 Session）；cycle 可用 unowned 或明确 owner，但必须能被 UI 查询/取消。

### 6.5 SQLite 部分写入失败

- 所有多表写入使用 `BEGIN IMMEDIATE`，失败回滚。
- WAL 模式下，崩溃后由 SQLite 自动恢复；应用不能假设“写到一半”可见。
- `SQLITE_BUSY` / `SQLITE_LOCKED`：busy_timeout + 有限重试；不要把 busy 当成功。
- `SQLITE_FULL` / `SQLITE_IOERR` / `unknown-state`：停止写入，标记 Research DB 为 degraded；不继续推进 checkpoint。
- 迁移失败：事务回滚 + 备份保留 + 拒绝启动写服务。
- 文件类副作用（Artifact）不在 SQLite 事务内完成，见 6.7。

### 6.6 Process Crash Recovery

启动时执行一次 **reconcile**（不阻塞 Host 启动，但要在 Research UI 可用前完成或显示状态）：

1. **Session 绑定**：
   - `pending` 行对应的 Session 是否存在（`ctx.sessionQuery.observeSession` / persistence `stat`）。
   - 存在 → `active`；不存在 → `failed`。
2. **Checkpoint**：
   - `last_seen_seq` 与 Session 最新 seq；
   - `last_successfully_processed_seq` 落后 → 重新入队；
   - `status='processing'` 但没有 live job → `failed`/重新入队。
3. **Jobs**：
   - `running`/`stopping` 遗留 → 标失败并重试或取消。
4. **Outbox**：
   - `processing` 超时 → 重置为 `pending`；
   - `failed` 超过阈值 → `dead` + UI 告警。
5. **Artifacts**：
   - DB `ready` 但文件缺失 → `missing`；
   - 文件存在但 DB 无行 → `orphans/` 或登记。
6. **Relations**：
   - 孤儿关系、环、重复边 → 报告，不自动删除（需人工/审查）。
7. **FTS**：
   - 与实体数量/内容 hash 不一致 → 重建。

### 6.7 Session Resume

- 恢复时 `ctx.agents.resume` 会补 interrupted closers，然后重建 Session/Agent。
- Research composition：
  - Research 自己的 `researchSessionOpen` 走 `ctx.agents.resume({ setup })`，setup 是 Verified 的首次请求前窗口；
  - 标准 SessionController resume 不传 setup，使用 `agent/created` fallback（**Unverified**，Phase 2 测试）。
- Resume 不自动“补提取”所有历史；提取由 checkpoint 驱动，在后台 job 中追赶。
- 如果 Session 在崩溃时正在提取：
  - `last_successfully_processed_seq` 之前的已提交；
  - 之后的重新处理；
  - 不重复创建实体（幂等键）。
- 恢复后第一次请求前必须完成 composition 安装；否则模型会看不到研究工具。安装失败时：
  - Research 自己的 open 路径 fail-closed；
  - 标准 UI 路径 fail-open + warning（见 ARCHITECTURE_AUDIT 4.5.4）。

### 6.8 幂等 Artifact Creation

Artifact 可能由工具、Finalize、Cycle 多次触发：

- DB 行使用确定性 `idempotency_key`：
  - `origin_tool_call_id` 唯一；或
  - `hash(idea_id, artifact_type, title, content_hash, source_range)`。
- 文件写入：
  1. 写入临时文件（同目录）。
  2. fsync。
  3. 原子 rename 到最终路径。
  4. 计算 hash。
  5. DB 行从 `pending` → `ready`。
- 文件已存在且 hash 相同 → 复用，不重复写。
- DB 失败 → 文件可留在临时/orphans，启动对账清理。
- DB `ready` 但文件丢失 → `missing`，可从 DB 的 markdown/html 重建。
- 同一 tool call 重放不重复创建 Artifact；同一内容不同 tool call 通过 content hash 去重或建立 `supersedes/duplicate` 关系。

### 6.9 恢复语义总结

| 场景 | 水位 | 行为 |
|---|---|---|
| 提取成功 | 成功水位推进 | 不重复处理 |
| LLM 失败 | 成功水位不动 | 重试，从旧水位重放 |
| SQLite 回滚 | 成功水位不动 | 重试 |
| Host 崩溃 | 成功水位持久化 | 启动对账，重放 |
| Job 重复 | 幂等键 | 不重复实体 |
| Session resume | checkpoint 不变 | 后台追赶 |
| Artifact 重复 | origin/hash | 复用/去重 |
| Session Log 被 compact | 原始 seq 仍保留 | 用 raw log，不用 surface 替代 |

---

## 7. 对现有 Session 的影响

### 7.1 未安装 Research 插件

- 完全不受影响。
- 不创建 Research DB 目录。
- 不注册 tools/Remote/UI。

### 7.2 已安装但 Session 未绑定 Idea

- Session 创建/恢复行为不变。
- `session/created` 可能写入 Inbox 行（best-effort），失败只记日志，不 veto 创建。
- 不注册 research tools/context。
- 不注入任何 Memory。

### 7.3 已绑定 Idea

- Research 自建 Session 通过 `AgentSetup` 注册研究协议 + Idea Brief + tools；标准 resume 通过 `agent/created` fallback。
- 会话记录仍是 DSH 原生 Session Log；Research DB 只增加引用和实体。
- 卸载 Research 插件后，Session 仍可恢复；只是没有研究上下文/工具。
- 重新安装后，绑定仍在；研究上下文按当前 Idea 状态重建。

### 7.4 Fork / Subagent

- Fork 生成新 Session ID；默认不继承 Idea 绑定，除非显式复制。
- Subagent Session 的 `origin='subagent'`；默认不进入 Inbox 列表，避免污染。
- 如果子 Agent 需要研究能力，可显式绑定到 Idea；installer 会按 `agent.id` 查绑定。Phase 2 需测试 subagent session 的默认跳过与显式绑定。

---

## 8. 性能影响

| 场景 | 影响 | 缓解 |
|---|---|---|
| Idea 列表 | 小表 + 索引；可接受 | 分页、计数缓存 |
| Session 列表 | 需要 join/count；可能变慢 | 索引、分页、按需计数 |
| FTS 检索 | trigram 索引较大 | 限制字段、定期 optimize |
| Context Assembly | 多次查询 + 排序 | 单事务读、缓存 Idea Brief、token 上限 |
| Session 提取 | 读取完整日志；大 Session 慢 | checkpoint、分批、超时、后台 job |
| Graph 查询 | 递归 CTE 可能爆炸 | 深度/节点上限、索引、缓存 |
| Discovery | LLM 调用多 | 预算、并发限制、缓存检索结果 |
| UI Graph | 大数据渲染慢 | 限制节点数、增量加载、canvas/SVG 简化 |

SQLite 同步写入会阻塞 Event Loop；所有事务应短小，避免在 `session/event` 同步 listener 中做大查询。重活放 Job。

---

## 9. 安全与权限影响

1. **Remote Access**：Research namespace 是新的资源面。Phase 1 本地单用户；远程/多用户需要资源策略（Idea、Workspace、Session）。
2. **Prompt Injection**：论文/网页是不可信输入；Context Assembly 必须分隔并声明不可信。
3. **文件系统**：Source 导入限制在 Research documents 目录；Artifact 路径限制在 artifacts 目录；防止路径穿越。
4. **工具权限**：研究工具可以写 DB，但不能执行任意 shell；论文抓取通过 `ctx.web` 的 fetch 策略。
5. **凭据**：不存 API key；不把 credentials 写入 Research DB。
6. **数据泄露**：Session 引用可能包含敏感内容；Research DB 只存结构化摘要/引用，不复制全文。
7. **Supply chain**：不引入 Neo4j/Milvus 等额外服务；尽量只用 Node 内置 `node:sqlite` 和现有依赖。

---

## 10. 构建与测试影响

### 10.1 构建

- 新增 packages 需要：
  - root `tsconfig.host.json` / `tsconfig.client.json` references。
  - package `package.json`、`tsconfig.json`、`src/index.ts`。
  - UI 包声明 `dsh.client`，导出 `./client`，使用 tsdown client preset。
- Remote 包需要生成 Typert artifacts：`pnpm run build:lib`。
- 文档生成：config catalog、package inventory、doc-sync。
- `pnpm run constraints` / `typecheck` / `lint` / `build` 必须通过。

### 10.2 测试

- 新增单测/集成测试/e2e；使用 Mock LLM。
- 现有测试不应受影响；但 `api-remotes` 装配变更可能影响相关快照/类型测试。
- UI 新 panel 需要 client 测试；不替换 `conversation`，现有 UI 测试不应变化。
- Session 相关测试不应变化（无格式改动）。

### 10.3 CI 风险

- Typert 生成产物体积大；PR 需要包含生成文件。
- 新增 client bundle 可能影响 Web 构建时间。
- `node:sqlite` 在 CI 环境的版本必须 >= 24.9；与 DSH engines 一致。
- pnpm 版本必须与 root `packageManager` 一致（`pnpm@11.28.5`）。

---

## 11. 回滚策略

### 11.1 Phase 级回滚

- 每个 Phase 独立 bundle/rows；禁用 Research bundle 即回滚 UI/工具/Remote。
- Research DB 保留，不删除；重新启用后继续使用。
- 如果 Phase 5 提取有 bug：禁用 extraction config，保留已有数据；不运行 finalize。
- 如果 Phase 8 Discovery 有 bug：禁用 discovery row；Hypothesis/Claim 仍在。

### 11.2 数据回滚

- 迁移前自动备份。
- 迁移失败自动回滚 transaction。
- 业务数据不支持“降级 schema”；回滚到旧版本时，旧代码必须能忽略新列（通过 `SELECT` 显式列，避免 `SELECT *`）。
- 不删除已审查/已提升的 Memory；只标记状态。

### 11.3 UI 回滚

- 移除 sidebar entry / panel 注册即可；不影响 conversation。
- 如果 panel 注册失败，Web App 仍应正常启动；Research UI 错误不能阻塞主应用。
- 启动默认 panel 策略要可配置，避免用户被锁在 Research 面板。

---

## 12. 风险清单

| # | 风险 | 可能性 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | Session 没有结束事件，Finalize 语义不清 | 高 | 高 | 显式 finalize + turn checkpoint + dispose 兜底 |
| R2 | Session Log 与 SQLite 不一致 | 高 | 高 | 两个 watermark（seen/success）+ 幂等键 + 单事务 checkpoint + 启动对账 |
| R3 | Context 注入过多导致 token 爆炸 | 中 | 高 | 预算、优先级、setup 固定 Brief、按需检索 |
| R4 | LLM 提取幻觉/虚构引用 | 高 | 高 | 工具优先、source/locator 强校验、candidate 审查 |
| R5 | Generator/Critic 不独立 | 中 | 高 | 独立调用、独立证据、独立模型可配 |
| R6 | UI `main` panel 与启动恢复冲突 | 中 | 中 | Phase 4 验证；默认不强制切换 |
| R7 | Remote 装配遗漏导致 UI 调用失败 | 中 | 中 | 生成/类型检查、e2e、bundle 依赖检查 |
| R8 | `node:sqlite` 同步阻塞 | 中 | 中 | 短事务、Job、批量上限 |
| R9 | 多 Host 并发写 DB | 低 | 高 | 单 Host 假设、busy_timeout、后续加锁 |
| R10 | 未来可选 `research` preset 与用户配置冲突 | 低 | 中 | 当前不依赖 preset；引入时做启动检测/命名空间 |
| R11 | FTS trigram 对中文效果有限 | 中 | 中 | 可配置 tokenizer、后续 embedding |
| R12 | Artifact 文件与 DB 不一致 | 中 | 中 | 文件先临时后 rename、hash、对账 |
| R13 | 自动 promotion 污染 Global Memory | 中 | 高 | 默认关闭、人工/Critic 审查 |
| R14 | 研究循环成本失控 | 中 | 高 | 预算、深度限制、pause/cancel |
| R15 | DSH 升级导致 API 漂移 | 中 | 中 | 版本 pin、升级前重新审计、集成测试 |
| R16 | `agent/created` fallback 注册 prompt/tools 未被现有测试覆盖 | 中 | 高 | Phase 2 新增首次请求集成测试；失败则改用 `researchSessionOpen({ setup })` |
| R17 | Research 自建 `ctx.agents.create` 与 Workspace attach/默认模型组合不一致 | 中 | 中 | Phase 2 对照 SessionController 逻辑；测试 cwd/workspace/preset 边界 |
| R18 | `last_seen_seq` 被误当成功水位 | 中 | 高 | 代码审查 + CHECK 约束 + 失败注入测试 |

---

## 13. 验证矩阵

| 改动 | 验证 |
|---|---|
| 新包 | constraints / typecheck / lint / build |
| DB 迁移 | 空库、旧库、失败回滚、备份 |
| Remote | Host/Client 生成、成功/失败码、未安装 bundle |
| UI panel | 注册/卸载/HMR、空状态、错误、启动 |
| Session 绑定 | 创建、崩溃恢复、Inbox、fork/subagent |
| Agent composition | setup 首次请求可见、agent/created fallback 首次请求可见、失败回滚、重复安装 guard |
| Event recovery | last_seen vs success、事务回滚、重放、重复 job、崩溃对账 |
| Context | token budget、explainability、恢复、cache |
| Memory | 提取、去重、版本、provenance、promotion、幻觉 |
| Jobs | 取消、超时、重启恢复、重复执行 |
| Graph | 深度限制、孤儿、跨 Idea |
| Discovery | Critic 独立性、评分解释、无来源拒绝 |
| Orchestrator | 预算、pause/resume、checkpoint、并发 |

---

## 14. 结论

- 该方案的**核心风险不在 DSH 扩展能力**，而在研究数据的语义正确性、一致性与上下文预算。
- 对 DSH 的改动是**加法**：新包、新 bundle、新 Remote namespace、新 slots；不改 Agent Loop、不改 Session 格式。
- 最大的一组兼容性收益是：**Research 数据完全外置**，因此卸载插件不会破坏 Session，升级 DSH 不会强制迁移研究数据。
- 最大的一组工程成本是：**Session 后处理、幂等投影、Context Assembly、Critic 独立性**。
- Phase 1 应保持最小：只做 Idea + SQLite + 最小 UI，不提前引入 Memory/Discovery，以降低一次性设计错误的影响面。
