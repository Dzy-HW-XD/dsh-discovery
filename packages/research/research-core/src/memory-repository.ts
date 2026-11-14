/**
 * Low-level SQL for the Phase 5.1 memory store. This repository performs no
 * domain validation; `ResearchMemoryStore` owns transactions, provenance
 * checks, lifecycle rules, and timeline writes.
 * @module @deepseek-ai/dsh-research-core/memory-repository
 */

import type { ResearchDatabase } from './database.ts'
import { integer, json, optionalInteger, optionalText, real, text, type SqlRow } from './rows.ts'
import {
  MemoryConflictId,
  MemoryId,
  MemoryRelationId,
  MemorySelectionId,
  MemorySourceId,
  type CreateMemoryInput,
  type MemoryChangeContext,
  type MemoryConflict,
  type MemoryConflictStatus,
  type MemoryFilters,
  type MemoryLifecycleStatus,
  type MemoryRelation,
  type MemorySelection,
  type MemorySource,
  type MemoryType,
  type MemoryVersion,
  type RecordMemorySelectionInput,
  type ResearchMemory,
  type UpdateMemoryInput,
} from './memory-types.ts'
import { IdeaId } from './types.ts'

function mapMemory(row: SqlRow): ResearchMemory {
  const sourceSessionId = optionalText(row, 'source_session_id')
  const originToolCallId = optionalText(row, 'origin_tool_call_id')
  const supersedesId = optionalText(row, 'supersedes_id')
  const promotedAt = optionalInteger(row, 'promoted_at')
  const archivedAt = optionalInteger(row, 'archived_at')
  const lastUsedAt = optionalInteger(row, 'last_used_at')
  return {
    id: MemoryId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    memoryType: text(row, 'memory_type') as ResearchMemory['memoryType'],
    title: text(row, 'title'),
    content: text(row, 'content'),
    structured: json(row, 'structured_json'),
    epistemicStatus: text(row, 'epistemic_status') as ResearchMemory['epistemicStatus'],
    lifecycleStatus: text(row, 'lifecycle_status') as MemoryLifecycleStatus,
    confidence: real(row, 'confidence'),
    ...sourceSessionId === undefined ? {} : { sourceSessionId },
    sourceEventSeqs: json(row, 'source_event_seqs_json') as number[],
    sourceIds: json(row, 'source_ids_json') as string[],
    ...originToolCallId === undefined ? {} : { originToolCallId },
    contentHash: text(row, 'content_hash'),
    version: integer(row, 'version'),
    ...supersedesId === undefined ? {} : { supersedesId: MemoryId(supersedesId) },
    ...promotedAt === undefined ? {} : { promotedAt },
    ...archivedAt === undefined ? {} : { archivedAt },
    ...lastUsedAt === undefined ? {} : { lastUsedAt },
    useCount: integer(row, 'use_count'),
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    sources: [],
    relations: [],
  }
}

function mapSource(row: SqlRow): MemorySource {
  const sessionId = optionalText(row, 'session_id')
  const eventSeq = optionalInteger(row, 'event_seq')
  const entityType = optionalText(row, 'entity_type')
  const entityId = optionalText(row, 'entity_id')
  const sourceId = optionalText(row, 'source_id')
  const locationId = optionalText(row, 'location_id')
  return {
    id: MemorySourceId(text(row, 'id')),
    memoryId: MemoryId(text(row, 'memory_id')),
    ...sessionId === undefined ? {} : { sessionId },
    ...eventSeq === undefined ? {} : { eventSeq },
    ...entityType === undefined ? {} : { entityType: entityType as NonNullable<MemorySource['entityType']> },
    ...entityId === undefined ? {} : { entityId },
    ...sourceId === undefined ? {} : { sourceId },
    ...locationId === undefined ? {} : { locationId },
    quote: text(row, 'quote'),
    createdAt: integer(row, 'created_at'),
  }
}

function mapRelation(row: SqlRow): MemoryRelation {
  return {
    id: MemoryRelationId(text(row, 'id')),
    memoryId: MemoryId(text(row, 'memory_id')),
    entityType: text(row, 'entity_type') as MemoryRelation['entityType'],
    entityId: text(row, 'entity_id'),
    relationType: text(row, 'relation_type') as MemoryRelation['relationType'],
    note: text(row, 'note'),
    createdAt: integer(row, 'created_at'),
  }
}

