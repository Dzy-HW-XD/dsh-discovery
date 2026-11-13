---
description: "研究包组导航：Phase 1 交付的 Idea 持久化、research_idea 工具与 Idea 仪表盘。"
kind: "package-group"
---

# packages/research

[English](README.md) | 中文

## 摘要

研究包组拥有以 Idea 为中心的工作区基础。Phase 1 提供长期研究 Idea、它们的有向关系、只追加时间线，以及创建和查看这些记录所需的 Host 与浏览器界面。Session 绑定、记忆、知识、发现和自主执行属于后续阶段，目前不在本包组内。

## 目录

- [包](#packages)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="packages"></a>

## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`research-core`](research-core/README.zh.md) | SQLite 持久化、Idea 生命周期、关系与时间线 | `ctx.researchCore` |
| [`research-tools`](research-tools/README.zh.md) | Host Remote 命名空间 `research` 与面向模型的 `research_idea` 工具 | `ctx.researchController` |
| [`../client/ui-research-workspace`](../client/ui-research-workspace/README.zh.md) | Web 侧边栏入口与 Idea 仪表盘 | 注册 slots |

-----

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- Phase 1 明确排除 Session 绑定、记忆、Claim、Evidence、知识图谱、发现、编排和 Research Outbox。
- 未实现 Idea 删除；归档是唯一受支持的退役路径。
