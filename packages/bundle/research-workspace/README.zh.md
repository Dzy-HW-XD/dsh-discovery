---
description: "在 dsh-base 之上追加 Research Workspace Host 服务、Phase 3 artifact 工具、Remote 面与 Web 面板的可选 bundle。"
kind: "package-reference"
---

# @deepseek-ai/dsh-research-workspace

[English](README.md) | 中文

## 摘要

`dsh-research-workspace` 是以 Idea 为中心的研究工作区的可选 profile 层。它插入 `dsh-research-core`、`dsh-research-tools` 和 Web 面板，不替换任何 DSH 原生行。Phase 2 暴露 Idea、关系、时间线以及带事件 checkpoint 和 Inbox 的原生 DSH Session 绑定。Phase 3 增加 artifact 数据库与作用域化的 Source、Claim、Evidence、Hypothesis、Artifact、Branch 及相关研究工具；记忆、发现和编排尚不属于本 bundle。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>

## 使用本包

把 bundle 加入基于 base 的 profile。它自身没有配置；core 行的数据库根目录默认是 `$DSH_HOME/research`。

```yaml
- name: '@deepseek-ai/dsh-research-workspace'
```

patch 插入 Host core、Remote/工具 controller 和浏览器面板。禁用 bundle 会同时移除这三行。

-----

<a id="understand-the-implementation"></a>

## 理解实现

本包通过 `dsh.bundle.patch` 声明 `cordis.patch.yml`。Host 服务拥有 SQLite；tools 包贡献 `research` Remote 命名空间和 `research_idea`；client 包注册 `research` 主面板与侧边栏入口。bundle 自身除标记模块外没有运行时 API。

-----

<a id="model-experience"></a>

## 模型体验

Indirectly, through the `research_idea` tool that `dsh-research-tools` registers when this bundle mounts it.

#### KV 缓存影响

The bundle adds no prompt text; the tool schema is owned by `dsh-research-tools`.

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- Phase 2 插入 Idea、关系、时间线、Session 绑定、checkpoint 和 outbox 行；记忆、知识、发现和编排属于后续阶段。
- bundle 不创建 research Agent preset；Research 创建的会话使用自己的 setup，标准会话使用 agent/created fallback。
- 除非 profile 覆盖 core 行，数据库根目录由该行默认值固定。