function mapVersion(row: SqlRow): MemoryVersion {
  const sessionId = optionalText(row, 'source_session_id')
  const eventSeq = optionalInteger(row, 'source_event_seq')
  return {
    id: text(row, 'id'),
    memoryId: MemoryId(text(row, 'memory_id')),
    version: integer(row, 'version'),
    snapshot: json(row, 'snapshot_json'),
    changeReason: text(row, 'change_reason'),
    changeSource: text(row, 'change_source') as MemoryVersion['changeSource'],
    createdBy: text(row, 'created_by'),
    ...sessionId === undefined ? {} : { sourceSessionId: sessionId },
    ...eventSeq === undefined ? {} : { sourceEventSeq: eventSeq },
    createdAt: integer(row, 'created_at'),
  }
}

function mapConflict(row: SqlRow): MemoryConflict {
  const resolvedAt = optionalInteger(row, 'resolved_at')
  return {
    id: MemoryConflictId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    memoryAId: MemoryId(text(row, 'memory_a_id')),
    memoryBId: MemoryId(text(row, 'memory_b_id')),
    conflictType: text(row, 'conflict_type') as MemoryConflict['conflictType'],
    description: text(row, 'description'),
    status: text(row, 'status') as MemoryConflictStatus,
    resolution: text(row, 'resolution'),
    detectedBy: text(row, 'detected_by'),
    ...resolvedAt === undefined ? {} : { resolvedAt },
    createdAt: integer(row, 'created_at'),
  }
}

function mapSelection(row: SqlRow): MemorySelection {
  return {
    id: MemorySelectionId(text(row, 'id')),
    sessionId: text(row, 'session_id'),
    ideaId: IdeaId(text(row, 'idea_id')),
    turn: integer(row, 'turn'),
    step: integer(row, 'step'),
    memoryId: MemoryId(text(row, 'memory_id')),
    rank: integer(row, 'rank'),
    layer: text(row, 'layer') as MemorySelection['layer'],
    reason: text(row, 'reason'),
    tokenEstimate: integer(row, 'token_estimate'),
    createdAt: integer(row, 'created_at'),
  }
}

/** SQL-only persistence for memory records and their supporting rows. */
export class ResearchMemoryRepository {
  /**
   * @param database - open research database.
   */
  constructor(private readonly database: ResearchDatabase) {}

  /**
   * Read one memory row without relation/source hydration.
   * @param memoryId - memory identity.
   * @returns the row, or undefined.
   */
  getRow(memoryId: string): ResearchMemory | undefined {
    const row = this.database.connection.prepare('SELECT * FROM research_memory_records WHERE id = ?').get(memoryId)
    return row === undefined ? undefined : mapMemory(row)
  }

  /**
   * Read one memory only when it belongs to the Idea.
   * @param ideaId - owning Idea.
   * @param memoryId - memory identity.
   * @returns the row, or undefined when missing or owned elsewhere.
   */
  get(ideaId: string, memoryId: string): ResearchMemory | undefined {
    const row = this.database.connection.prepare(
      'SELECT * FROM research_memory_records WHERE idea_id = ? AND id = ?',
    ).get(ideaId, memoryId)
    return row === undefined ? undefined : mapMemory(row)
  }

