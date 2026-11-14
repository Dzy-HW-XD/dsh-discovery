/**
 * Domain service for Phase 5.1 memories. The service enforces Idea isolation,
 * provenance and evidence requirements, lifecycle transitions, immutable
 * versions, and transactional source/relation consistency.
 * @module @deepseek-ai/dsh-research-core/memory-store
 */

import { createHash, randomUUID } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ResearchDatabase } from './database.ts'
import { ResearchError } from './errors.ts'
import { optionalText, text, type SqlRow } from './rows.ts'
import { ResearchMemoryRepository } from './memory-repository.ts'
import {
  MEMORY_CHANGE_SOURCES,
  MEMORY_ENTITY_TYPES,
  MemoryConflictId,
  MemoryId,
  type CreateMemoryConflictInput,
  type CreateMemoryInput,
  type MemoryChangeContext,
  type MemoryConflict,
  type MemoryConflictStatus,
  type MemoryCounts,
  type MemoryEntityType,
  type MemoryFilters,
  type MemoryLifecycleStatus,
  type MemoryRelation,
  type MemoryRelationInput,
  type MemorySelection,
  type MemorySearchHit,
  type MemorySearchOptions,
  type MemorySource,
  type MemorySourceInput,
  type MemoryType,
  type MemoryVersion,
  type RecordMemorySelectionInput,
  type ResearchMemory,
  type UpdateMemoryInput,
} from './memory-types.ts'
import type { IdeaId as IdeaIdType } from './types.ts'
import { appendTimeline } from './timeline.ts'

const LIFECYCLE_TRANSITIONS: Readonly<Record<MemoryLifecycleStatus, readonly MemoryLifecycleStatus[]>> = {
  candidate: ['active', 'rejected', 'archived'],
  active: ['superseded', 'rejected', 'archived'],
  superseded: ['archived'],
  rejected: ['candidate', 'archived'],
  archived: ['candidate', 'active'],
}

/** Research entity tables used to validate memory relations/sources. */
const ENTITY_TABLES: Readonly<Record<Exclude<MemoryEntityType, 'memory'>, string>> = {
  source: 'research_sources',
  concept: 'research_concepts',
  claim: 'research_claims',
  evidence: 'research_evidence',
  question: 'research_questions',
  gap: 'research_gaps',
  hypothesis: 'research_hypotheses',
  discovery: 'research_discoveries',
  decision: 'research_decisions',
  artifact: 'research_artifacts',
  session_summary: 'research_session_summaries',
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ResearchError('research/invalid-input', `${field} must be non-empty text`, { field })
  }
  return value
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ')
}

function contentHash(title: string, content: string): string {
  return createHash('sha256').update(`${normalizeText(title)}\n${normalizeText(content)}`).digest('hex')
}

function sourceKey(input: MemorySourceInput): string {
  return JSON.stringify({
    sessionId: input.sessionId ?? null,
    eventSeq: input.eventSeq ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    sourceId: input.sourceId ?? null,
    locationId: input.locationId ?? null,
    quote: input.quote ?? '',
    summaryId: input.summaryId ?? null,
    summaryVersion: input.summaryVersion ?? null,
    extractionJobId: input.extractionJobId ?? null,
    entityVersion: input.entityVersion ?? null,
    sourceRole: input.sourceRole ?? 'direct',
  })
}

function requiresEvidence(memoryType: MemoryType, epistemicStatus: string): boolean {
  return (memoryType === 'fact' || memoryType === 'finding')
    && (epistemicStatus === 'verified' || epistemicStatus === 'supported')
}

/** Durable memory service. */
export class ResearchMemoryStore {
  private readonly repository: ResearchMemoryRepository

  /**
   * @param database - open research database.
   */
  constructor(private readonly database: ResearchDatabase) {
    this.repository = new ResearchMemoryRepository(database)
  }

