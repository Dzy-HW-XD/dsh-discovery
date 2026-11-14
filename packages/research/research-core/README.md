---
description: "Durable research persistence for the DeepSeek Harness research workspace: Ideas, Sessions, checkpoints, outbox, sources, claims, evidence, hypotheses, artifacts, branches, and the append-only timeline."
kind: "package-reference"
---

# @deepseek-ai/dsh-research-core

English | [中文](README.zh.md)

## Summary

`dsh-research-core` owns the durable research domain. It stores long-lived Ideas, their parent/child hierarchy, directed relations, an append-only timeline, Session-to-Idea bindings, event checkpoints, a durable outbox, shared Sources, Claims, Evidence, Concepts, Questions, Gaps, Hypotheses, Discoveries, Decisions, Artifacts, Branches, and Session Summary snapshots in a dedicated SQLite database. The database is separate from the DSH Session log: conversational facts remain in Session events, while research records survive independently.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

Mount the plugin after the DSH Host context exists. The only configuration field is the database root.

```yaml
- name: '@deepseek-ai/dsh-research-core'
  config:
    root: !!js dshHomePath('research')
```

| Field | Default | Meaning |
|---|---|---|
| `root` | `$DSH_HOME/research` | Directory containing `database.sqlite`; created owner-only when absent |

The service exposes:

| Operation | Meaning |
|---|---|
| `createIdea` | Insert an Idea and its `idea.created` timeline event |
| `getIdea` / `listIdeas` | Read one Idea or filter by status, parent, archive visibility, and literal text |
| `updateIdea` | Apply a patch under optimistic concurrency; status changes follow the explicit transition table |
| `archiveIdea` | Retire an Idea without deleting it |
| `parentOf` / `childrenOf` | Read the one authoritative parent edge or its direct children |
| `addIdeaRelation` / `removeIdeaRelation` | Add a directed relation or supersede it without a hard delete |
| `listTimeline` | Read the append-only Idea history |
| `createPendingSession` / `ensureInboxSession` | Record a research Session or an unbound Inbox Session |
| `linkSessionToIdea` / `unlinkSession` | Change primary ownership without deleting history |
| `listSessions` / `listInboxSessions` | Query Idea Sessions or unbound Sessions |
| `finalizeSession` | Mark a research Session complete without deleting DSH history |
| `recordEventsSeen` / `commitProcessedEvent` | Keep the two processing watermarks |
| `artifacts.createSource` / `linkSource` | Import a shared Source and link it to an Idea |
| `artifacts.createClaim` / `updateClaim` | Write a Claim and retain immutable version snapshots |
| `artifacts.createEvidence` | Attach Source-backed Evidence to an optional Claim |
| `artifacts.createKnowledgeRelation` | Relate two existing entities in one Idea |
| `artifacts.createQuestion` / `createGap` / `createHypothesis` | Record structured research outputs |
| `artifacts.createArtifact` / `verifyArtifact` | Store a file atomically and verify its hash |
| `artifacts.recordSessionSummary` | Append an immutable Session Summary snapshot |

### Lifecycle

Statuses are `seed`, `exploring`, `developing`, `reviewing`, `mature`, and `archived`. The transition table is explicit, same-state writes are no-ops, and every accepted change appends a timeline event. Archiving sets `archived_at` and keeps the row readable; restoring clears it.

### Relations

Parent/child is stored only as `research_ideas.parent_idea_id`; it is never duplicated in the relation table. The relation table carries `related_to` (canonicalized symmetric), `derived_from` (derived result → source), `merged_from` (merge result → source), and `references` (referrer → referent). Removal sets `status = 'superseded'`, preserving history.

-----

## Understand the implementation

The database uses WAL, foreign keys, a five-second busy timeout, and one synchronous `BEGIN IMMEDIATE` transaction per mutation. `research_schema_migrations` records each applied schema version and checksum. Every Idea mutation writes its timeline row in the same transaction, so a committed Idea change and its history never disagree. Session event side effects travel through `research_outbox`; an event's `last_successfully_processed_seq` advances only in the transaction that marks its outbox row done.

Migration v3 adds the artifact tables. Claim and Hypothesis updates append version snapshots instead of overwriting history. Artifact content is written to a temporary file, renamed into place, hashed, and only then committed to the database; the row remains authoritative when a file is missing or tampered.

`ResearchIdea.workspacePath` and `ResearchIdea.lastSessionId` are persisted by the Phase 2 migration and returned when present.

-----

## Known Limitations and Deferred Work

- Phase 3 has no memory records, context snapshots, jobs, or hypothesis reviews; those arrive with later phases.
- Artifact files live under `<root>/artifacts`; moving or truncating them marks the row `missing` or `failed` instead of deleting it.
- Search uses SQL `LIKE`, not FTS5; the Idea search surface is intentionally small until memory retrieval exists.
- SQLite calls are synchronous on the Host thread; this is acceptable for small Idea and Session metadata writes, not bulk imports.
- There is no delete operation. Archived Ideas stay readable and relations are superseded, not removed.
