---
description: "The research group map: Idea and Session persistence, scoped Phase 3 research tools, and the Idea dashboard, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/research

English | [中文](README.zh.md)

## Summary

The research group owns the Idea-centric workspace foundation. Phase 1 provides long-lived research Ideas, their directed relations, and an append-only timeline. Phase 2 binds Ideas to native DSH Sessions, records Inbox Sessions, and processes Session events through a durable outbox and checkpoints. Phase 3 adds shared Sources, Concepts, Claims, Evidence, graph relations, Questions, Gaps, Hypotheses, Discoveries, Decisions, Artifacts, and Branches with Session/tool provenance. Phase 5.2 adds deterministic, structured Session summaries. Phase 5.3 adds entity-first candidate extraction with provenance, deduplication, versioning, and conflict marking. Memory, context assembly, discovery, and autonomous execution belong to later phases.

## Table of Contents

- [Packages](#packages)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Packages

| Package | Role | ctx key |
|---|---|---|
| [`research-core`](research-core/README.md) | SQLite persistence for Ideas, Sessions, and Phase 3 artifacts | `ctx.researchCore` |
| [`research-memory`](research-memory/README.md) | Deterministic Session summaries and outbox coordination | `researchMemory` |
| [`research-tools`](research-tools/README.md) | Host Remote namespace `research` and model-facing Idea/Session/artifact tools | `ctx.researchController` |
| [`../client/ui-research-workspace`](../client/ui-research-workspace/README.md) | Web sidebar entry and Idea dashboard | registers slots |

-----

## Known Limitations and Deferred Work

- Phase 5.3 stops at candidate extraction; retrieval, context assembly, FTS, review UI, the discovery engine, and orchestration remain later phases.
- The browser still exposes the Phase 1 Idea dashboard plus Phase 2 Session controls; Phase 4 adds the full Idea Workspace.
- Idea deletion is not implemented; archive is the only supported retirement path.
