/**
 * Phase 5.1 memory vocabulary. Memory is a derived, versioned layer over the
 * Research Database: epistemic standing and lifecycle state are separate, and
 * every memory row keeps its Session/entity provenance.
 * @module @deepseek-ai/dsh-research-core/memory-types
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { IdeaId } from './types.ts'

/** Stable identity of one Memory record. */
export type MemoryId = Branded<'MemoryId'>

/**
 * Admit a raw string as a Memory identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded Memory id.
 */
export function MemoryId(value: string): MemoryId {
  return brandString<MemoryId>(value)
}

/** Stable identity of one Memory source link. */
export type MemorySourceId = Branded<'MemorySourceId'>

/**
 * Admit a raw string as a Memory source identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded source id.
 */
export function MemorySourceId(value: string): MemorySourceId {
  return brandString<MemorySourceId>(value)
}

/** Stable identity of one Memory relation. */
export type MemoryRelationId = Branded<'MemoryRelationId'>

/**
 * Admit a raw string as a Memory relation identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded relation id.
 */
export function MemoryRelationId(value: string): MemoryRelationId {
  return brandString<MemoryRelationId>(value)
}

/** Stable identity of one Memory conflict. */
export type MemoryConflictId = Branded<'MemoryConflictId'>

/**
 * Admit a raw string as a Memory conflict identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded conflict id.
 */
export function MemoryConflictId(value: string): MemoryConflictId {
  return brandString<MemoryConflictId>(value)
}

/** Stable identity of one retrieval selection record. */
export type MemorySelectionId = Branded<'MemorySelectionId'>

/**
 * Admit a raw string as a Memory selection identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded selection id.
 */
export function MemorySelectionId(value: string): MemorySelectionId {
  return brandString<MemorySelectionId>(value)
}

/** Phase 5 memory kinds. */
export const MEMORY_TYPES = [
  'goal', 'fact', 'finding', 'hypothesis', 'decision', 'constraint',
  'failure', 'open_question', 'strategy', 'preference',
] as const

/** One memory kind. */
export type MemoryType = typeof MEMORY_TYPES[number]

/** Epistemic standing; independent of lifecycle. */
export const MEMORY_EPISTEMIC_STATUSES = [
  'verified', 'supported', 'inferred', 'unverified', 'disputed', 'refuted',
] as const

/** One epistemic standing. */
export type MemoryEpistemicStatus = typeof MEMORY_EPISTEMIC_STATUSES[number]

/** Memory lifecycle; independent of epistemic standing. */
export const MEMORY_LIFECYCLE_STATUSES = ['candidate', 'active', 'superseded', 'rejected', 'archived'] as const

/** One memory lifecycle state. */
export type MemoryLifecycleStatus = typeof MEMORY_LIFECYCLE_STATUSES[number]

/** Who changed a memory version. */
export const MEMORY_CHANGE_SOURCES = ['extractor', 'user', 'agent', 'system', 'review'] as const
/** One memory change source. */
export type MemoryChangeSource = typeof MEMORY_CHANGE_SOURCES[number]

/** Memory relation kinds. */
export const MEMORY_RELATION_TYPES = [
  'about', 'derived_from', 'supports', 'refutes', 'supersedes', 'related', 'conflicts_with',
] as const
/** One memory relation kind. */
export type MemoryRelationType = typeof MEMORY_RELATION_TYPES[number]

/** Entity kinds a memory source/relation may name. */
export const MEMORY_ENTITY_TYPES = [
  'source', 'concept', 'claim', 'evidence', 'question', 'gap', 'hypothesis',
  'discovery', 'decision', 'artifact', 'session_summary', 'memory',
] as const
/** One entity kind. */
export type MemoryEntityType = typeof MEMORY_ENTITY_TYPES[number]

/** Conflict kinds. */
export const MEMORY_CONFLICT_TYPES = ['contradiction', 'condition_mismatch', 'possible_duplicate', 'superseded'] as const
/** One conflict kind. */
export type MemoryConflictType = typeof MEMORY_CONFLICT_TYPES[number]

