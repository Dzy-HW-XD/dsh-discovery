---
description: "DeepSeek Harness 研究工作区的 Host-only 确定性 Session Summary 生成，包含 Outbox 重试与崩溃恢复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-research-memory

[English](README.md) | 中文

## 摘要

`dsh-research-memory` 把已提交的研究 Session 转成结构化、可追溯的 Summary。它读取 Research Database 中的权威实体与 Session 事件，按 id 引用实体而不是复制实体，并通过 Research Summary Store 写入。Summary 任务经过 `research_outbox`，因此重复事件、重试与进程重启不会重复生成同一范围。Phase 5.2 只做确定性生成。Phase 5.3 增加 entity-first Extractor，把完成的 Summary 转成候选 Memory。Phase 5.4 增加 Idea 范围的 FTS 召回、多因子排序、Core/Relevant 预算、Selection 记录与 Agent 注入。模型增强与 review UI 属于后续子阶段。

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

`enqueue(sessionId)` 记录当前观察范围的生成任务，`flush()` 排空到期任务，`summarizeNow(sessionId)` 返回最新 Summary。`dispose()` 只停止定时器，不删除排队任务。`ExtractorCoordinator` 消费独立的 `research/session-memory-extraction` topic，并通过 `ctx.researchCore.memory` 写入候选。`MemoryContextService` 为 `systemPrompt.context` 构建 Core Memory，在每轮第一个 `agent/pre-step` 构建 Relevant Memory，通过 `ctx.researchCore.memory.recordSelection` 记录实际注入版本，并执行 700/500/1200 token 预算。

<a id="understand-the-implementation"></a>

## 理解实现

引擎选择 provenance 指向当前 Session 的实体，区分 observed/reported Claim 与 inferred Claim，并把 rejected Hypothesis 与 refuting Evidence 归入失败尝试。空 Session 生成最小 Summary，不伪造研究发现。Coordinator 只领取 `research/session-summary` Outbox 行，在事务外读取 Session log，再提交 Summary 与 Outbox 完成状态。幂等键保证重试安全。Extractor 重新读取权威实体，不信任 Summary 文本；使用精确 hash 与确定性 Jaccard 相似度进行候选复用、版本更新、possible duplicate 与冲突标记。每条 Memory source 记录 Summary id/version、实体 id/version 与 extraction job id。召回使用 SQLite FTS5 trigram，短查询走 LIKE fallback，按 Idea 与 lifecycle 过滤，扩展一跳关系，并综合文本相关性、epistemic 状态、来源、recency 与冲突排序。序列化上下文标注每个 epistemic/lifecycle 状态，绝不把 Memory 当作指令。

<a id="model-experience"></a>

## 模型体验

无，因为本包只为浏览器与后续 Memory Extractor 写入 Summary 行，不注册模型工具或 Prompt 内容。

#### KV 缓存影响

无；Summary 生成不会组装或发送模型请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- 只做确定性 Summary；未启用 LLM enrichment。
- 未实现 Review UI、Promotion、embedding 或跨 Idea 召回。
- Preference 不自动推断；需要后续阶段的显式用户表达。Procedure 使用 `strategy` 类型与 `structured.kind = 'procedure'`，来源是祈使句 Decision。
- token 数使用 `ctx.tokenMeter` 估算，记录为 `estimated`，不是 provider 精确 tokenizer。
- 注入在模型请求前记录为 `injected`；后续 provider 失败不会回写该记录。
- Core Memory 每次组装重新计算，没有持久 cache 需要失效。
- 其他 Session 对 Hypothesis 的状态更新不会归因到后一个 Session，因为 Phase 3 实体没有更新 Session 列。
- 引擎读取整个 Session log；不流式处理超大 Session。
