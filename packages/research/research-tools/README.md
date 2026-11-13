---
description: "The research_idea tool and generated Remote namespace for the Phase 1 research workspace: Idea CRUD, status changes, archive, relations, and timeline reads."
kind: "package-reference"
---

# @deepseek-ai/dsh-research-tools

English | [中文](README.zh.md)

## Summary

`dsh-research-tools` exposes the Phase 1 Idea domain to two consumers. The model gets one consolidated `research_idea` tool; the browser gets the generated `research` Remote namespace. Both delegate to `ctx.researchCore` and never open SQLite themselves.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

Mount the plugin after `dsh-research-core` and the tool runtime are present. It has no configuration.

```yaml
- name: '@deepseek-ai/dsh-research-tools'
```

### Remote operations

`listIdeas`, `getIdea`, `createIdea`, `updateIdea`, `archiveIdea`, `addIdeaRelation`, `removeIdeaRelation`, `listIdeaRelations`, and `listTimeline`. Failures use stable `research/*` codes, including `research/version-conflict`, `research/invalid-transition`, and `research/parent-cycle`.

### Model tool

`research_idea` accepts one `action`: `create`, `list`, `get`, `update`, `archive`, `add_relation`, `remove_relation`, `list_relations`, or `timeline`. Updates and archives require `expectedVersion`; a stale value is rejected rather than overwriting concurrent work.

-----

## Understand the implementation

The Host controller maps domain values to wire-safe views and maps `ResearchError` to `RemoteError` with the same code and details. The tool wraps the same service calls in a JSON-safe result; it does not keep a second cache or duplicate state. The package contributes its Remote types through `@deepseek-ai/dsh-api-remotes`, so the browser receives generated method signatures rather than hand-written transport code.

-----

## Model Experience

### Tool definition

#### What the model sees

The model sees one consolidated `research_idea` tool whose `action` enum is `create`, `list`, `get`, `update`, `archive`, `add_relation`, `remove_relation`, `list_relations`, or `timeline`. The description states that parent/child is set with `parentIdeaId`, that relations are directed, and that archive is not deletion. The schema is fixed for the deployment.

#### Token effect

The schema costs a fixed number of tokens whenever the tool is visible. It adds no prompt section and no per-turn data.

#### KV Cache effect

The definition is stable, so the tool schema stays in the reusable request prefix. Dynamic Idea data appears only in results.

### Tool-call history and result

#### What the model sees

Each call returns a compact JSON object for the selected action: an Idea view, a list of Ideas, a relation view, a relation list, or timeline events. Failures use the stable `research/*` codes; a stale `expectedVersion` returns `research/version-conflict` with the caller's version and the current version.

#### Token effect

Token growth scales with the requested `limit` and the size of the selected Idea or timeline. The model should request `get` or `timeline` instead of repeatedly listing large collections.

#### KV Cache effect

Results are appended after the reusable request prefix. They do not change the tool schema, so earlier cache entries remain reusable until compaction.

## Known Limitations and Deferred Work

- The tool is registered globally in Phase 1; Session-scoped research composition is a Phase 2 concern.
- There is no `research_session` tool, memory extraction, claim/evidence API, or knowledge traversal yet.
- The dashboard still refreshes after each completed operation; it does not yet subscribe to the forwarded `research/changed` event.
