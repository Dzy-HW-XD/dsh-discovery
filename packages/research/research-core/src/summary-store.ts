/**
 * Persistence for structured Session Summaries. The table remains the Phase 3
 * `research_session_summaries` table; migration v5 adds structured columns and
 * an idempotency key. Historical rows are superseded, never deleted.
 * @module @deepseek-ai/dsh-research-core/summary-store
 */

import { randomUUID } from 'node:crypto'
import type { ResearchDatabase } from './database.ts'
import { ResearchError } from './errors.ts'
import { integer, json, optionalInteger, optionalText, text, type SqlRow } from './rows.ts'
import {
  type InsertSummaryInput,
  type ResearchSessionSummary,
  type SummaryGenerationStatus,
  type SummaryListFilter,
  type SummaryRecordStatus,
  type SummaryReference,
} from './summary-types.ts'
import { IdeaId } from './types.ts'

function mapReference(value: unknown): SummaryReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ResearchError('research/database-unavailable', 'summary reference is not an object', {})
  }
  const record = value as Record<string, unknown>
  if (typeof record['entityType'] !== 'string' || typeof record['entityId'] !== 'string'
    || typeof record['label'] !== 'string') {
    throw new ResearchError('research/database-unavailable', 'summary reference is incomplete', {})
  }
  return {
    entityType: record['entityType'],
    entityId: record['entityId'],
    label: record['label'],
    ...typeof record['version'] === 'number' ? { version: record['version'] } : {},
  }
}

function references(row: SqlRow, column: string): SummaryReference[] {
  return (json(row, column) as unknown[]).map(mapReference)
}

function mapSummary(row: SqlRow): ResearchSessionSummary {
  const ideaId = optionalText(row, 'idea_id')
  const generationError = optionalText(row, 'generation_error')
  const idempotencyKey = optionalText(row, 'idempotency_key')
  const supersedesId = optionalText(row, 'supersedes_id')
  const modelProvider = optionalText(row, 'model_provider')
  const modelId = optionalText(row, 'model_id')
  const updatedAt = optionalInteger(row, 'updated_at') ?? integer(row, 'created_at')
  return {
    id: text(row, 'id'),
    sessionId: text(row, 'session_id'),
    ...ideaId === undefined ? {} : { ideaId: IdeaId(ideaId) },
    summary: text(row, 'summary'),
    objective: text(row, 'objective'),
    keyFindings: references(row, 'key_findings_json'),
    hypothesesCreated: references(row, 'hypotheses_created_json'),
    hypothesesValidated: references(row, 'hypotheses_validated_json'),
    hypothesesRejected: references(row, 'hypotheses_rejected_json'),
    decisions: references(row, 'decisions_json'),
    failedAttempts: references(row, 'failed_attempts_json'),
    unresolvedQuestions: references(row, 'unresolved_questions_json'),
    generatedArtifacts: references(row, 'generated_artifacts_json'),
    nextSteps: json(row, 'next_steps_json') as string[],
    sourceReferences: references(row, 'source_references_json'),
    eventStartSeq: integer(row, 'event_start_seq'),
    eventEndSeq: integer(row, 'event_end_seq'),
    inputHash: text(row, 'input_hash'),
    generationVersion: integer(row, 'version'),
    status: text(row, 'status') as SummaryRecordStatus,
    generationStatus: text(row, 'generation_status') as SummaryGenerationStatus,
    ...generationError === undefined ? {} : { generationError },
    ...idempotencyKey === undefined ? {} : { idempotencyKey },
    ...supersedesId === undefined ? {} : { supersedesId },
    ...modelProvider === undefined ? {} : { modelProvider },
    ...modelId === undefined ? {} : { modelId },
    promptVersion: text(row, 'prompt_version'),
    createdAt: integer(row, 'created_at'),
    updatedAt,
  }
}

/** Durable Session Summary repository. */
export class ResearchSummaryStore {
  /**
   * @param database - open research database.
   */
  constructor(private readonly database: ResearchDatabase) {}

  /**
   * Find a summary by its idempotency key.
   * @param key - stable generation key.
   * @returns the summary, or undefined.
   */
  findByIdempotencyKey(key: string): ResearchSessionSummary | undefined {
    const row = this.database.connection.prepare(
      'SELECT * FROM research_session_summaries WHERE idempotency_key = ?',
    ).get(key)
    return row === undefined ? undefined : mapSummary(row)
  }