/** Conflict review state. */
export type MemoryConflictStatus = 'open' | 'resolved' | 'dismissed'

/** Retrieval layer recorded for an injected memory. */
export type MemorySelectionLayer = 'core' | 'relevant' | 'historical'

/** One provenance link attached to a memory. */
export interface MemorySource {
  readonly id: MemorySourceId
  readonly memoryId: MemoryId
  readonly sessionId?: string
  readonly eventSeq?: number
  readonly entityType?: MemoryEntityType
  readonly entityId?: string
  readonly sourceId?: string
  readonly locationId?: string
  readonly quote: string
  readonly summaryId?: string
  readonly summaryVersion?: number
  readonly extractionJobId?: string
  readonly entityVersion?: number
  readonly sourceRole: 'direct' | 'supporting' | 'contradicting' | 'inferred'
  readonly createdAt: number
}

/** One relation from a memory to another memory or research entity. */
export interface MemoryRelation {
  readonly id: MemoryRelationId
  readonly memoryId: MemoryId
  readonly entityType: MemoryEntityType
  readonly entityId: string
  readonly relationType: MemoryRelationType
  readonly note: string
  readonly createdAt: number
}

/** One immutable memory version snapshot. */
export interface MemoryVersion {
  readonly id: string
  readonly memoryId: MemoryId
  readonly version: number
  readonly snapshot: JsonValue
  readonly changeReason: string
  readonly changeSource: MemoryChangeSource
  readonly createdBy: string
  readonly sourceSessionId?: string
  readonly sourceEventSeq?: number
  readonly createdAt: number
}

/** One Memory row. */
export interface ResearchMemory {
  readonly id: MemoryId
  readonly ideaId: IdeaId
  readonly memoryType: MemoryType
  readonly title: string
  readonly content: string
  readonly structured: JsonValue
  readonly epistemicStatus: MemoryEpistemicStatus
  readonly lifecycleStatus: MemoryLifecycleStatus
  readonly confidence: number
  readonly sourceSessionId?: string
  readonly sourceEventSeqs: readonly number[]
  readonly sourceIds: readonly string[]
  readonly originToolCallId?: string
  readonly contentHash: string
  readonly version: number
  readonly supersedesId?: MemoryId
  readonly promotedAt?: number
  readonly archivedAt?: number
  readonly lastUsedAt?: number
  readonly useCount: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly sources: readonly MemorySource[]
  readonly relations: readonly MemoryRelation[]
}

/** One conflict between two memories in the same Idea. */
export interface MemoryConflict {
  readonly id: MemoryConflictId
  readonly ideaId: IdeaId
  readonly memoryAId: MemoryId
  readonly memoryBId: MemoryId
  readonly conflictType: MemoryConflictType
  readonly description: string
  readonly status: MemoryConflictStatus
  readonly resolution: string
  readonly detectedBy: string
  readonly resolvedAt?: number
  readonly createdAt: number
}

/** One recorded retrieval selection for audit and budget reconstruction. */
export interface MemorySelection {
  readonly id: MemorySelectionId
  readonly sessionId: string
  readonly ideaId: IdeaId
  readonly turn: number
  readonly step: number
  readonly memoryId: MemoryId
  readonly rank: number
  readonly layer: MemorySelectionLayer
  readonly reason: string
  readonly tokenEstimate: number
  readonly memoryVersion: number
  readonly retrievalScore: number
  readonly injectionStatus: 'selected' | 'injected' | 'failed'
  readonly injectionLocation: 'system-prompt' | 'agent-pre-step' | 'unknown'
  readonly createdAt: number
}

