---
description: "研究包组导航：Idea 与 Session 持久化、Phase 3 作用域研究工具与 Idea 仪表盘。"
kind: "package-group"
---

# packages/research

[English](README.md) | 中文

## 摘要

研究包组拥有以 Idea 为中心的工作区基础。Phase 1 提供长期研究 Idea、它们的有向关系与只追加时间线。Phase 2 把 Idea 绑定到原生 DSH Session，记录 Inbox Session，并通过持久 Outbox 与 checkpoint 处理 Session 事件。Phase 3 增加共享 Source、Concept、Claim、Evidence、图关系、Question、Gap、Hypothesis、Discovery、Decision、Artifact 与 Branch，并记录 Session/tool provenance。Phase 5.2 增加确定性、结构化的 Session Summary。Phase 5.3 增加 entity-first 候选提取、provenance、去重、版本与冲突标记。记忆、Context 组装、发现与自主执行属于后续阶段。

## 目录

- [包](#packages)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="packages"></a>

## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`research-core`](research-core/README.zh.md) | Idea、Session 与 Phase 3 artifact 的 SQLite 持久化 | `ctx.researchCore` |
| [`research-memory`](research-memory/README.zh.md) | 确定性 Session Summary 与 Outbox 协调 | `researchMemory` |
| [`research-tools`](research-tools/README.zh.md) | Host Remote 命名空间 `research` 与面向模型的 Idea/Session/artifact 工具 | `ctx.researchController` |
| [`../client/ui-research-workspace`](../client/ui-research-workspace/README.zh.md) | Web 侧边栏入口与 Idea 仪表盘 | 注册 slots |

-----

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- Phase 5.3 止于候选提取；召回、Context 组装、FTS、review UI、发现引擎和编排仍属后续阶段。
- 浏览器仍提供 Phase 1 Idea 仪表盘与 Phase 2 Session 控制；Phase 4 增加完整 Idea Workspace。
- 未实现 Idea 删除；归档是唯一受支持的退役路径。
