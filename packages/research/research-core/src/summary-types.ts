/**
 * Phase 5.2 structured Session Summary vocabulary. A summary is a Session-level
 * research record; canonical Claims, Evidence, and Hypotheses stay in the
 * Research Database and are referenced by id.
 * @module @deepseek-ai/dsh-research-core/summary-types
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { IdeaId } from './types.ts'

/** Summary generation state. */
export const SUMMARY_GENERATION_STATUSES = ['pending', 'generating', 'completed', 'failed', 'skipped'] as const
/** One summary generation state. */
export type SummaryGenerationStatus = typeof SUMMARY_GENERATION_STATUSES[number]

/** Lifecycle state of a stored summary row. */
export type SummaryRecordStatus = 'candidate' | 'reviewed' | 'superseded' | 'rejected'

/** One traceable reference from a summary to a Research entity. */
export interface SummaryReference {
  readonly entityType: string
  readonly entityId: string
  readonly label: string
  readonly version?: number
}

/** Deterministic structured summary produced from Session events and the Research DB. */
export interface StructuredSessionSummary {
  readonly objective: string
  readonly keyFindings: readonly SummaryReference[]
  readonly hypothesesCreated: readonly SummaryReference[]
  readonly hypothesesValidated: readonly SummaryReference[]
  readonly hypothesesRejected: readonly SummaryReference[]
  readonly decisions: readonly SummaryReference[]
  readonly failedAttempts: readonly SummaryReference[]
  readonly unresolvedQuestions: readonly SummaryReference[]
  readonly generatedArtifacts: readonly SummaryReference[]
  readonly nextSteps: readonly string[]
  readonly sourceReferences: readonly SummaryReference[]
}

/** One persisted structured Session Summary. */
export interface ResearchSessionSummary extends StructuredSessionSummary {
  readonly id: string
  readonly sessionId: string
  readonly ideaId?: IdeaId
  readonly summary: string
  readonly eventStartSeq: number
  readonly eventEndSeq: number
  readonly inputHash: string
  readonly generationVersion: number
  readonly status: SummaryRecordStatus
  readonly generationStatus: SummaryGenerationStatus
  readonly generationError?: string
  readonly idempotencyKey?: string
  readonly supersedesId?: string
  readonly modelProvider?: string
  readonly modelId?: string
  readonly promptVersion: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Input accepted by `insertSummary`. */
export interface InsertSummaryInput extends StructuredSessionSummary {
  readonly sessionId: string
  readonly ideaId?: IdeaId
  readonly summary: string
  readonly eventStartSeq: number
  readonly eventEndSeq: number
  readonly inputHash: string
  readonly idempotencyKey: string
  readonly generationStatus?: SummaryGenerationStatus
  readonly generationError?: string
  readonly modelProvider?: string
  readonly modelId?: string
  readonly promptVersion: string
}

/** One summary list entry with the stored narrative and metadata. */
export interface SummaryListFilter {
  readonly ideaId?: IdeaId
  readonly sessionId?: string
  readonly limit?: number
}

/** Summary JSON columns ready for persistence. */
export type SummaryJson = JsonValue

/**
 * Stable idempotency key for one Session summary range.
 * @param sessionId - Session identity.
 * @param startSeq - inclusive event start.
 * @param endSeq - inclusive event end.
 * @returns the outbox and summary idempotency key.
 */
export function summaryIdempotencyKey(sessionId: string, startSeq: number, endSeq: number): string {
  return `session-summary:${sessionId}:${startSeq}:${endSeq}`
}

/** Outbox topic used for one completed Session summary extraction. */
export const SESSION_MEMORY_EXTRACTION_TOPIC = 'research/session-memory-extraction'

/**
 * Stable extraction idempotency key for one Summary version.
 * @param summaryId - summary row identity.
 * @param version - summary generation version.
 * @returns the outbox idempotency key.
 */
export function extractionIdempotencyKey(summaryId: string, version: number): string {
  return `session-memory-extraction:${summaryId}:${version}`
}
