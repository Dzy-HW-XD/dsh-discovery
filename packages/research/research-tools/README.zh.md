---
description: "Phase 1 研究工作区的 research_idea 工具与生成式 Remote 命名空间：Idea CRUD、状态变更、归档、关系与时间线读取。"
kind: "package-reference"
---

# @deepseek-ai/dsh-research-tools

[English](README.md) | 中文

## 摘要

`dsh-research-tools` 把研究领域暴露给模型与浏览器。模型得到全局 `research_idea` 工具；在已绑定研究会话中还会得到作用域化的 `research_session` 工具。浏览器得到生成的 `research` Remote 命名空间，用于 Idea、Session 绑定、Inbox Session 和 finalize。两者都委托给 `ctx.researchCore`，绝不自行打开 SQLite。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>

## 使用本包

在 `dsh-research-core` 与工具运行时存在后挂载插件。它没有配置。

```yaml
- name: '@deepseek-ai/dsh-research-tools'
```

### Remote 操作

`listIdeas`、`getIdea`、`createIdea`、`updateIdea`、`archiveIdea`、`addIdeaRelation`、`removeIdeaRelation`、`listIdeaRelations`、`listTimeline`，以及 Phase 2 的 `createSession`、`listSessions`、`listInboxSessions`、`getSession`、`linkSession`、`unlinkSession` 和 `finalizeSession`。失败使用稳定的 `research/*` 代码，包括 `research/version-conflict`、`research/invalid-transition`、`research/event-gap` 和 `research/session-not-found`。

### 模型工具

`research_idea` 接受一个 `action`：`create`、`list`、`get`、`update`、`archive`、`add_relation`、`remove_relation`、`list_relations` 或 `timeline`。更新和归档需要 `expectedVersion`；过期值会被拒绝，而不是覆盖并发工作。已绑定会话还会收到 `research_session`，支持 `list`、`get` 和 `finalize`；`finalize` 只能作用于当前会话。

-----

<a id="understand-the-implementation"></a>

## 理解实现

Host controller 把领域值映射为 wire-safe 视图，并把 `ResearchError` 映射为同 code、同 details 的 `RemoteError`。Research 创建的会话使用 `ctx.agents.create({ setup })`，因此 Idea brief 与作用域化工具在首次请求前就存在。标准 UI 会话与恢复路径使用串行 `agent/created` fallback；安装对每个 Agent 幂等，解绑时会移除。本包通过 `@deepseek-ai/dsh-api-remotes` 贡献 Remote 类型，因此浏览器得到生成的签名，而不是手写传输代码。

-----

<a id="model-experience"></a>

## 模型体验

### 工具定义

#### 模型看到什么

模型看到一个合并的 `research_idea` 工具，其 `action` 枚举为 `create`、`list`、`get`、`update`、`archive`、`add_relation`、`remove_relation`、`list_relations` 或 `timeline`。描述说明父子关系通过 `parentIdeaId` 设置、关系有方向、归档不是删除。schema 在该部署中固定。

#### Token 影响

只要工具可见，schema 就消耗固定 token。它不添加 prompt section，也不添加每轮数据。

#### KV 缓存影响

工具定义稳定，因此工具 schema 留在可复用的请求前缀中。动态 Idea 数据只出现在结果里。

### 工具调用历史与结果

#### 模型看到什么

每次调用返回所选 action 的紧凑 JSON：Idea 视图、Idea 列表、关系视图、关系列表或时间线事件。失败使用稳定的 `research/*` 代码；过期的 `expectedVersion` 返回 `research/version-conflict`，并携带调用方版本与当前版本。

#### Token 影响

Token 增长随请求的 `limit` 以及所选 Idea 或时间线的大小变化。模型应使用 `get` 或 `timeline`，而不是反复列出大集合。

#### KV 缓存影响

结果追加在可复用请求前缀之后。它们不改变工具 schema，因此较早的缓存条目在压缩前仍可复用。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- `research_idea` 仍全局注册；`research_session` 与研究 prompt 仅作用于已绑定 Agent。
- 记忆提取、Claim/Evidence API、知识遍历和发现属于后续阶段。
- Session 事件通过 Research Outbox 持久处理；仪表盘仍在每次操作后刷新，尚未订阅 `research/changed`。
