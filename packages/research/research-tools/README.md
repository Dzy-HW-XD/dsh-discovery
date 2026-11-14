---
description: "Research tools for the DeepSeek Harness workspace: global Idea CRUD plus Session-scoped sources, concepts, claims, evidence, graph relations, questions, gaps, hypotheses, discoveries, artifacts, branches, and decisions."
kind: "package-reference"
---

# @deepseek-ai/dsh-research-tools

English | [中文](README.zh.md)

## Summary

`dsh-research-tools` exposes the Research domain to the model and browser. The model gets the global `research_idea` tool and, inside a bound Research Session, scoped `research_session` and Phase 3 artifact tools. The browser gets the generated `research` Remote namespace for Ideas, Session bindings, Inbox Sessions, and finalization. Both delegate to `ctx.researchCore` and never open SQLite themselves.

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

`listIdeas`, `getIdea`, `createIdea`, `updateIdea`, `archiveIdea`, `addIdeaRelation`, `removeIdeaRelation`, `listIdeaRelations`, `listTimeline`, the Phase 2 Session operations `createSession`, `listSessions`, `listInboxSessions`, `getSession`, `linkSession`, `unlinkSession`, `finalizeSession`, and `getWorkspace` for the Phase 4 Idea Workspace projection. Failures use stable `research/*` codes, including `research/version-conflict`, `research/invalid-transition`, `research/event-gap`, and `research/session-not-found`.

### Model tool

`research_idea` accepts one `action`: `create`, `list`, `get`, `update`, `archive`, `add_relation`, `remove_relation`, `list_relations`, or `timeline`. Updates and archives require `expectedVersion`; a stale value is rejected rather than overwriting concurrent work.

A bound Session also receives `research_session` (`list`, `get`, `finalize`) and the Phase 3 tools: `research_source` (import/list/locate/locations), `research_concept` (create/list), `research_claim` (create/update/get/list/versions), `research_evidence` (create/list), `research_graph` (entities/relations/relate), `research_question`, `research_gap`, `research_hypothesis` (versions and evidence links), `research_discovery`, `research_artifact` (create/get/verify/list), `research_branch`, and `research_decision`. Every artifact tool records the calling Session and tool-call id as provenance.

-----

## Understand the implementation

The Host controller maps domain values to wire-safe views and maps `ResearchError` to `RemoteError` with the same code and details. Research-created Sessions use `ctx.agents.create({ setup })`, so the Idea brief and scoped tools exist before the first request. Standard UI Sessions and resumes use the serial `agent/created` fallback; installation is idempotent per Agent and can be removed when the Session is unlinked. Phase 3 tools call `ctx.researchCore.artifacts`; artifact content is written atomically before its row commits. The package contributes its Remote types through `@deepseek-ai/dsh-api-remotes`, so the browser receives generated method signatures rather than hand-written transport code.

-----

## Model Experience

### Tool definition

#### What the model sees

The model sees the global `research_idea` tool in every Session, and the scoped Research tools only in a bound Session. The `research_idea` action enum is `create`, `list`, `get`, `update`, `archive`, `add_relation`, `remove_relation`, `list_relations`, or `timeline`. Scoped tools expose one action-oriented schema each; every create/update call carries the Idea id and provenance is taken from the running Agent and tool call rather than model-supplied fields.

#### Token effect

The schema costs a fixed number of tokens whenever the tool is visible. It adds no prompt section and no per-turn data.

#### KV Cache effect

The definition is stable, so the tool schema stays in the reusable request prefix. Dynamic Idea data appears only in results.

### Tool-call history and result

#### What the model sees

Each call returns a compact JSON object for the selected action. Artifact tools return the created entity, a list, counts plus entity summaries, or an artifact verification result. Failures use stable `research/*` codes; missing entities return `research/*-not-found`, invalid epistemic input returns `research/invalid-input`, and a stale `expectedVersion` returns `research/version-conflict`.

#### Token effect

Token growth scales with the requested `limit` and the size of the selected Idea or timeline. The model should request `get` or `timeline` instead of repeatedly listing large collections.

#### KV Cache effect

Results are appended after the reusable request prefix. They do not change the tool schema, so earlier cache entries remain reusable until compaction.

## Known Limitations and Deferred Work

- `research_idea` remains global; `research_session` and the Phase 3 artifact tools are scoped to bound Agents.
- Memory extraction, context assembly, the discovery engine, hypothesis review, and autonomous orchestration are later phases.
- The browser has no artifact read or edit Remote surface yet; Phase 4 adds the Idea Workspace tabs.
- Session event processing persists through the Research outbox; the dashboard still refreshes after each operation instead of subscribing to `research/changed`.