  /**
   * Create one memory with version 1 and its provenance.
   * @param input - Idea, type, text, statuses, and sources.
   * @returns the hydrated memory.
   */
  createMemory(input: CreateMemoryInput): ResearchMemory {
    this.assertIdea(input.ideaId)
    const title = requireText(input.title, 'title')
    const content = requireText(input.content, 'content')
    const lifecycle = input.lifecycleStatus ?? 'candidate'
    const epistemic = input.epistemicStatus ?? 'inferred'
    this.assertConfidence(input.confidence ?? 0.5)
    const sources = input.sources ?? []
    this.validateSources(input.ideaId, sources, input.sourceSessionId)
    this.validateRelations(input.ideaId, input.relations ?? [])
    this.assertSourcesRequirement(input.ideaId, input.memoryType, epistemic, sources, input.sourceSessionId, input.sourceIds ?? [])
    const hash = contentHash(title, content)
    const existing = this.repository.findByHash(input.ideaId, input.memoryType, hash)
    if (existing !== undefined) {
      const before = this.repository.listSources(existing.id).length
      this.database.transaction(() => {
        for (const source of sources) this.insertSource(existing.id, source)
        for (const relation of input.relations ?? []) this.insertRelation(existing.id, relation)
      })
      if (this.repository.listSources(existing.id).length !== before) {
        appendTimeline(this.database, input.ideaId, 'memory.sources-added', 'memory', existing.id,
          `Attached additional provenance to memory: ${existing.title}`, input.sourceSessionId,
          { memoryId: existing.id }, Date.now())
      }
      return this.getMemory(input.ideaId, existing.id) as ResearchMemory
    }
    const id = MemoryId(newId('mem'))
    const now = Date.now()
    this.database.transaction(() => {
      this.repository.insert(id, { ...input, title, content, epistemicStatus: epistemic, lifecycleStatus: lifecycle }, hash, now)
      for (const source of sources) this.insertSource(id, source)
      for (const relation of input.relations ?? []) this.insertRelation(id, relation)
      const memory = this.hydrate(this.requireMemory(input.ideaId, id))
      this.repository.insertVersion(newId('mvr'), id, 1, this.snapshot(memory), {
        changeReason: 'created',
        changeSource: 'system',
        createdBy: 'research',
        ...input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId },
      }, now)
      appendTimeline(this.database, input.ideaId, 'memory.created', 'memory', id,
        `Created memory: ${title}`, input.sourceSessionId,
        { memoryType: input.memoryType, epistemicStatus: epistemic, lifecycleStatus: lifecycle }, now)
    })
    return this.getMemory(input.ideaId, id) as ResearchMemory
  }

  /**
   * Update one memory and append an immutable version snapshot.
   * @param ideaId - owning Idea.
   * @param memoryId - memory identity.
   * @param patch - admitted field changes and new provenance.
   * @param context - required change reason/source/author.
   * @returns the hydrated updated memory.
   */
  updateMemory(
    ideaId: IdeaIdType,
    memoryId: MemoryId,
    patch: UpdateMemoryInput,
    context: MemoryChangeContext,
  ): ResearchMemory {
    const current = this.requireMemory(ideaId, memoryId)
    this.assertChangeContext(context)
    const nextTitle = requireText(patch.title ?? current.title, 'title')
    const nextContent = requireText(patch.content ?? current.content, 'content')
    const nextLifecycle = patch.lifecycleStatus ?? current.lifecycleStatus
    const nextEpistemic = patch.epistemicStatus ?? current.epistemicStatus
    this.assertTransition(current.lifecycleStatus, nextLifecycle)
    this.assertConfidence(patch.confidence ?? current.confidence)
    const nextSources = patch.sources ?? []
    this.validateSources(ideaId, nextSources, patch.sourceSessionId ?? current.sourceSessionId)
    this.validateRelations(ideaId, patch.relations ?? [])
    const existingSources = this.repository.listSources(memoryId)
    const hasEvidence = existingSources.length > 0 || nextSources.length > 0
      || (patch.sourceIds ?? current.sourceIds).length > 0
      || (patch.sourceSessionId ?? current.sourceSessionId) !== undefined
    if (requiresEvidence(current.memoryType, nextEpistemic) && !hasEvidence) {
      throw new ResearchError('research/memory-source-invalid', 'factual memory requires provenance', { memoryId })
    }
    if (current.memoryType === 'preference' && (patch.sourceSessionId ?? current.sourceSessionId) === undefined) {
      throw new ResearchError('research/memory-source-invalid', 'preference memory requires a Session source', { memoryId })
    }
    const hash = contentHash(nextTitle, nextContent)
    const collision = this.repository.findByHash(ideaId, current.memoryType, hash)
    if (collision !== undefined && collision.id !== memoryId) {
      throw new ResearchError('research/duplicate', 'memory content duplicates another record', { memoryId: collision.id })
    }
    const now = Date.now()
    this.database.transaction(() => {
      this.repository.update(memoryId, {
        ...patch,
        title: nextTitle,
        content: nextContent,
        lifecycleStatus: nextLifecycle,
        epistemicStatus: nextEpistemic,
      }, hash, now)
      for (const source of nextSources) this.insertSource(memoryId, source)
      for (const relation of patch.relations ?? []) this.insertRelation(memoryId, relation)
      const updated = this.hydrate(this.requireMemory(ideaId, memoryId))
      this.repository.insertVersion(newId('mvr'), memoryId, updated.version, this.snapshot(updated), context, now)
      appendTimeline(this.database, ideaId, 'memory.updated', 'memory', memoryId,
        `Updated memory: ${updated.title}`, context.sourceSessionId,
        {
          memoryId,
          version: updated.version,
          changeReason: context.changeReason,
          lifecycleStatus: updated.lifecycleStatus,
          epistemicStatus: updated.epistemicStatus,
        }, now)
    })
    return this.getMemory(ideaId, memoryId) as ResearchMemory
  }

  /**
   * Archive a memory without deleting it.
   * @param ideaId - owning Idea.
   * @param memoryId - memory identity.
   * @param context - change reason/source/author.
   * @returns the archived memory.
   */
  archiveMemory(ideaId: IdeaIdType, memoryId: MemoryId, context: MemoryChangeContext): ResearchMemory {
    return this.updateMemory(ideaId, memoryId, { lifecycleStatus: 'archived' }, context)
  }

  /**
   * Restore an archived or rejected memory to candidate or active.
   * @param ideaId - owning Idea.
   * @param memoryId - memory identity.
   * @param lifecycleStatus - target lifecycle state.
   * @param context - change reason/source/author.
   * @returns the restored memory.
   */
  restoreMemory(
    ideaId: IdeaIdType,
    memoryId: MemoryId,
    lifecycleStatus: 'candidate' | 'active',
    context: MemoryChangeContext,
  ): ResearchMemory {
    return this.updateMemory(ideaId, memoryId, { lifecycleStatus }, context)
  }

  /**
   * Read one memory with sources and relations.
   * @param ideaId - owning Idea.
   * @param memoryId - memory identity.
   * @returns the hydrated memory, or undefined when outside the Idea.
   */
  getMemory(ideaId: IdeaIdType, memoryId: MemoryId): ResearchMemory | undefined {
    const memory = this.repository.get(ideaId, memoryId)
    return memory === undefined ? undefined : this.hydrate(memory)
  }

  /**
   * List memories for one Idea.
   * @param ideaId - owning Idea.
   * @param filters - optional type/status filters and limit.
   * @returns hydrated memories newest-first.
   */
  listMemories(ideaId: IdeaIdType, filters: MemoryFilters = {}): ResearchMemory[] {
    this.assertIdea(ideaId)
    return this.repository.list(ideaId, filters).map(memory => this.hydrate(memory))
  }

  /**
   * Read immutable version history.
   * @param ideaId - owning Idea.
   * @param memoryId - memory identity.
   * @returns versions newest-first.
   */
  listVersions(ideaId: IdeaIdType, memoryId: MemoryId): MemoryVersion[] {
    this.requireMemory(ideaId, memoryId)
    return this.repository.listVersions(memoryId)
  }

  /**
   * Attach one provenance source.
   * @param ideaId - owning Idea.
   * @param memoryId - memory identity.
   * @param input - Session/entity/bibliographic source.
   * @returns the persisted source.
   */
  addSource(ideaId: IdeaIdType, memoryId: MemoryId, input: MemorySourceInput): MemorySource {
    this.requireMemory(ideaId, memoryId)
    this.validateSources(ideaId, [input], input.sessionId)
    const now = Date.now()
    return this.database.transaction(() => {
      const source = this.insertSource(memoryId, input, now)
      appendTimeline(this.database, ideaId, 'memory.source-added', 'memory', memoryId,
        'Attached memory provenance', input.sessionId, { memoryId }, now)
      return source
    })
  }

  /**
   * Attach one relation to a memory or research entity.
   * @param ideaId - owning Idea.
   * @param memoryId - memory identity.
   * @param input - target entity, relation kind, and optional note.
   * @returns the persisted relation.
   */
  addRelation(ideaId: IdeaIdType, memoryId: MemoryId, input: MemoryRelationInput): MemoryRelation {
    this.requireMemory(ideaId, memoryId)
    this.validateRelations(ideaId, [input])
    const now = Date.now()
    return this.database.transaction(() => {
      const relation = this.insertRelation(memoryId, input, now)
      appendTimeline(this.database, ideaId, 'memory.relation-added', 'memory', memoryId,
        `Attached memory relation: ${input.relationType}`, undefined,
        { memoryId, entityType: input.entityType, entityId: input.entityId }, now)
      return relation
    })
  }

  /**
   * Record a conflict without changing either memory's lifecycle.
   * @param input - both memories, conflict kind, and evidence.
   * @returns the existing or new conflict.
   */
  createConflict(input: CreateMemoryConflictInput): MemoryConflict {
    this.assertIdea(input.ideaId)
    const a = this.requireMemory(input.ideaId, input.memoryAId)
    const b = this.requireMemory(input.ideaId, input.memoryBId)
    if (a.id === b.id) {
      throw new ResearchError('research/invalid-input', 'a conflict requires two memories', { memoryId: a.id })
    }
    requireText(input.description, 'description')
    requireText(input.detectedBy, 'detectedBy')
    const now = Date.now()
    return this.database.transaction(() => {
      const conflict = this.repository.insertConflict(newId('mcf'), input, now)
      appendTimeline(this.database, input.ideaId, 'memory.conflict-detected', 'memory', conflict.id,
        `Detected memory conflict: ${input.conflictType}`, undefined,
        { memoryAId: input.memoryAId, memoryBId: input.memoryBId, conflictType: input.conflictType }, now)
      return conflict
    })
  }

  /**
   * List conflicts for an Idea.
   * @param ideaId - owning Idea.
   * @param status - optional lifecycle filter.
   * @returns conflicts newest-first.
   */
  listConflicts(ideaId: IdeaIdType, status?: MemoryConflictStatus): MemoryConflict[] {
    this.assertIdea(ideaId)
    return this.repository.listConflicts(ideaId, status)
  }

  /**
   * Resolve or dismiss an open conflict.
   * @param ideaId - owning Idea.
   * @param conflictId - conflict identity.
   * @param status - resolved or dismissed.
   * @param resolution - required human-readable resolution.
   * @returns the updated conflict.
   */
  resolveConflict(
    ideaId: IdeaIdType,
    conflictId: MemoryConflictId,
    status: 'resolved' | 'dismissed',
    resolution: string,
  ): MemoryConflict {
    const conflict = this.repository.getConflict(ideaId, conflictId)
    if (conflict === undefined) {
      throw new ResearchError('research/memory-conflict-not-found', `Memory conflict "${conflictId}" not found`, { conflictId })
    }
    if (conflict.status !== 'open') {
      throw new ResearchError('research/memory-transition-invalid', 'conflict is already closed', { conflictId })
    }
    requireText(resolution, 'resolution')
    const now = Date.now()
    this.database.transaction(() => {
      this.repository.resolveConflict(conflictId, status, resolution, now)
      appendTimeline(this.database, ideaId, 'memory.conflict-resolved', 'memory', conflictId,
        `Memory conflict ${status}`, undefined, { conflictId, resolution }, now)
    })
    const updated = this.repository.getConflict(ideaId, conflictId)
    if (updated === undefined) {
      throw new ResearchError('research/database-unavailable', 'conflict disappeared after resolution', { conflictId })
    }
    return updated
  }

  /**
   * Record one injection selection and mark the memory as used.
   * @param input - Session/turn/step, memory, layer, rank, and token estimate.
   * @returns the persisted selection.
   */
  recordSelection(input: RecordMemorySelectionInput): MemorySelection {
    this.assertIdea(input.ideaId)
    this.assertSession(input.ideaId, input.sessionId)
    const memory = this.requireMemory(input.ideaId, input.memoryId)
    if (!Number.isSafeInteger(input.turn) || input.turn < 0
      || !Number.isSafeInteger(input.step) || input.step < 0
      || !Number.isSafeInteger(input.rank) || input.rank < 0
      || !Number.isSafeInteger(input.tokenEstimate) || input.tokenEstimate < 0) {
      throw new ResearchError('research/invalid-input', 'selection turn, step, rank, and tokens must be non-negative integers', {})
    }
    requireText(input.reason, 'reason')
    const existing = this.repository.listSelections(input.ideaId, input.sessionId).find(selection =>
      selection.turn === input.turn && selection.step === input.step && selection.memoryId === input.memoryId)
    if (existing !== undefined) return existing
    const now = Date.now()
    return this.database.transaction(() => {
      const selection = this.repository.insertSelection(newId('msl'), input, now)
      this.repository.markUsed(memory.id, now)
      return selection
    })
  }

  /**
   * List retrieval selections for an Idea.
   * @param ideaId - owning Idea.
   * @param sessionId - optional Session filter.
   * @returns selections newest-first.
   */
  listSelections(ideaId: IdeaIdType, sessionId?: string): MemorySelection[] {
    this.assertIdea(ideaId)
    return this.repository.listSelections(ideaId, sessionId)
  }

  /**
   * Search memories by title/content with FTS5 trigram and a LIKE fallback for
   * queries shorter than three characters. Results stay inside one Idea.
   * @param ideaId - owning Idea.
   * @param query - raw user query.
   * @param options - optional type/status filters and limit.
   * @returns hydrated hits ordered by text relevance.
   */
  searchMemories(ideaId: IdeaIdType, query: string, options: MemorySearchOptions = {}): MemorySearchHit[] {
    this.assertIdea(ideaId)
    const normalized = query.trim()
    if (normalized === '') return []
    const statuses = options.lifecycleStatuses ?? ['active', 'candidate']
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100))
    const statusSql = statuses.map(() => '?').join(',')
    const typeSql = options.memoryTypes === undefined || options.memoryTypes.length === 0
      ? ''
      : ` AND m.memory_type IN (${options.memoryTypes.map(() => '?').join(',')})`
    const values: (string | number)[] = [ideaId, ...statuses, ...options.memoryTypes ?? []]
    if (normalized.length < 3) return this.likeSearch(ideaId, normalized, statusSql, typeSql, values, limit)
    try {
      const terms = normalized.split(/\s+/u).filter(term => term.length >= 3)
      const match = normalized.includes(' OR ') || normalized.includes('"')
        ? normalized
        : terms.length > 1
          ? terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
          : `"${normalized.replaceAll('"', '""')}"`
      const rows = this.database.connection.prepare(`
        SELECT m.id, bm25(research_memory_fts) AS rank
        FROM research_memory_fts f
        JOIN research_memory_records m ON m.id = f.memory_id
        WHERE f.idea_id = ? AND research_memory_fts MATCH ? AND m.lifecycle_status IN (${statusSql})${typeSql}
        ORDER BY rank ASC, m.updated_at DESC, m.id ASC
        LIMIT ?
      `).all(ideaId, match, ...statuses, ...options.memoryTypes ?? [], limit) as SqlRow[]
      return rows.flatMap((row) => {
        const memory = this.repository.get(ideaId, text(row, 'id'))
        if (memory === undefined) return []
        const rank = typeof row['rank'] === 'number' ? row['rank'] : 0
        return [{ memory: this.hydrate(memory), textRelevance: Math.max(0.05, 1 / (1 + Math.abs(rank))) }]
      })
    } catch {
      return this.likeSearch(ideaId, normalized, statusSql, typeSql, values, limit)
    }
  }

  private likeSearch(
    ideaId: IdeaIdType,
    query: string,
    statusSql: string,
    typeSql: string,
    values: (string | number)[],
    limit: number,
  ): MemorySearchHit[] {
    const escaped = query.replace(/[\\%_]/gu, match => `\\${match}`)
    const rows = this.database.connection.prepare(`
      SELECT m.id FROM research_memory_records m
      WHERE m.idea_id = ? AND m.lifecycle_status IN (${statusSql})${typeSql}
        AND (m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')
      ORDER BY m.updated_at DESC, m.id ASC LIMIT ?
    `).all(...values, `%${escaped}%`, `%${escaped}%`, limit) as SqlRow[]
    return rows.flatMap((row) => {
      const memory = this.repository.get(ideaId, text(row, 'id'))
      return memory === undefined ? [] : [{ memory: this.hydrate(memory), textRelevance: 0.55 }]
    })
  }

  /**
   * Rebuild the FTS index from the authoritative memory rows.
   */
  rebuildSearchIndex(): void {
    this.database.transaction(() => {
      this.database.connection.prepare('DELETE FROM research_memory_fts').run()
      this.database.connection.prepare(`
        INSERT INTO research_memory_fts (memory_id, idea_id, title, content)
        SELECT id, idea_id, title, content FROM research_memory_records
      `).run()
    })
  }

  /**
   * Count memories by lifecycle and type.
   * @param ideaId - owning Idea.
   * @returns complete count maps.
   */
  counts(ideaId: IdeaIdType): MemoryCounts {
    this.assertIdea(ideaId)
    const raw = this.repository.counts(ideaId)
    const byLifecycle = { candidate: 0, active: 0, superseded: 0, rejected: 0, archived: 0 }
    for (const [key, value] of Object.entries(raw.byLifecycle)) {
      if (key in byLifecycle) byLifecycle[key as MemoryLifecycleStatus] = value
    }
    const byType = {
      goal: 0, fact: 0, finding: 0, hypothesis: 0, decision: 0,
      constraint: 0, failure: 0, open_question: 0, strategy: 0, preference: 0,
    }
    for (const [key, value] of Object.entries(raw.byType)) {
      if (key in byType) byType[key as MemoryType] = value
    }
    return { total: raw.total, byLifecycle, byType }
  }

  private hydrate(memory: ResearchMemory): ResearchMemory {
    return {
      ...memory,
      sources: this.repository.listSources(memory.id),
      relations: this.repository.listRelations(memory.id),
    }
  }

  private requireMemory(ideaId: IdeaIdType, memoryId: MemoryId): ResearchMemory {
    const memory = this.repository.get(ideaId, memoryId)
    if (memory === undefined) {
      throw new ResearchError('research/memory-not-found', `Memory "${memoryId}" not found`, { memoryId })
    }
    return this.hydrate(memory)
  }

  private snapshot(memory: ResearchMemory): JsonValue {
    return JSON.parse(JSON.stringify(memory)) as JsonValue
  }

  private insertSource(memoryId: MemoryId, input: MemorySourceInput, now: number = Date.now()): MemorySource {
    return this.repository.insertSource(newId('msc'), memoryId, sourceKey(input), input, now)
  }

  private insertRelation(memoryId: MemoryId, input: MemoryRelationInput, now: number = Date.now()): MemoryRelation {
    return this.repository.insertRelation(newId('mrl'), memoryId, input, now)
  }

  private assertIdea(ideaId: IdeaIdType): void {
    const row = this.database.connection.prepare('SELECT id FROM research_ideas WHERE id = ?').get(ideaId)
    if (row === undefined) {
      throw new ResearchError('research/idea-not-found', `Idea "${ideaId}" not found`, { ideaId })
    }
  }

  private assertSession(ideaId: IdeaIdType, sessionId: string): void {
    const row = this.database.connection.prepare(
      'SELECT idea_id FROM research_sessions WHERE session_id = ?',
    ).get(sessionId)
    if (row === undefined) {
      throw new ResearchError('research/session-not-found', `Session "${sessionId}" not found`, { sessionId })
    }
    const owner = optionalText(row, 'idea_id')
    if (owner !== ideaId) {
      throw new ResearchError('research/invalid-input', 'Session belongs to another Idea', { sessionId })
    }
  }

  private validateSources(ideaId: IdeaIdType, sources: readonly MemorySourceInput[], sessionId?: string): void {
    if (sessionId !== undefined) this.assertSession(ideaId, sessionId)
    for (const source of sources) {
      if (source.sessionId !== undefined) this.assertSession(ideaId, source.sessionId)
      if (source.eventSeq !== undefined && (!Number.isSafeInteger(source.eventSeq) || source.eventSeq < 0)) {
        throw new ResearchError('research/invalid-input', 'source eventSeq must be a non-negative integer', {})
      }
      if (source.entityType !== undefined && source.entityId !== undefined) {
        this.assertEntity(ideaId, source.entityType, source.entityId)
      } else if (source.entityType !== undefined || source.entityId !== undefined) {
        throw new ResearchError('research/invalid-input', 'source entity requires both type and id', {})
      }
      if (source.sourceId !== undefined) this.assertSource(source.sourceId)
      if (source.locationId !== undefined) this.assertLocation(source.locationId, source.sourceId)
      if (source.summaryId !== undefined) this.assertSummary(ideaId, source.summaryId)
    }
  }

  private validateRelations(ideaId: IdeaIdType, relations: readonly MemoryRelationInput[]): void {
    for (const relation of relations) {
      this.assertEntity(ideaId, relation.entityType, relation.entityId)
    }
  }

  private assertEntity(ideaId: IdeaIdType, entityType: MemoryEntityType, entityId: string): void {
    if (!(MEMORY_ENTITY_TYPES as readonly string[]).includes(entityType)) {
      throw new ResearchError('research/invalid-input', `unknown memory entity type "${entityType}"`, { entityType })
    }
    if (entityType === 'memory') {
      this.requireMemory(ideaId, MemoryId(entityId))
      return
    }
    const table = ENTITY_TABLES[entityType]
    const row = this.database.connection.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entityId)
    if (row === undefined) {
      throw new ResearchError('research/entity-not-found', `${entityType} "${entityId}" not found`, { entityType, entityId })
    }
    if (entityType !== 'source') {
      const owner = optionalText(row, 'idea_id') ?? optionalText(row, 'origin_idea_id')
      if (owner !== undefined && owner !== ideaId) {
        throw new ResearchError('research/invalid-input', `${entityType} belongs to another Idea`, { entityType, entityId })
      }
    }
  }

  private assertSource(sourceId: string): void {
    const row = this.database.connection.prepare('SELECT id FROM research_sources WHERE id = ?').get(sourceId)
    if (row === undefined) {
      throw new ResearchError('research/source-not-found', `Source "${sourceId}" not found`, { sourceId })
    }
  }

  private assertSummary(ideaId: IdeaIdType, summaryId: string): void {
    const row = this.database.connection.prepare(
      'SELECT idea_id FROM research_session_summaries WHERE id = ?',
    ).get(summaryId)
    if (row === undefined) {
      throw new ResearchError('research/entity-not-found', `Session summary "${summaryId}" not found`, { summaryId })
    }
    if (optionalText(row, 'idea_id') !== ideaId) {
      throw new ResearchError('research/invalid-input', 'summary belongs to another Idea', { summaryId })
    }
  }

  private assertLocation(locationId: string, sourceId?: string): void {
    const row = this.database.connection.prepare(
      'SELECT source_id FROM research_source_locations WHERE id = ?',
    ).get(locationId)
    if (row === undefined) {
      throw new ResearchError('research/source-not-found', `Source location "${locationId}" not found`, { locationId })
    }
    if (sourceId !== undefined && optionalText(row, 'source_id') !== sourceId) {
      throw new ResearchError('research/invalid-input', 'source location belongs to another Source', { locationId })
    }
  }

  private assertSourcesRequirement(
    ideaId: IdeaIdType,
    memoryType: MemoryType,
    epistemicStatus: string,
    sources: readonly MemorySourceInput[],
    sessionId: string | undefined,
    sourceIds: readonly string[],
  ): void {
    for (const sourceId of sourceIds) this.assertSource(sourceId)
    const hasEvidence = sources.length > 0 || sourceIds.length > 0 || sessionId !== undefined
    if (requiresEvidence(memoryType, epistemicStatus) && !hasEvidence) {
      throw new ResearchError('research/memory-source-invalid', 'factual memory requires provenance', { ideaId })
    }
    if (memoryType === 'preference' && sessionId === undefined && sources.every(source => source.sessionId === undefined)) {
      throw new ResearchError('research/memory-source-invalid', 'preference memory requires a Session source', { ideaId })
    }
  }

  private assertConfidence(confidence: number): void {
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new ResearchError('research/invalid-input', 'confidence must be between 0 and 1', { confidence })
    }
  }

  private assertChangeContext(context: MemoryChangeContext): void {
    requireText(context.changeReason, 'changeReason')
    requireText(context.createdBy, 'createdBy')
    if (!(MEMORY_CHANGE_SOURCES as readonly string[]).includes(context.changeSource)) {
      throw new ResearchError('research/invalid-input', `unknown memory change source "${context.changeSource}"`, {})
    }
  }

  private assertTransition(from: MemoryLifecycleStatus, to: MemoryLifecycleStatus): void {
    if (from === to) return
    if (!LIFECYCLE_TRANSITIONS[from].includes(to)) {
      throw new ResearchError('research/memory-transition-invalid', `memory cannot move from ${from} to ${to}`, { from, to })
    }
  }
}
