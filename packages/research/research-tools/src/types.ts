/**
 * Wire-safe Phase 1 research values. Strings cross the Remote boundary; the
 * Host controller brands them before calling the domain service.
 * @module @deepseek-ai/dsh-research-tools/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** One Idea as the browser and tools read it. */
export interface IdeaView {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly researchQuestion: string
  readonly objectives: readonly string[]
  readonly status: string
  readonly parentIdeaId?: string
  readonly currentSummary: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt?: number
  readonly version: number
  readonly createdBy: string
}

/** One directed Idea relation as the browser and tools read it. */
export interface IdeaRelationView {
  readonly id: string
  readonly fromIdeaId: string
  readonly toIdeaId: string
  readonly relationType: string
  readonly status: string
  readonly note: string
  readonly groupId?: string
  readonly supersedesRelationId?: string
  readonly createdBy: string
  readonly createdAt: number
}

/** One Idea timeline event. */
export interface TimelineEventView {
  readonly id: string
  readonly ideaId: string
  readonly eventType: string
  readonly entityType?: string
  readonly entityId?: string
  readonly summary: string
  readonly payload: JsonValue
  readonly createdAt: number
}

/** List request; every field is optional. */
export interface ListIdeasRequest {
  readonly status?: string
  readonly includeArchived?: boolean
  readonly query?: string
  readonly parentIdeaId?: string
  readonly limit?: number
}

/** One-Idea lookup. */
export interface GetIdeaRequest {
  readonly ideaId: string
}

/** Create request. */
export interface CreateIdeaRequest {
  readonly title: string
  readonly description?: string
  readonly researchQuestion?: string
  readonly objectives?: readonly string[]
  readonly status?: string
  readonly parentIdeaId?: string
  readonly currentSummary?: string
}

/** Update request with optimistic concurrency. */
export interface UpdateIdeaRequest {
  readonly ideaId: string
  readonly expectedVersion: number
  readonly title?: string
  readonly description?: string
  readonly researchQuestion?: string
  readonly objectives?: readonly string[]
  readonly status?: string
  readonly parentIdeaId?: string | null
  readonly currentSummary?: string
}

/** Archive request with optimistic concurrency. */
export interface ArchiveIdeaRequest {
  readonly ideaId: string
  readonly expectedVersion: number
  readonly reason?: string
}

/** Add one directed relation. */
export interface AddIdeaRelationRequest {
  readonly fromIdeaId: string
  readonly toIdeaId: string
  readonly relationType: string
  readonly note?: string
  readonly groupId?: string
}

/** Remove (supersede) one relation. */
export interface RemoveIdeaRelationRequest {
  readonly relationId: string
}

/** List relations touching one Idea. */
export interface ListIdeaRelationsRequest {
  readonly ideaId: string
}

/** Read one Idea timeline. */
export interface TimelineRequest {
  readonly ideaId: string
  readonly limit?: number
}