  /**
   * Find a memory by its exact deduplication identity.
   * @param ideaId - owning Idea.
   * @param memoryType - memory kind.
   * @param contentHash - normalized content hash.
   * @returns the row, or undefined.
   */
  findByHash(ideaId: string, memoryType: MemoryType, contentHash: string): ResearchMemory | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM research_memory_records
      WHERE idea_id = ? AND memory_type = ? AND content_hash = ?
    `).get(ideaId, memoryType, contentHash)
    return row === undefined ? undefined : mapMemory(row)
  }

  /**
   * List memories with optional filters.
   * @param ideaId - owning Idea.
   * @param filters - type/status filters and limit.
   * @returns newest-first rows.
   */
  list(ideaId: string, filters: MemoryFilters = {}): ResearchMemory[] {
    const clauses = ['idea_id = ?']
    const values: (string | number)[] = [ideaId]
    if (filters.memoryType !== undefined) { clauses.push('memory_type = ?'); values.push(filters.memoryType) }
    if (filters.epistemicStatus !== undefined) { clauses.push('epistemic_status = ?'); values.push(filters.epistemicStatus) }
    if (filters.lifecycleStatus !== undefined) { clauses.push('lifecycle_status = ?'); values.push(filters.lifecycleStatus) }
    const limit = Math.max(1, Math.min(filters.limit ?? 200, 500))
    values.push(limit)
    return this.database.connection.prepare(`
      SELECT * FROM research_memory_records WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC, id ASC LIMIT ?
    `).all(...values).map(mapMemory)
  }

  /**
   * Count memories for one Idea.
   * @param ideaId - owning Idea.
   * @returns total, lifecycle counts, and type counts.
   */
  counts(ideaId: string): { total: number; byLifecycle: Record<string, number>; byType: Record<string, number> } {
    const totalRow = this.database.connection.prepare(
      'SELECT COUNT(*) AS count FROM research_memory_records WHERE idea_id = ?',
    ).get(ideaId) as SqlRow
    const lifecycleRows = this.database.connection.prepare(`
      SELECT lifecycle_status, COUNT(*) AS count FROM research_memory_records
      WHERE idea_id = ? GROUP BY lifecycle_status
    `).all(ideaId) as SqlRow[]
    const typeRows = this.database.connection.prepare(`
      SELECT memory_type, COUNT(*) AS count FROM research_memory_records
      WHERE idea_id = ? GROUP BY memory_type
    `).all(ideaId) as SqlRow[]
    const byLifecycle: Record<string, number> = {}
    for (const row of lifecycleRows) byLifecycle[text(row, 'lifecycle_status')] = integer(row, 'count')
    const byType: Record<string, number> = {}
    for (const row of typeRows) byType[text(row, 'memory_type')] = integer(row, 'count')
    return { total: integer(totalRow, 'count'), byLifecycle, byType }
  }

  /**
   * Insert one memory row.
   * @param id - pre-minted memory id.
   * @param input - validated create input.
   * @param contentHash - normalized content hash.
   * @param now - creation timestamp.
   */
  insert(id: string, input: CreateMemoryInput, contentHash: string, now: number): void {
    this.database.connection.prepare(`
      INSERT INTO research_memory_records (
        id, idea_id, memory_type, title, content, structured_json, epistemic_status,
        lifecycle_status, confidence, source_session_id, source_event_seqs_json,
        source_ids_json, origin_tool_call_id, content_hash, version, supersedes_id,
        promoted_at, archived_at, last_used_at, use_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, 0, ?, ?)
    `).run(id, input.ideaId, input.memoryType, input.title, input.content,
      JSON.stringify(input.structured ?? {}), input.epistemicStatus ?? 'inferred',
      input.lifecycleStatus ?? 'candidate', input.confidence ?? 0.5,
      input.sourceSessionId ?? null, JSON.stringify(input.sourceEventSeqs ?? []),
      JSON.stringify(input.sourceIds ?? []), input.originToolCallId ?? null, contentHash,
      input.supersedesId ?? null,
      (input.lifecycleStatus ?? 'candidate') === 'active' ? now : null,
      (input.lifecycleStatus ?? 'candidate') === 'archived' ? now : null, now, now)
  }

  /**
   * Update one memory row after service validation.
   * @param id - memory identity.
   * @param patch - validated patch.
   * @param contentHash - normalized content hash.
   * @param now - update timestamp.
   */
  update(id: string, patch: UpdateMemoryInput, contentHash: string, now: number): void {
    const current = this.getRow(id)
    if (current === undefined) throw new Error(`memory "${id}" disappeared`)
    const lifecycle = patch.lifecycleStatus ?? current.lifecycleStatus
    this.database.connection.prepare(`
      UPDATE research_memory_records
      SET title = ?, content = ?, structured_json = ?, epistemic_status = ?,
          lifecycle_status = ?, confidence = ?, source_session_id = ?,
          source_event_seqs_json = ?, source_ids_json = ?, content_hash = ?,
          version = version + 1, promoted_at = ?, archived_at = ?, updated_at = ?
      WHERE id = ?
    `).run(patch.title ?? current.title, patch.content ?? current.content,
      JSON.stringify(patch.structured ?? current.structured),
      patch.epistemicStatus ?? current.epistemicStatus, lifecycle,
      patch.confidence ?? current.confidence, patch.sourceSessionId ?? current.sourceSessionId ?? null,
      JSON.stringify(patch.sourceEventSeqs ?? current.sourceEventSeqs),
      JSON.stringify(patch.sourceIds ?? current.sourceIds), contentHash,
      lifecycle === 'active' ? (current.promotedAt ?? now) : current.promotedAt ?? null,
      lifecycle === 'archived' ? (current.archivedAt ?? now) : null, now, id)
  }

  /**
   * Mark one memory as used by retrieval.
   * @param id - memory identity.
   * @param now - use timestamp.
   */
  markUsed(id: string, now: number): void {
    this.database.connection.prepare(`
      UPDATE research_memory_records SET use_count = use_count + 1, last_used_at = ? WHERE id = ?
    `).run(now, id)
  }

  /**
   * List sources for one memory.
   * @param memoryId - memory identity.
   * @returns sources in creation order.
   */
  listSources(memoryId: string): MemorySource[] {
    return this.database.connection.prepare(`
      SELECT * FROM research_memory_sources WHERE memory_id = ? ORDER BY created_at ASC
    `).all(memoryId).map(mapSource)
  }

  /**
   * Insert or reuse one source link.
   * @param id - pre-minted source id when new.
   * @param memoryId - memory identity.
   * @param sourceKey - canonical source identity.
   * @param input - source coordinates.
   * @param now - creation timestamp.
   * @returns the persisted source.
   */
  insertSource(
    id: string,
    memoryId: string,
    sourceKey: string,
    input: {
      sessionId?: string
      eventSeq?: number
      entityType?: string
      entityId?: string
      sourceId?: string
      locationId?: string
      quote?: string
    },
    now: number,
  ): MemorySource {
    this.database.connection.prepare(`
      INSERT OR IGNORE INTO research_memory_sources (
        id, memory_id, source_key, session_id, event_seq, entity_type, entity_id,
        source_id, location_id, quote, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, memoryId, sourceKey, input.sessionId ?? null, input.eventSeq ?? null,
      input.entityType ?? null, input.entityId ?? null, input.sourceId ?? null,
      input.locationId ?? null, input.quote ?? '', now)
    const row = this.database.connection.prepare(`
      SELECT * FROM research_memory_sources WHERE memory_id = ? AND source_key = ?
    `).get(memoryId, sourceKey)
    if (row === undefined) throw new Error(`memory source "${sourceKey}" disappeared`)
    return mapSource(row)
  }

  /**
   * List relations for one memory.
   * @param memoryId - memory identity.
   * @returns relations in creation order.
   */
  listRelations(memoryId: string): MemoryRelation[] {
    return this.database.connection.prepare(`
      SELECT * FROM research_memory_relations WHERE memory_id = ? ORDER BY created_at ASC
    `).all(memoryId).map(mapRelation)
  }

  /**
   * Insert or reuse one relation.
   * @param id - pre-minted relation id when new.
   * @param memoryId - memory identity.
   * @param input - relation fields.
   * @param now - creation timestamp.
   * @returns the persisted relation.
   */
  insertRelation(
    id: string,
    memoryId: string,
    input: { entityType: string; entityId: string; relationType: string; note?: string },
    now: number,
  ): MemoryRelation {
    this.database.connection.prepare(`
      INSERT OR IGNORE INTO research_memory_relations (
        id, memory_id, entity_type, entity_id, relation_type, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, memoryId, input.entityType, input.entityId, input.relationType, input.note ?? '', now)
    const row = this.database.connection.prepare(`
      SELECT * FROM research_memory_relations
      WHERE memory_id = ? AND entity_type = ? AND entity_id = ? AND relation_type = ?
    `).get(memoryId, input.entityType, input.entityId, input.relationType)
    if (row === undefined) throw new Error(`memory relation "${input.entityId}" disappeared`)
    return mapRelation(row)
  }

  /**
   * Insert one version snapshot.
   * @param id - pre-minted version id.
   * @param memoryId - memory identity.
   * @param version - version number.
   * @param snapshot - JSON-safe snapshot.
   * @param context - change reason/source/author.
   * @param now - creation timestamp.
   */
  insertVersion(id: string, memoryId: string, version: number, snapshot: unknown, context: MemoryChangeContext, now: number): void {
    this.database.connection.prepare(`
      INSERT INTO research_memory_versions (
        id, memory_id, version, snapshot_json, change_reason, change_source,
        created_by, source_session_id, source_event_seq, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, memoryId, version, JSON.stringify(snapshot), context.changeReason,
      context.changeSource, context.createdBy, context.sourceSessionId ?? null,
      context.sourceEventSeq ?? null, now)
  }

  /**
   * List memory versions newest-first.
   * @param memoryId - memory identity.
   * @returns immutable version rows.
   */
  listVersions(memoryId: string): MemoryVersion[] {
    return this.database.connection.prepare(`
      SELECT * FROM research_memory_versions WHERE memory_id = ? ORDER BY version DESC
    `).all(memoryId).map(mapVersion)
  }

  /**
   * Insert or reuse one conflict.
   * @param id - pre-minted conflict id.
   * @param input - conflict fields.
   * @param now - creation timestamp.
   * @returns the persisted conflict.
   */
  insertConflict(id: string, input: {
    ideaId: string
    memoryAId: string
    memoryBId: string
    conflictType: string
    description: string
    detectedBy: string
  }, now: number): MemoryConflict {
    this.database.connection.prepare(`
      INSERT OR IGNORE INTO research_memory_conflicts (
        id, idea_id, memory_a_id, memory_b_id, conflict_type, description,
        status, resolution, detected_by, resolved_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', '', ?, NULL, ?)
    `).run(id, input.ideaId, input.memoryAId, input.memoryBId, input.conflictType,
      input.description, input.detectedBy, now)
    const row = this.database.connection.prepare(`
      SELECT * FROM research_memory_conflicts
      WHERE memory_a_id = ? AND memory_b_id = ? AND conflict_type = ?
    `).get(input.memoryAId, input.memoryBId, input.conflictType)
    if (row === undefined) throw new Error('memory conflict disappeared')
    return mapConflict(row)
  }

  /**
   * List conflicts for one Idea.
   * @param ideaId - owning Idea.
   * @param status - optional status filter.
   * @returns conflicts newest-first.
   */
  listConflicts(ideaId: string, status?: MemoryConflictStatus): MemoryConflict[] {
    const rows = status === undefined
      ? this.database.connection.prepare('SELECT * FROM research_memory_conflicts WHERE idea_id = ? ORDER BY created_at DESC').all(ideaId)
      : this.database.connection.prepare('SELECT * FROM research_memory_conflicts WHERE idea_id = ? AND status = ? ORDER BY created_at DESC').all(ideaId, status)
    return rows.map(mapConflict)
  }

  /**
   * Read one conflict.
   * @param ideaId - owning Idea.
   * @param conflictId - conflict identity.
   * @returns the conflict, or undefined.
   */
  getConflict(ideaId: string, conflictId: string): MemoryConflict | undefined {
    const row = this.database.connection.prepare(
      'SELECT * FROM research_memory_conflicts WHERE idea_id = ? AND id = ?',
    ).get(ideaId, conflictId)
    return row === undefined ? undefined : mapConflict(row)
  }

  /**
   * Update a conflict's review state.
   * @param conflictId - conflict identity.
   * @param status - resolved or dismissed.
   * @param resolution - human-readable resolution.
   * @param now - resolution timestamp.
   */
  resolveConflict(conflictId: string, status: 'resolved' | 'dismissed', resolution: string, now: number): void {
    this.database.connection.prepare(`
      UPDATE research_memory_conflicts
      SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?
    `).run(status, resolution, now, conflictId)
  }

  /**
   * Insert or reuse one retrieval selection.
   * @param id - pre-minted selection id.
   * @param input - selection fields.
   * @param now - creation timestamp.
   * @returns the persisted selection.
   */
  insertSelection(id: string, input: RecordMemorySelectionInput, now: number): MemorySelection {
    this.database.connection.prepare(`
      INSERT OR IGNORE INTO research_memory_selections (
        id, session_id, idea_id, turn, step, memory_id, rank, layer, reason, token_estimate, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.sessionId, input.ideaId, input.turn, input.step, input.memoryId,
      input.rank, input.layer, input.reason, input.tokenEstimate, now)
    const row = this.database.connection.prepare(`
      SELECT * FROM research_memory_selections
      WHERE session_id = ? AND turn = ? AND step = ? AND memory_id = ?
    `).get(input.sessionId, input.turn, input.step, input.memoryId)
    if (row === undefined) throw new Error('memory selection disappeared')
    return mapSelection(row)
  }

  /**
   * List selections for one Idea, optionally one Session.
   * @param ideaId - owning Idea.
   * @param sessionId - optional Session filter.
   * @returns selections newest-first.
   */
  listSelections(ideaId: string, sessionId?: string): MemorySelection[] {
    const rows = sessionId === undefined
      ? this.database.connection.prepare('SELECT * FROM research_memory_selections WHERE idea_id = ? ORDER BY created_at DESC').all(ideaId)
      : this.database.connection.prepare('SELECT * FROM research_memory_selections WHERE idea_id = ? AND session_id = ? ORDER BY created_at DESC').all(ideaId, sessionId)
    return rows.map(mapSelection)
  }
}
