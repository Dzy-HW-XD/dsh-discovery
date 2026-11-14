---
description: "Host-only deterministic Session Summary generation for the DeepSeek Harness research workspace, including outbox retry and crash recovery."
kind: "package-reference"
---

# @deepseek-ai/dsh-research-memory

English | [中文](README.zh.md)

## Summary

`dsh-research-memory` turns committed Research Sessions into structured, traceable summaries. It reads canonical Research Database entities and Session events, references entities by id instead of copying them, and writes summaries through the Research summary store. Summary jobs travel through `research_outbox`, so repeated events, retries, and process restarts do not duplicate a range. Phase 5.2 is deterministic only; model enrichment, extraction, retrieval, and context injection belong to later sub-phases.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

This package is a Host-only library. `dsh-research-tools` constructs the coordinator with the Research core service and the Session query reader; it does not need a separate profile row.

```ts
const coordinator = new SummaryCoordinator({
  core: ctx.researchCore,
  reader: ctx.sessionQuery,
  logger: ctx.logger,
})
coordinator.start()
```

`enqueue(sessionId)` records a job for the observed Session range, `flush()` drains due jobs, and `summarizeNow(sessionId)` returns the latest summary. `dispose()` stops the timer without deleting queued work.

## Understand the implementation

The engine selects entities whose provenance names the current Session, distinguishes observed/reported claims from inferred ones, and maps rejected hypotheses and refuting evidence to failed attempts. Empty Sessions produce a minimal summary rather than invented findings. The coordinator claims only `research/session-summary` outbox rows, reads the Session log outside any transaction, then commits the summary and outbox completion. Summary idempotency keys make retries safe.

## Model Experience

None, as the package writes summary rows for the browser and future memory extractor and registers no model tools or prompt content.

#### KV Cache effect

None; summary generation never assembles or sends provider requests.

## Known Limitations and Deferred Work

- Deterministic summaries only; no LLM enrichment.
- No Memory Extractor, Retrieval, Context Builder, FTS, or Review UI.
- Hypothesis status changes from another Session are not attributed to the later Session because Phase 3 entities do not store an update-Session column.
- The engine reads the whole Session log for the range; it does not stream large Sessions.
