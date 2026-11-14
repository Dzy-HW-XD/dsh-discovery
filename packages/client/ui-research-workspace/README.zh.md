---
description: "DeepSeek Harness Web 客户端的研究侧边栏入口与 Idea 仪表盘：列出、创建、查看、转换、归档和关联 Phase 1 Idea。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-research-workspace

[English](README.md) | 中文

## 摘要

`dsh-client-ui-research-workspace` 在现有 DSH Web 客户端中增加一个侧边栏入口和一个主面板。面板列出研究 Idea、创建它们，展示详情、状态、关系、时间线、研究会话与未绑定 Inbox 会话。它通过生成的 `research` Remote 命名空间读写，因此仪表盘反映 Host 数据库状态，而不是硬编码记录。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>

## 使用本包

把本包作为 Web 客户端插件挂载。它需要 Research Remote contribution 以及标准 layout、sidebar、renderer 和 locale 服务。本包没有配置。

```yaml
- name: '@deepseek-ai/dsh-client-ui-research-workspace'
```

插件注册 `main` key `research`，以及与它同 id 的 `sidebar.panellist` 条目。选择该条目会打开仪表盘；原生 Conversation 面板和 Session 导航保持不变。

### 仪表盘

- 默认隐藏已归档 Idea；勾选 `Show archived` 会重新加载并显示它们。
- 空状态说明 Idea 是长期研究入口。
- 创建表单记录标题、研究问题和描述。
- 详情展示状态、版本、父级、摘要、关系与只追加时间线。
- 状态变更使用 Host 转换表；归档会要求确认，并把 Idea 保留在显式归档列表中。
- 关系编辑支持 `related_to`、`derived_from`、`merged_from` 和 `references`；父子关系通过 Idea 父级字段设置。
- 可以在当前 Idea 下创建研究会话、在原生 Conversation 面板打开、解绑回 Inbox，或标记完成。
- Inbox 会话可以绑定到当前 Idea，同时保留原生 Session 列表。

-----

<a id="understand-the-implementation"></a>

## 理解实现

`ResearchPanelView` 是纯仪表盘界面；`ResearchPanel` 是面向 slot 的包装。浏览器插件注册本地化字典和两个 slot 条目，并通过插件 fiber 释放它们。Remote 结果从 `RemoteResult` 解包；失败会显示在面板的 alert 区域，而不会被乐观行替代。

bundle 中没有嵌入静态研究记录。组件内唯一状态是当前 UI 选择和表单值；已提交的 Idea、关系、Session 和时间线行始终来自 Host。

-----

<a id="model-experience"></a>

## 模型体验

None, as the dashboard renders Host Idea records and registers no tool, prompt section, or model input.

#### KV 缓存影响

No model request changes, so the dashboard adds no cacheable prefix.

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- Phase 2 没有 Hypotheses、Knowledge、Discoveries、Artifacts 或 Memory 标签页；这些随后续阶段到来。
- 面板在每次变更后刷新，尚未订阅已转发的 `research/changed` 事件。
- 关系创建把当前选中的 Idea 作为 source；没有批量关系编辑器或图视图。
- 会话详情目前只通过 Remote API 暴露绑定状态和 checkpoint；面板尚未渲染完整 Session inspector。
