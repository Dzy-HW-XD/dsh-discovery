---
description: "The research_idea tool and generated Remote namespace for the Phase 1 research workspace: Idea CRUD, status changes, archive, relations, and timeline reads."
kind: "package-reference"
---

# @deepseek-ai/dsh-research-tools

English | [中文](README.zh.md)

## Summary

`dsh-research-tools` exposes the Research domain to the model and browser. The model gets the global `research_idea` tool and, inside a bound Research Session, a scoped `research_session` tool. The browser gets the generated `research` Remote namespace for Ideas, Session bindings, Inbox Sessions, and finalization. Both delegate to `ctx.researchCore` and never open SQLite themselves.

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

`listIdeas`, `getIdea`, `createIdea`, `updateIdea`, `archiveIdea`, `addIdeaRelation`, `removeIdeaRelation`, `listIdeaRelations`, `listTimeline`, and the Phase 2 Session operations `createSession`, `listSessions`, `listInboxSessions`, `getSession`, `linkSession`, `unlinkSession`, and `finalizeSession`. Failures use stable `research/*` codes, including `research/version-conflict`, `research/invalid-transition`, `research/event-gap`, and `research/session-not-found`.

### Model tool

`research_idea` accepts one `action`: `create`, `list`, `get`, `update`, `archive`, `add_relation`, `remove_relation`, `list_relations`, or `timeline`. Updates and archives require `expectedVersion`; a stale value is rejected rather than overwriting concurrent work. A bound Session also receives `research_session` with `list`, `get`, and `finalize` actions; `finalize` only targets the calling Session.

-----

## Understand the implementation

The Host controller maps domain values to wire-safe views and maps `ResearchError` to `RemoteError` with the same code and details. Research-created Sessions use `ctx.agents.create({ setup })`, so the Idea brief and scoped tool exist before the first request. Standard UI Sessions and resumes use the serial `agent/created` fallback; installation is idempotent per Agent and can be removed when the Session is unlinked. The package contributes its Remote types through `@deepseek-ai/dsh-api-remotes`, so the browser receives generated method signatures rather than hand-written transport code.

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

- `research_idea` remains global; `research_session` and the Research prompt are scoped to bound Agents.
- Memory extraction, claim/evidence APIs, knowledge traversal, and discovery are later phases.
- Session event processing persists through the Research outbox; the dashboard still refreshes after each operation instead of subscribing to `research/changed`.