  /**
   * Read one summary by id.
   * @param id - summary identity.
   * @returns the summary, or undefined.
   */
  get(id: string): ResearchSessionSummary | undefined {
    const row = this.database.connection.prepare('SELECT * FROM research_session_summaries WHERE id = ?').get(id)
    return row === undefined ? undefined : mapSummary(row)
  }

  /**
   * List summaries newest-first.
   * @param filter - optional Idea, Session, and limit filters.
   * @returns summaries in creation order.
   */
  list(filter: SummaryListFilter = {}): ResearchSessionSummary[] {
    const clauses: string[] = []
    const values: (string | number)[] = []
    if (filter.ideaId !== undefined) { clauses.push('idea_id = ?'); values.push(filter.ideaId) }
    if (filter.sessionId !== undefined) { clauses.push('session_id = ?'); values.push(filter.sessionId) }
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500))
    values.push(limit)
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    return this.database.connection.prepare(`
      SELECT * FROM research_session_summaries ${where} ORDER BY created_at DESC LIMIT ?
    `).all(...values).map(mapSummary)
  }

  /**
   * Insert one completed summary, superseding the previous latest row for the
   * Session. The idempotency key makes repeated generation a no-op.
   * @param input - structured summary and generation metadata.
   * @returns the existing or new summary.
   */
  insert(input: InsertSummaryInput): ResearchSessionSummary {
    const existing = this.findByIdempotencyKey(input.idempotencyKey)
    if (existing !== undefined) return existing
    if (input.eventEndSeq < input.eventStartSeq) {
      throw new ResearchError('research/invalid-input', 'summary event range is inverted', {
        start: input.eventStartSeq, end: input.eventEndSeq,
      })
    }
    const session = this.database.connection.prepare(
      'SELECT session_id, idea_id FROM research_sessions WHERE session_id = ?',
    ).get(input.sessionId)
    if (session === undefined) {
      throw new ResearchError('research/session-not-found', `Session "${input.sessionId}" not found`, { sessionId: input.sessionId })
    }
    if (input.ideaId !== undefined && optionalText(session, 'idea_id') !== input.ideaId) {
      throw new ResearchError('research/invalid-input', 'summary Idea does not own the Session', { sessionId: input.sessionId })
    }
    const previous = this.database.connection.prepare(`
      SELECT id FROM research_session_summaries
      WHERE session_id = ? AND status <> 'superseded'
      ORDER BY created_at DESC, version DESC LIMIT 1
    `).get(input.sessionId)
    const supersedes = previous === undefined ? undefined : text(previous, 'id')
    const versionRow = this.database.connection.prepare(
      'SELECT MAX(version) AS version FROM research_session_summaries WHERE session_id = ?',
    ).get(input.sessionId) as SqlRow
    const version = (optionalInteger(versionRow, 'version') ?? 0) + 1
    const id = `sum_${randomUUID()}`
    const now = Date.now()
    this.database.transaction(() => {
      if (supersedes !== undefined) {
        this.database.connection.prepare(
          "UPDATE research_session_summaries SET status = 'superseded', updated_at = ? WHERE id = ?",
        ).run(now, supersedes)
      }
      this.database.connection.prepare(`
        INSERT INTO research_session_summaries (
          id, session_id, idea_id, summary, open_questions_json, hypotheses_json, artifacts_json,
          event_start_seq, event_end_seq, input_hash, version, status, supersedes_id,
          model_provider, model_id, prompt_version, created_at, updated_at,
          objective, key_findings_json, hypotheses_created_json, hypotheses_validated_json,
          hypotheses_rejected_json, decisions_json, failed_attempts_json, next_steps_json,
          generated_artifacts_json, source_references_json, generation_status, generation_error,
          idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.sessionId, input.ideaId ?? null, input.summary,
        JSON.stringify(input.unresolvedQuestions), JSON.stringify(input.hypothesesCreated),
        JSON.stringify(input.generatedArtifacts), input.eventStartSeq, input.eventEndSeq,
        input.inputHash, version, supersedes ?? null, input.modelProvider ?? null,
        input.modelId ?? null, input.promptVersion, now, now, input.objective,
        JSON.stringify(input.keyFindings), JSON.stringify(input.hypothesesCreated),
        JSON.stringify(input.hypothesesValidated), JSON.stringify(input.hypothesesRejected),
        JSON.stringify(input.decisions), JSON.stringify(input.failedAttempts),
        JSON.stringify(input.nextSteps), JSON.stringify(input.generatedArtifacts),
        JSON.stringify(input.sourceReferences), input.generationStatus ?? 'completed',
        input.generationError ?? null, input.idempotencyKey)
    })
    return this.get(id) as ResearchSessionSummary
  }
}
