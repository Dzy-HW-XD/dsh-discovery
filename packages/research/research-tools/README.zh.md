---
description: "DeepSeek Harness 研究工作区工具：全局 Idea CRUD，以及会话作用域的 Source、Concept、Claim、Evidence、图关系、Question、Gap、Hypothesis、Discovery、Artifact、Branch 与 Decision。"
kind: "package-reference"
---

# @deepseek-ai/dsh-research-tools

[English](README.md) | 中文

## 摘要

`dsh-research-tools` 把研究领域暴露给模型与浏览器。模型得到全局 `research_idea` 工具；在已绑定研究会话中还会得到作用域化的 `research_session` 与 Phase 3 artifact 工具。浏览器得到生成的 `research` Remote 命名空间，用于 Idea、Session 绑定、Inbox Session 和 finalize。两者都委托给 `ctx.researchCore`，绝不自行打开 SQLite。

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

`listIdeas`、`getIdea`、`createIdea`、`updateIdea`、`archiveIdea`、`addIdeaRelation`、`removeIdeaRelation`、`listIdeaRelations`、`listTimeline`，Phase 2 的 `createSession`、`listSessions`、`listInboxSessions`、`getSession`、`linkSession`、`unlinkSession`、`finalizeSession`，Phase 4 Idea Workspace 投影 `getWorkspace`，以及确定性 Session Summary 的 `summarizeSession`。失败使用稳定的 `research/*` 代码，包括 `research/version-conflict`、`research/invalid-transition`、`research/event-gap` 和 `research/session-not-found`。

### 模型工具

`research_idea` 接受一个 `action`：`create`、`list`、`get`、`update`、`archive`、`add_relation`、`remove_relation`、`list_relations` 或 `timeline`。更新和归档需要 `expectedVersion`；过期值会被拒绝，而不是覆盖并发工作。

已绑定会话还会收到 `research_session`（`list`、`get`、`finalize`）以及 Phase 3 工具：`research_source`（import/list/locate/locations）、`research_concept`（create/list）、`research_claim`（create/update/get/list/versions）、`research_evidence`（create/list）、`research_graph`（entities/relations/relate）、`research_question`、`research_gap`、`research_hypothesis`（版本与 Evidence 链接）、`research_discovery`、`research_artifact`（create/get/verify/list）、`research_branch` 和 `research_decision`。每个 artifact 工具都把调用 Session 与 tool-call id 记录为 provenance。

-----

<a id="understand-the-implementation"></a>

## 理解实现

Host controller 把领域值映射为 wire-safe 视图，并把 `ResearchError` 映射为同 code、同 details 的 `RemoteError`。Research 创建的会话使用 `ctx.agents.create({ setup })`，因此 Idea brief 与作用域化工具在首次请求前就存在。标准 UI 会话与恢复路径使用串行 `agent/created` fallback；安装对每个 Agent 幂等，解绑时会移除。Phase 3 工具调用 `ctx.researchCore.artifacts`；artifact 内容在数据库行提交前原子写入。`summarizeSession` 驱动 Host-only 的 `dsh-research-memory` coordinator，在数据库事务外读取已提交 Session log，并通过 `ctx.researchCore.summaries` 写入结构化 Summary。本包通过 `@deepseek-ai/dsh-api-remotes` 贡献 Remote 类型，因此浏览器得到生成的签名，而不是手写传输代码。

-----

<a id="model-experience"></a>

## 模型体验

### 工具定义

#### 模型看到什么

模型在所有会话中看到全局 `research_idea`，仅在已绑定会话中看到作用域化 Research 工具。`research_idea` 的 `action` 枚举为 `create`、`list`、`get`、`update`、`archive`、`add_relation`、`remove_relation`、`list_relations` 或 `timeline`。作用域化工具各自暴露面向 action 的 schema；每次 create/update 都携带 Idea id，provenance 取自运行中的 Agent 与 tool call，而不是模型字段。

#### Token 影响

只要工具可见，schema 就消耗固定 token。它不添加 prompt section，也不添加每轮数据。

#### KV 缓存影响

工具定义稳定，因此工具 schema 留在可复用的请求前缀中。动态 Idea 数据只出现在结果里。

### 工具调用历史与结果

#### 模型看到什么

每次调用返回所选 action 的紧凑 JSON。Artifact 工具返回新建实体、列表、计数与实体摘要，或 artifact 校验结果。失败使用稳定的 `research/*` 代码；缺失实体返回 `research/*-not-found`，非法 epistemic 输入返回 `research/invalid-input`，过期 `expectedVersion` 返回 `research/version-conflict`。

#### Token 影响

Token 增长随请求的 `limit` 以及所选 Idea 或时间线的大小变化。模型应使用 `get` 或 `timeline`，而不是反复列出大集合。

#### KV 缓存影响

结果追加在可复用请求前缀之后。它们不改变工具 schema，因此较早的缓存条目在压缩前仍可复用。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- `research_idea` 仍全局注册；`research_session` 与 Phase 3 artifact 工具仅作用于已绑定 Agent。
- 记忆提取、Context 组装、发现引擎、Hypothesis review 与自主编排属于后续阶段。
- 浏览器尚无 artifact 读取或编辑 Remote 面；Phase 4 增加 Idea Workspace 标签页。
- Summary 仅做确定性生成；Memory 提取、召回与 UI 属于后续 Phase 5 子阶段。
- Session 事件通过 Research Outbox 持久处理；仪表盘仍在每次操作后刷新，尚未订阅 `research/changed`。
