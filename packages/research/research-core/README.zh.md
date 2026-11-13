---
description: "DeepSeek Harness 研究工作区的 Idea 持久化：SQLite schema v1、生命周期转换、有向关系与只追加 Idea 时间线。"
kind: "package-reference"
---

# @deepseek-ai/dsh-research-core

[English](README.md) | 中文

## 摘要

`dsh-research-core` 拥有 Phase 1 的持久研究领域。它把长期 Idea、父子层级、有向关系和只追加时间线存入独立 SQLite 数据库。该数据库与 DSH Session 日志分离：对话事实保留在 Session 事件中，研究记录独立存活。

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

### 生命周期

状态为 `seed`、`exploring`、`developing`、`reviewing`、`mature` 和 `archived`。转换表是显式的，同状态写入为无操作，每次接受的变更都会追加时间线事件。归档设置 `archived_at` 并保留行可读；恢复会清除它。

### 关系

父子关系只存储在 `research_ideas.parent_idea_id`，绝不在关系表中重复。关系表承载 `related_to`（规范化的对称关系）、`derived_from`（派生结果 → 来源）、`merged_from`（合并结果 → 来源）和 `references`（引用方 → 被引用方）。移除会把 `status` 设为 `'superseded'`，保留历史。

-----

<a id="understand-the-implementation"></a>

## 理解实现

数据库使用 WAL、外键、五秒 busy timeout，并且每次变更使用一个同步 `BEGIN IMMEDIATE` 事务。`research_schema_migrations` 记录已应用的 schema 版本和校验和。每次 Idea 变更都在同一事务写入时间线行，因此已提交的 Idea 变更与其历史不会不一致。

`ResearchIdea.workspacePath` 和 `ResearchIdea.lastSessionId` 仅为预留类型字段；Phase 1 从不持久化或返回它们。

-----

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- Phase 1 没有 Session、记忆、Claim、Evidence 或知识表；这些在后续阶段随各自迁移到来。
- 搜索使用 SQL `LIKE`，不是 FTS5；在记忆检索存在前，Idea 搜索面刻意保持很小。
- SQLite 调用在 Host 线程同步执行；这对小型 Idea CRUD 可接受，不适合批量导入。
- 没有删除操作。归档 Idea 保持可读，关系被取代而非移除。
