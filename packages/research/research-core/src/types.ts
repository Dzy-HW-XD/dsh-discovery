/**
 * Research workspace Phase 1 domain vocabulary: Ideas, directed Idea
 * relations, status transitions, and timeline records. SQLite persistence and
 * the Cordis service are separate modules.
 * @module @deepseek-ai/dsh-research-core/types
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Stable identity of one long-lived research Idea. */
export type IdeaId = Branded<'IdeaId'>

/**
 * Admit a raw string as an Idea identity.
 * @param value - raw persisted or parsed id.
 * @returns the same string with the Idea brand.
 */
export function IdeaId(value: string): IdeaId {
  return brandString<IdeaId>(value)
}

/** Stable identity of one directed Idea relation. */
export type IdeaRelationId = Branded<'IdeaRelationId'>

/**
 * Admit a raw string as an Idea relation identity.
 * @param value - raw persisted or parsed id.
 * @returns the same string with the relation brand.
 */
export function IdeaRelationId(value: string): IdeaRelationId {
  return brandString<IdeaRelationId>(value)
}

/** Stable identity of one Idea timeline event. */
export type TimelineEventId = Branded<'TimelineEventId'>

/**
 * Admit a raw string as a timeline event identity.
 * @param value - raw persisted or parsed id.
 * @returns the same string with the timeline brand.
 */
export function TimelineEventId(value: string): TimelineEventId {
  return brandString<TimelineEventId>(value)
}

/** Lifecycle states owned by an Idea. */
export const IDEA_STATUSES = [
  'seed',
  'exploring',
  'developing',
  'reviewing',
  'mature',
  'archived',
] as const

/** One Idea lifecycle state. */
export type IdeaStatus = typeof IDEA_STATUSES[number]

/** Directed relation kinds. Parent/Child is deliberately absent. */
export const IDEA_RELATION_TYPES = [
  'related_to',
  'derived_from',
  'merged_from',
  'references',
] as const

/** One directed Idea relation kind. */
export type IdeaRelationType = typeof IDEA_RELATION_TYPES[number]

/** Relation lifecycle; removal is supersession, never a hard delete. */
export type IdeaRelationStatus = 'active' | 'superseded' | 'rejected'

/** One Idea row as the Host API and tools expose it. */
export interface ResearchIdea {
  readonly id: IdeaId
  readonly title: string
  readonly description: string
  readonly researchQuestion: string
  readonly objectives: readonly string[]
  readonly status: IdeaStatus
  readonly parentIdeaId?: IdeaId
  readonly currentSummary: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt?: number
  readonly version: number
  readonly createdBy: string
  /** Reserved for Phase 2; Phase 1 never persists this field. */
  readonly workspacePath?: string
  /** Reserved for Phase 2; Phase 1 never persists this field. */
  readonly lastSessionId?: string
}

/** One directed relation between two Ideas. */
export interface ResearchIdeaRelation {
  readonly id: IdeaRelationId
  /** `related_to` is canonicalized to ascending id order. */
  readonly fromIdeaId: IdeaId
  readonly toIdeaId: IdeaId
  readonly relationType: IdeaRelationType
  readonly status: IdeaRelationStatus
  readonly note: string
  readonly groupId?: string
  readonly supersedesRelationId?: IdeaRelationId
  readonly createdBy: string
  readonly createdAt: number
}

/** One append-only timeline record for an Idea. */
export interface ResearchTimelineEvent {
  readonly id: TimelineEventId
  readonly ideaId: IdeaId
  readonly eventType: string
  readonly entityType?: string
  readonly entityId?: string
  readonly summary: string
  readonly payload: JsonValue
  readonly createdAt: number
}

/** Input accepted by `createIdea`. */
export interface CreateIdeaInput {
  readonly title: string
  readonly description?: string
  readonly researchQuestion?: string
  readonly objectives?: readonly string[]
  readonly status?: IdeaStatus
  readonly parentIdeaId?: IdeaId
  readonly currentSummary?: string
  readonly createdBy?: string
}

/** Mutable Idea fields; omitted fields keep their current value. */
export interface UpdateIdeaInput {
  readonly title?: string
  readonly description?: string
  readonly researchQuestion?: string
  readonly objectives?: readonly string[]
  readonly status?: IdeaStatus
  /** `null` clears the parent; an id reparents the Idea. */
  readonly parentIdeaId?: IdeaId | null
  readonly currentSummary?: string
}

/** Filter accepted by `listIdeas`. */
export interface ListIdeasFilter {
  readonly status?: IdeaStatus
  readonly includeArchived?: boolean
  readonly query?: string
  readonly parentIdeaId?: IdeaId
  readonly limit?: number
}

/** Input accepted by `addIdeaRelation`. */
export interface AddIdeaRelationInput {
  readonly fromIdeaId: IdeaId
  readonly toIdeaId: IdeaId
  readonly relationType: IdeaRelationType
  readonly note?: string
  readonly groupId?: string
  readonly createdBy?: string
}

/** Directional semantics of the four relation kinds. */
export const IDEA_RELATION_DIRECTIONS = {
  related_to: 'symmetric',
  derived_from: 'from_is_derived_to_is_source',
  merged_from: 'from_is_merged_result_to_is_source',
  references: 'from_references_to',
} as const satisfies Record<IdeaRelationType, string>

/**
 * Allowed lifecycle transitions, including deliberate rollback and archive
 * restoration. A same-state write is a no-op, not a transition.
 */
export const IDEA_STATUS_TRANSITIONS = {
  seed: ['exploring', 'archived'],
  exploring: ['seed', 'developing', 'archived'],
  developing: ['exploring', 'reviewing', 'archived'],
  reviewing: ['developing', 'mature', 'archived'],
  mature: ['developing', 'reviewing', 'archived'],
  archived: ['seed', 'exploring'],
} as const satisfies Record<IdeaStatus, readonly IdeaStatus[]>

/**
 * Test whether a status change is admitted by the Phase 1 state machine.
 * @param from - current state.
 * @param to - requested state.
 * @returns whether the transition is allowed, including same-state writes.
 */
export function canTransitionIdeaStatus(from: IdeaStatus, to: IdeaStatus): boolean {
  return from === to || (IDEA_STATUS_TRANSITIONS[from] as readonly IdeaStatus[]).includes(to)
}

/** Versions of the `research/changed` notification payload. */
export type ResearchChangedSchemaVersion = 1

/** One committed Idea or relation change, emitted after its transaction commits. */
export interface ResearchChangedEvent {
  readonly schemaVersion: ResearchChangedSchemaVersion
  readonly kind:
    | 'idea.created'
    | 'idea.updated'
    | 'idea.archived'
    | 'idea.relation-added'
    | 'idea.relation-removed'
  readonly ideaId: IdeaId
  readonly occurredAt: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A Research Idea or relation mutation committed. The database transaction
     * has already succeeded; listeners may refresh derived views. Listener
     * failures are contained by the emitter.
     * @mode emit
     * @param event - versioned change envelope naming the affected Idea.
     */
    'research/changed'(event: ResearchChangedEvent): void
  }
}
