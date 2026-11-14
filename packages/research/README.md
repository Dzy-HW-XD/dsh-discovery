---
description: "The research group map: Idea persistence, the research_idea tool, and the Idea dashboard that Phase 1 ships, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/research

English | [中文](README.zh.md)

## Summary

The research group owns the Idea-centric workspace foundation. Phase 1 provides long-lived research Ideas, their directed relations, and an append-only timeline. Phase 2 binds Ideas to native DSH Sessions, records Inbox Sessions, and processes Session events through a durable outbox and checkpoints. Memory, knowledge, discovery, and autonomous execution belong to later phases.

## Table of Contents

- [Packages](#packages)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Packages

| Package | Role | ctx key |
|---|---|---|
| [`research-core`](research-core/README.md) | SQLite persistence, Idea lifecycle, relations, and timeline | `ctx.researchCore` |
| [`research-tools`](research-tools/README.md) | Host Remote namespace `research` and the model-facing `research_idea` tool | `ctx.researchController` |
| [`../client/ui-research-workspace`](../client/ui-research-workspace/README.md) | Web sidebar entry and Idea dashboard | registers slots |

-----

## Known Limitations and Deferred Work

- Phase 2 stops at Session binding, event processing, and recovery; memory, claims, evidence, knowledge graphs, discovery, and orchestration remain later phases.
- Idea deletion is not implemented; archive is the only supported retirement path.