/** One source supplied when creating or updating a memory. */
export interface MemorySourceInput {
  readonly sessionId?: string
  readonly eventSeq?: number
  readonly entityType?: MemoryEntityType
  readonly entityId?: string
  readonly sourceId?: string
  readonly locationId?: string
  readonly quote?: string
  readonly summaryId?: string
  readonly summaryVersion?: number
  readonly extractionJobId?: string
  readonly entityVersion?: number
  readonly sourceRole?: 'direct' | 'supporting' | 'contradicting' | 'inferred'
}

/** One relation supplied when creating or updating a memory. */
export interface MemoryRelationInput {
  readonly entityType: MemoryEntityType
  readonly entityId: string
  readonly relationType: MemoryRelationType
  readonly note?: string
}

/** Input accepted by `createMemory`. */
export interface CreateMemoryInput {
  readonly ideaId: IdeaId
  readonly memoryType: MemoryType
  readonly title: string
  readonly content: string
  readonly structured?: JsonValue
  readonly epistemicStatus?: MemoryEpistemicStatus
  readonly lifecycleStatus?: MemoryLifecycleStatus
  readonly confidence?: number
  readonly sourceSessionId?: string
  readonly sourceEventSeqs?: readonly number[]
  readonly sourceIds?: readonly string[]
  readonly originToolCallId?: string
  readonly supersedesId?: MemoryId
  readonly sources?: readonly MemorySourceInput[]
  readonly relations?: readonly MemoryRelationInput[]
}

/** Fields accepted by `updateMemory`. */
export interface UpdateMemoryInput {
  readonly title?: string
  readonly content?: string
  readonly structured?: JsonValue
  readonly epistemicStatus?: MemoryEpistemicStatus
  readonly lifecycleStatus?: MemoryLifecycleStatus
  readonly confidence?: number
  readonly sourceSessionId?: string
  readonly sourceEventSeqs?: readonly number[]
  readonly sourceIds?: readonly string[]
  readonly sources?: readonly MemorySourceInput[]
  readonly relations?: readonly MemoryRelationInput[]
}

/** Audit metadata required by every memory update. */
export interface MemoryChangeContext {
  readonly changeReason: string
  readonly changeSource: MemoryChangeSource
  readonly createdBy: string
  readonly sourceSessionId?: string
  readonly sourceEventSeq?: number
}

/** Filters accepted by `listMemories`. */
export interface MemoryFilters {
  readonly memoryType?: MemoryType
  readonly epistemicStatus?: MemoryEpistemicStatus
  readonly lifecycleStatus?: MemoryLifecycleStatus
  readonly limit?: number
}

/** Input accepted by `createMemoryConflict`. */
export interface CreateMemoryConflictInput {
  readonly ideaId: IdeaId
  readonly memoryAId: MemoryId
  readonly memoryBId: MemoryId
  readonly conflictType: MemoryConflictType
  readonly description: string
  readonly detectedBy: string
}

/** Input accepted by `recordMemorySelection`. */
export interface RecordMemorySelectionInput {
  readonly sessionId: string
  readonly ideaId: IdeaId
  readonly turn: number
  readonly step: number
  readonly memoryId: MemoryId
  readonly rank: number
  readonly layer: MemorySelectionLayer
  readonly reason: string
  readonly tokenEstimate: number
  readonly memoryVersion?: number
  readonly retrievalScore?: number
  readonly injectionStatus?: 'selected' | 'injected' | 'failed'
  readonly injectionLocation?: 'system-prompt' | 'agent-pre-step' | 'unknown'
}

/** One FTS/LIKE memory hit. */
export interface MemorySearchHit {
  readonly memory: ResearchMemory
  readonly textRelevance: number
}

/** Search filters for memory retrieval. */
export interface MemorySearchOptions {
  readonly memoryTypes?: readonly MemoryType[]
  readonly lifecycleStatuses?: readonly MemoryLifecycleStatus[]
  readonly limit?: number
}

/** Counts used by the Memory workspace. */
export interface MemoryCounts {
  readonly total: number
  readonly byLifecycle: Readonly<Record<MemoryLifecycleStatus, number>>
  readonly byType: Readonly<Record<MemoryType, number>>
}
