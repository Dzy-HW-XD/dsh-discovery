---
description: "The Research sidebar entry and Idea dashboard for the DeepSeek Harness Web client: list, create, inspect, transition, archive, and relate Phase 1 Ideas."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-research-workspace

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-research-workspace` adds one sidebar entry and one main panel to the existing DSH Web client. The panel lists research Ideas, creates them, shows their detail, status, relations, timeline, research Sessions, and unbound Inbox Sessions. It reads and writes through the generated `research` Remote namespace, so the dashboard reflects Host database state rather than hardcoded records.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

Mount the package as a Web client plugin. It requires the Research Remote contribution and the standard layout, sidebar, renderer, and locale services. The package has no configuration.

```yaml
- name: '@deepseek-ai/dsh-client-ui-research-workspace'
```

The plugin registers `main` key `research` and a `sidebar.panellist` entry with the same id. Selecting the entry opens the dashboard; the native Conversation panel and Session navigation remain untouched.

### Dashboard

- Archived Ideas are hidden by default; the `Show archived` checkbox reloads the list with them.
- Empty state explains that an Idea is the long-lived research entry point.
- Create form records title, research question, and description.
- Detail shows status, version, parent, summary, relations, and the append-only timeline.
- Status changes use the Host transition table; archive asks for confirmation and keeps the Idea in the explicit archived list.
- Relation editing supports `related_to`, `derived_from`, `merged_from`, and `references`; parent/child is set through the Idea parent field.
- Research Sessions can be created under the selected Idea, opened in the native Conversation panel, unlinked back to the Inbox, or finalized.
- Inbox Sessions can be linked to the selected Idea without replacing the native Session list.

-----

## Understand the implementation

`ResearchPanelView` is the pure dashboard surface; `ResearchPanel` is the slot-facing wrapper. The browser plugin registers localized dictionaries and both slot entries, then disposes them through the plugin fiber. Remote results are unwrapped from `RemoteResult`; a failure is shown in the panel's alert region instead of being replaced by an optimistic row.

No static research records are embedded in the bundle. The only state held in the component is the current UI selection and form values; committed Ideas, relations, sessions, and timeline rows always come from the Host.

-----

## Model Experience

None, as the dashboard renders Host Idea records and registers no tool, prompt section, or model input.

#### KV Cache effect

No model request changes, so the dashboard adds no cacheable prefix.

## Known Limitations and Deferred Work

- Phase 2 has no Hypotheses, Knowledge, Discoveries, Artifacts, or Memory tabs; those arrive with later phases.
- The panel refreshes after each mutation and does not yet subscribe to the forwarded `research/changed` event.
- Relation creation uses the selected Idea as the source; there is no bulk relation editor or graph view.
- Session detail shows binding status and checkpoint data only through the Remote API; the panel does not yet render a full Session inspector.
