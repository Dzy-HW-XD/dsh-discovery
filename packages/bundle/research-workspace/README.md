---
description: "Opt-in bundle that adds the Phase 1 Research Workspace Host service, Remote/tool surface, and Web panel on top of dsh-base."
kind: "package-reference"
---

# @deepseek-ai/dsh-research-workspace

English | [中文](README.zh.md)

## Summary

`dsh-research-workspace` is the opt-in profile layer for the Idea-centric research workspace. It inserts `dsh-research-core`, `dsh-research-tools`, and the Web panel without replacing any native DSH row. Phase 2 exposes Ideas, relations, their timeline, and native DSH Session bindings with event checkpoints and Inbox support; later research capabilities are not part of this bundle yet.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

Add the bundle to a base-backed profile. It has no configuration of its own; the core row defaults its database root to `$DSH_HOME/research`.

```yaml
- name: '@deepseek-ai/dsh-research-workspace'
```

The patch inserts the Host core, the Remote/tool controller, and the browser panel. Disabling the bundle removes all three rows together.

-----

## Understand the implementation

The package carries a `cordis.patch.yml` declared through `dsh.bundle.patch`. The Host service owns SQLite; the tools package contributes the `research` Remote namespace and `research_idea`; the client package registers the `research` main panel and sidebar entry. The bundle itself has no runtime API beyond the marker module.

-----

## Model Experience

Indirectly, through the `research_idea` tool that `dsh-research-tools` registers when this bundle mounts it.

#### KV Cache effect

The bundle adds no prompt text; the tool schema is owned by `dsh-research-tools`.

## Known Limitations and Deferred Work

- Phase 2 inserts Idea, relation, timeline, Session binding, checkpoint, and outbox rows; memory, knowledge, discovery, and orchestration are later phases.
- The bundle does not create a research Agent preset; Research-created Sessions use their own setup and standard Sessions use the agent/created fallback.
- The database root is fixed by the core row's default unless a profile overrides that row.
