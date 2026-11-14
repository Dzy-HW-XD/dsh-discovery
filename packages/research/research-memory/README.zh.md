---
description: "DeepSeek Harness 研究工作区的 Host-only 确定性 Session Summary 生成，包含 Outbox 重试与崩溃恢复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-research-memory

[English](README.md) | 中文

## 摘要

`dsh-research-memory` 把已提交的研究 Session 转成结构化、可追溯的 Summary。它读取 Research Database 中的权威实体与 Session 事件，按 id 引用实体而不是复制实体，并通过 Research Summary Store 写入。Summary 任务经过 `research_outbox`，因此重复事件、重试与进程重启不会重复生成同一范围。Phase 5.2 只做确定性生成；模型增强、提取、召回与上下文注入属于后续子阶段。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>

## 使用本包

本包是 Host-only 库。`dsh-research-tools` 使用 Research core 与 Session query reader 构造 coordinator，不需要单独的 profile 行。

```ts
const coordinator = new SummaryCoordinator({
  core: ctx.researchCore,
  reader: ctx.sessionQuery,
  logger: ctx.logger,
})
coordinator.start()
```

`enqueue(sessionId)` 记录当前观察范围的生成任务，`flush()` 排空到期任务，`summarizeNow(sessionId)` 返回最新 Summary。`dispose()` 只停止定时器，不删除排队任务。

<a id="understand-the-implementation"></a>

## 理解实现

引擎选择 provenance 指向当前 Session 的实体，区分 observed/reported Claim 与 inferred Claim，并把 rejected Hypothesis 与 refuting Evidence 归入失败尝试。空 Session 生成最小 Summary，不伪造研究发现。Coordinator 只领取 `research/session-summary` Outbox 行，在事务外读取 Session log，再提交 Summary 与 Outbox 完成状态。幂等键保证重试安全。

<a id="model-experience"></a>

## 模型体验

无，因为本包只为浏览器与后续 Memory Extractor 写入 Summary 行，不注册模型工具或 Prompt 内容。

#### KV 缓存影响

无；Summary 生成不会组装或发送模型请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- 只做确定性 Summary；未启用 LLM enrichment。
- 未实现 Memory Extractor、Retrieval、Context Builder、FTS 或 Review UI。
- 其他 Session 对 Hypothesis 的状态更新不会归因到后一个 Session，因为 Phase 3 实体没有更新 Session 列。
- 引擎读取整个 Session log；不流式处理超大 Session。
