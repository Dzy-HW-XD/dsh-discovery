---
description: "DeepSeek Harness 研究工作区的 Idea 持久化：SQLite schema v1、生命周期转换、有向关系与只追加 Idea 时间线。"
kind: "package-reference"
---

# @deepseek-ai/dsh-research-core

[English](README.md) | 中文

## 摘要

`dsh-research-core` 拥有持久研究领域。它把长期 Idea、父子层级、有向关系、只追加时间线、Session 与 Idea 绑定、事件 checkpoint、持久 Outbox、共享 Source、Claim、Evidence、Concept、Question、Gap、Hypothesis、Discovery、Decision、Artifact、Branch 和 Session Summary 快照存入独立 SQLite 数据库。该数据库与 DSH Session 日志分离：对话事实保留在 Session 事件中，研究记录独立存活。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>

## 使用本包

在 DSH Host 上下文存在后挂载插件。唯一配置字段是数据库根目录。

```yaml
- name: '@deepseek-ai/dsh-research-core'
  config:
    root: !!js dshHomePath('research')
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `$DSH_HOME/research` | 存放 `database.sqlite` 的目录；不存在时以仅所有者可访问权限创建 |

服务提供：

| 操作 | 含义 |
|---|---|
| `createIdea` | 插入 Idea 与其 `idea.created` 时间线事件 |
| `getIdea` / `listIdeas` | 读取一个 Idea，或按状态、父级、归档可见性和字面文本过滤 |
| `updateIdea` | 在乐观并发下应用补丁；状态变化遵循显式转换表 |
| `archiveIdea` | 退役 Idea，但不删除 |
| `parentOf` / `childrenOf` | 读取唯一的权威父子边或其直接子级 |
| `addIdeaRelation` / `removeIdeaRelation` | 添加有向关系，或在不硬删除的情况下取代它 |
| `listTimeline` | 读取只追加的 Idea 历史 |
| `createPendingSession` / `ensureInboxSession` | 记录研究会话或未绑定 Inbox 会话 |
| `linkSessionToIdea` / `unlinkSession` | 改变 primary 归属而不删除历史 |
| `listSessions` / `listInboxSessions` | 查询 Idea 会话或未绑定会话 |
| `finalizeSession` | 标记研究会话完成，不删除 DSH 历史 |
| `recordEventsSeen` / `commitProcessedEvent` | 维护两个处理水位 |
| `artifacts.createSource` / `linkSource` | 导入共享 Source 并关联到 Idea |
| `artifacts.createClaim` / `updateClaim` | 写入 Claim 并保留不可变版本快照 |
| `artifacts.createEvidence` | 把带 Source 的 Evidence 关联到可选 Claim |
| `artifacts.createKnowledgeRelation` | 在同一 Idea 内关联两个已存在实体 |
| `artifacts.createQuestion` / `createGap` / `createHypothesis` | 记录结构化研究产出 |
| `artifacts.createArtifact` / `verifyArtifact` | 原子写入文件并校验 hash |
| `artifacts.recordSessionSummary` | 追加不可变 Session Summary 快照 |
| `memory.createMemory` / `updateMemory` | 写入带来源与生命周期状态的版本化 Memory |
| `memory.addSource` / `addRelation` | 追加来源或关系，不覆盖历史 |
| `memory.createConflict` / `resolveConflict` | 保留相互矛盾的 Memory 供审核 |
| `memory.recordSelection` | 记录一次召回注入，用于审计与 token 统计 |
| `summaries.insert` | 追加结构化、幂等的 Session Summary，并 supersede 上一条 |
| `summaries.list` | 按 Idea/Session 读取 Summary |
| `searchMemories` | FTS5 trigram 召回，短查询走 LIKE fallback |
| `rebuildSearchIndex` | 从权威行重建 FTS 索引 |

### 生命周期

状态为 `seed`、`exploring`、`developing`、`reviewing`、`mature` 和 `archived`。转换表是显式的，同状态写入为无操作，每次接受的变更都会追加时间线事件。归档设置 `archived_at` 并保留行可读；恢复会清除它。

### 关系

父子关系只存储在 `research_ideas.parent_idea_id`，绝不在关系表中重复。关系表承载 `related_to`（规范化的对称关系）、`derived_from`（派生结果 → 来源）、`merged_from`（合并结果 → 来源）和 `references`（引用方 → 被引用方）。移除会把 `status` 设为 `'superseded'`，保留历史。

-----

<a id="understand-the-implementation"></a>

## 理解实现

数据库使用 WAL、外键、五秒 busy timeout，并且每次变更使用一个同步 `BEGIN IMMEDIATE` 事务。`research_schema_migrations` 记录每个已应用的 schema 版本和校验和。每次 Idea 变更都在同一事务写入时间线行，因此已提交的 Idea 变更与其历史不会不一致。Session 事件副作用通过 `research_outbox` 传递；只有标记 outbox 行完成的事务才能推进事件的 `last_successfully_processed_seq`。

Migration v3 增加 artifact 表。Claim 与 Hypothesis 更新追加版本快照，而不是覆盖历史。Artifact 内容先写入临时文件、再 rename、计算 hash，最后才提交数据库；文件缺失或被篡改时，数据库行仍是权威。

Migration v4 增加 Phase 5 Memory 表。Epistemic status 与 lifecycle status 分列；每次更新追加 Memory 版本，并保留来源、关系与变更元数据。Memory 按 Idea 隔离，并记录 Session/实体 provenance。Selection 行记录被注入的 Memory、层级、排序与 token 估算。

Migration v5 为 `research_session_summaries` 增加 objective、key findings、hypotheses、decisions、failed attempts、next steps、source references、generation 状态与幂等键。Migration v6 为 memory sources 增加提取 provenance：Summary id/version、extraction job id、实体版本与 direct/supporting/contradicting/inferred 角色。Migration v7 增加 memory FTS5 trigram 索引与 insert/update/delete 同步，并扩展 Selection 的注入版本、召回分数、状态与位置。Summary 行保留历史：新范围 supersede 上一条，而不是覆盖。

`ResearchIdea.workspacePath` 与 `ResearchIdea.lastSessionId` 由 Phase 2 迁移持久化，存在时返回。

`ResearchIdea.workspacePath` 和 `ResearchIdea.lastSessionId` 仅为预留类型字段；Phase 1 从不持久化或返回它们。

-----

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- Phase 3 没有 Context 快照、Job 或 Hypothesis review；这些随后续阶段到来。
- Phase 5.1 只实现 Memory Store；Summary 生成、Extractor、Retrieval、FTS、Review UI 与 Context 注入属于后续子阶段。
- Artifact 文件位于 `<root>/artifacts`；移动或截断文件会把行标记为 `missing` 或 `failed`，而不会删除记录。
- 搜索使用 SQL `LIKE`，不是 FTS5；在记忆检索存在前，Idea 搜索面刻意保持很小。
- SQLite 调用在 Host 线程同步执行；这对小型 Idea 与 Session 元数据写入可接受，不适合批量导入。
- 没有删除操作。归档 Idea 保持可读，关系被取代而非移除。
