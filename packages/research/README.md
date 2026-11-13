---
description: "The research group map: Idea persistence, the research_idea tool, and the Idea dashboard that Phase 1 ships, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/research

English | [中文](README.zh.md)

## Summary

The research group owns the Idea-centric workspace foundation. Phase 1 provides long-lived research Ideas, their directed relations, an append-only timeline, and the Host and browser surfaces needed to create and inspect them. Session binding, memory, knowledge, discovery, and autonomous execution belong to later phases and are not part of this group yet.

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

- Phase 1 deliberately excludes Session binding, memory, claims, evidence, knowledge graphs, discovery, orchestration, and the research outbox.
- Idea deletion is not implemented; archive is the only supported retirement path.
