/**
 * Idea lifecycle, directed relations, and the append-only Idea timeline.
 * Parent/Child is stored only as `parent_idea_id`; the relation table carries
 * related_to, derived_from, merged_from, and references.
 * @module @deepseek-ai/dsh-research-core/ideas
 */

import { randomUUID } from 'node:crypto'
import type { ResearchDatabase } from './database.ts'
import { ResearchError } from './errors.ts'
import { integer, json, optionalInteger, optionalText, text, type SqlRow } from './rows.ts'
import {
  canTransitionIdeaStatus,
  IDEA_RELATION_TYPES,
  IDEA_STATUSES,
  IdeaId,
  IdeaRelationId,
  TimelineEventId,
  type AddIdeaRelationInput,
  type CreateIdeaInput,
  type IdeaRelationType,
  type ListIdeasFilter,
  type ResearchIdea,
  type ResearchIdeaRelation,
  type ResearchTimelineEvent,
  type UpdateIdeaInput,
} from './types.ts'

const MAX_TITLE_LENGTH = 200
const MAX_TEXT_LENGTH = 100_000
const MAX_OBJECTIVES = 50
const MAX_OBJECTIVE_LENGTH = 500
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500
const DEFAULT_TIMELINE_LIMIT = 50
const MAX_TIMELINE_LIMIT = 200

interface IdeaRowMap {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly research_question: string
  readonly objectives_json: string
  readonly status: string
  readonly parent_idea_id: string | null
  readonly current_summary: string
  readonly created_at: number
  readonly updated_at: number
  readonly archived_at: number | null
  readonly version: number
  readonly created_by: string
}

/**
 * Normalize one Idea row into the public value.
 * @param row - SQLite row.
 * @returns the branded public Idea.
 */
function mapIdea(row: SqlRow): ResearchIdea {
  const parent = optionalText(row, 'parent_idea_id')
  const archivedAt = optionalInteger(row, 'archived_at')
  return {
    id: IdeaId(text(row, 'id')),
    title: text(row, 'title'),
    description: text(row, 'description'),
    researchQuestion: text(row, 'research_question'),
    objectives: json(row, 'objectives_json') as readonly string[],
    status: text(row, 'status') as ResearchIdea['status'],
    ...parent === undefined ? {} : { parentIdeaId: IdeaId(parent) },
    currentSummary: text(row, 'current_summary'),
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    ...archivedAt === undefined ? {} : { archivedAt },
    version: integer(row, 'version'),
    createdBy: text(row, 'created_by'),
  }
}

/**
 * Normalize one relation row into the public value.
 * @param row - SQLite row.
 * @returns the branded public relation.
 */
function mapRelation(row: SqlRow): ResearchIdeaRelation {
  const groupId = optionalText(row, 'group_id')
  const supersedes = optionalText(row, 'supersedes_relation_id')
  return {
    id: IdeaRelationId(text(row, 'id')),
    fromIdeaId: IdeaId(text(row, 'from_idea_id')),
    toIdeaId: IdeaId(text(row, 'to_idea_id')),
    relationType: text(row, 'relation_type') as IdeaRelationType,
    status: text(row, 'status') as ResearchIdeaRelation['status'],
    note: text(row, 'note'),
    ...groupId === undefined ? {} : { groupId },
    ...supersedes === undefined ? {} : { supersedesRelationId: IdeaRelationId(supersedes) },
    createdBy: text(row, 'created_by'),
    createdAt: integer(row, 'created_at'),
  }
}

/**
 * Normalize one timeline row into the public value.
 * @param row - SQLite row.
 * @returns the branded public event.
 */
function mapTimeline(row: SqlRow): ResearchTimelineEvent {
  const entityType = optionalText(row, 'entity_type')
  const entityId = optionalText(row, 'entity_id')
  return {
    id: TimelineEventId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    eventType: text(row, 'event_type'),
    ...entityType === undefined ? {} : { entityType },
    ...entityId === undefined ? {} : { entityId },
    summary: text(row, 'summary'),
    payload: json(row, 'payload_json'),
    createdAt: integer(row, 'created_at'),
  }
}

/**
 * Escape `%`, `_`, and the escape character for a literal LIKE search.
 * @param value - user query.
 * @returns the escaped pattern fragment.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`)
}

/**
 * Validate and normalize the mutable Idea fields.
 * @param input - caller input.
 * @returns normalized title and text fields.
 */
function normalizeIdeaFields(input: {
  readonly title: string
  readonly description?: string
  readonly researchQuestion?: string
  readonly objectives?: readonly string[]
  readonly currentSummary?: string
}): {
  readonly title: string
  readonly description: string
  readonly researchQuestion: string
  readonly objectives: readonly string[]
  readonly currentSummary: string
} {
  const title = input.title.trim()
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw new ResearchError('research/invalid-input', `Idea title must be 1-${MAX_TITLE_LENGTH} characters`, {
      field: 'title',
    })
  }
  const description = input.description?.trim() ?? ''
  const researchQuestion = input.researchQuestion?.trim() ?? ''
  const currentSummary = input.currentSummary?.trim() ?? ''
  if (description.length > MAX_TEXT_LENGTH || researchQuestion.length > MAX_TEXT_LENGTH || currentSummary.length > MAX_TEXT_LENGTH) {
    throw new ResearchError('research/invalid-input', 'Idea text fields exceed the storage limit', {
      maxLength: MAX_TEXT_LENGTH,
    })
  }
  const objectives = (input.objectives ?? []).map(objective => objective.trim()).filter(objective => objective.length > 0)
  if (objectives.length > MAX_OBJECTIVES || objectives.some(objective => objective.length > MAX_OBJECTIVE_LENGTH)) {
    throw new ResearchError('research/invalid-input', 'Idea objectives exceed the storage limit', {
      maxObjectives: MAX_OBJECTIVES,
      maxObjectiveLength: MAX_OBJECTIVE_LENGTH,
    })
  }
  return { title, description, researchQuestion, objectives, currentSummary }
}

/** Idea repository and lifecycle service. */
export class IdeaManager {
  /**
   * @param database - open Phase 1 research database.
   */
  constructor(private readonly database: ResearchDatabase) {}

  /**
   * Create one Idea and its first timeline event atomically.
   * @param input - title and optional research fields.
   * @returns the committed Idea.
   */
  createIdea(input: CreateIdeaInput): ResearchIdea {
    const fields = normalizeIdeaFields(input)
    const status = input.status ?? 'seed'
    if (!IDEA_STATUSES.includes(status)) {
      throw new ResearchError('research/invalid-input', `unknown Idea status "${status}"`, { field: 'status' })
    }
    const now = Date.now()
    const id = IdeaId(`idea_${randomUUID()}`)
    if (input.parentIdeaId !== undefined) this.assertIdeaExists(input.parentIdeaId)
    const row: IdeaRowMap = {
      id,
      title: fields.title,
      description: fields.description,
      research_question: fields.researchQuestion,
      objectives_json: JSON.stringify(fields.objectives),
      status,
      parent_idea_id: input.parentIdeaId ?? null,
      current_summary: fields.currentSummary,
      created_at: now,
      updated_at: now,
      archived_at: status === 'archived' ? now : null,
      version: 1,
      created_by: input.createdBy ?? 'user',
    }
    return this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT INTO research_ideas (
          id, title, description, research_question, objectives_json, status,
          parent_idea_id, current_summary, created_at, updated_at, archived_at,
          version, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.title, row.description, row.research_question, row.objectives_json, row.status,
        row.parent_idea_id, row.current_summary, row.created_at, row.updated_at, row.archived_at,
        row.version, row.created_by,
      )
      this.recordTimeline(id, 'idea.created', 'idea', id, `Idea created: ${row.title}`, {
        status,
        parentIdeaId: row.parent_idea_id,
      }, now)
      return this.getIdea(id) as ResearchIdea
    })
  }

  /**
   * Read one Idea.
   * @param id - Idea identity.
   * @returns the Idea, or undefined.
   */
  getIdea(id: IdeaId): ResearchIdea | undefined {
    const row = this.database.connection
      .prepare('SELECT * FROM research_ideas WHERE id = ?')
      .get(id)
    return row === undefined ? undefined : mapIdea(row)
  }

  /**
   * Read the parent of one Idea.
   * @param id - child Idea identity.
   * @returns the parent Idea, or undefined for a root Idea.
   */
  parentOf(id: IdeaId): ResearchIdea | undefined {
    const child = this.requireIdea(id)
    return child.parentIdeaId === undefined ? undefined : this.getIdea(child.parentIdeaId)
  }

  /**
   * List the direct children of one Idea.
   * @param id - parent Idea identity.
   * @returns direct children ordered by most recent update.
   */
  childrenOf(id: IdeaId): ResearchIdea[] {
    this.assertIdeaExists(id)
    return this.database.connection.prepare(`
      SELECT * FROM research_ideas
      WHERE parent_idea_id = ?
      ORDER BY updated_at DESC, id ASC
    `).all(id).map(mapIdea)
  }

  /**
   * List Ideas with literal text and metadata filters.
   * @param filter - status, archive visibility, query, parent, and limit.
   * @returns Ideas ordered by most recently updated.
   */
  listIdeas(filter: ListIdeasFilter = {}): ResearchIdea[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (filter.status !== undefined) {
      clauses.push('status = ?')
      params.push(filter.status)
    } else if (filter.includeArchived !== true) {
      clauses.push("status <> 'archived'")
    }
    if (filter.parentIdeaId !== undefined) {
      clauses.push('parent_idea_id = ?')
      params.push(filter.parentIdeaId)
    }
    const query = filter.query?.trim()
    if (query !== undefined && query.length > 0) {
      const pattern = `%${escapeLike(query)}%`
      clauses.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR research_question LIKE ? ESCAPE '\\')")
      params.push(pattern, pattern, pattern)
    }
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)
    const sql = `
      SELECT * FROM research_ideas
      ${clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`}
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
    `
    params.push(limit)
    return this.database.connection.prepare(sql).all(...params).map(mapIdea)
  }

  /**
   * Update one Idea under optimistic concurrency.
   * @param id - Idea identity.
   * @param patch - mutable fields; omitted fields keep their value.
   * @param expectedVersion - caller-observed version.
   * @returns the committed Idea.
   */
  updateIdea(id: IdeaId, patch: UpdateIdeaInput, expectedVersion: number): ResearchIdea {
    const current = this.requireIdea(id)
    if (current.version !== expectedVersion) {
      throw new ResearchError(
        'research/version-conflict',
        `Idea "${id}" changed since it was read (expected v${current.version}, got v${expectedVersion})`,
        { ideaId: id, expectedVersion, actualVersion: current.version },
      )
    }
    const fields = normalizeIdeaFields({
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      researchQuestion: patch.researchQuestion ?? current.researchQuestion,
      objectives: patch.objectives ?? current.objectives,
      currentSummary: patch.currentSummary ?? current.currentSummary,
    })
    const nextStatus = patch.status ?? current.status
    if (!IDEA_STATUSES.includes(nextStatus)) {
      throw new ResearchError('research/invalid-input', `unknown Idea status "${nextStatus}"`, { field: 'status' })
    }
    if (!canTransitionIdeaStatus(current.status, nextStatus)) {
      throw new ResearchError(
        'research/invalid-transition',
        `Idea status cannot move from "${current.status}" to "${nextStatus}"`,
        { ideaId: id, from: current.status, to: nextStatus },
      )
    }
    let nextParent: IdeaId | undefined
    if (patch.parentIdeaId === null) nextParent = undefined
    else if (patch.parentIdeaId !== undefined) nextParent = patch.parentIdeaId
    else nextParent = current.parentIdeaId
    if (nextParent !== undefined) {
      if (nextParent === id) {
        throw new ResearchError('research/parent-cycle', 'an Idea cannot be its own parent', { ideaId: id })
      }
      this.assertIdeaExists(nextParent)
      this.assertNoCycle(id, nextParent)
    }
    const now = Date.now()
    const nextArchivedAt = nextStatus === 'archived'
      ? current.archivedAt ?? now
      : undefined
    return this.database.transaction(() => {
      const result = this.database.connection.prepare(`
        UPDATE research_ideas
        SET title = ?, description = ?, research_question = ?, objectives_json = ?,
            status = ?, parent_idea_id = ?, current_summary = ?, updated_at = ?,
            archived_at = ?, version = ?
        WHERE id = ? AND version = ?
      `).run(
        fields.title, fields.description, fields.researchQuestion, JSON.stringify(fields.objectives),
        nextStatus, nextParent ?? null, fields.currentSummary, now,
        nextArchivedAt ?? null, current.version + 1, id, expectedVersion,
      )
      if (result.changes !== 1) {
        throw new ResearchError('research/version-conflict', `Idea "${id}" changed during the update`, {
          ideaId: id,
          expectedVersion,
        })
      }
      if (nextStatus !== current.status) {
        this.recordTimeline(id, 'idea.status_changed', 'idea', id,
          `Idea status changed from ${current.status} to ${nextStatus}`,
          { from: current.status, to: nextStatus }, now)
      }
      if (nextParent !== current.parentIdeaId) {
        this.recordTimeline(id, 'idea.parent_changed', 'idea', id,
          nextParent === undefined ? 'Idea parent cleared' : `Idea parent set to ${nextParent}`,
          { from: current.parentIdeaId ?? null, to: nextParent ?? null }, now)
      }
      if (nextStatus === current.status && nextParent === current.parentIdeaId) {
        this.recordTimeline(id, 'idea.updated', 'idea', id, 'Idea updated', { version: current.version + 1 }, now)
      }
      return this.getIdea(id) as ResearchIdea
    })
  }

  /**
   * Archive one Idea under optimistic concurrency. Archive is not deletion.
   * @param id - Idea identity.
   * @param expectedVersion - caller-observed version.
   * @param reason - optional human-readable reason saved in the timeline.
   * @returns the archived Idea.
   */
  archiveIdea(id: IdeaId, expectedVersion: number, reason?: string): ResearchIdea {
    const current = this.requireIdea(id)
    if (current.version !== expectedVersion) {
      throw new ResearchError(
        'research/version-conflict',
        `Idea "${id}" changed since it was read (expected v${current.version}, got v${expectedVersion})`,
        { ideaId: id, expectedVersion, actualVersion: current.version },
      )
    }
    if (current.status === 'archived') return current
    const now = Date.now()
    return this.database.transaction(() => {
      const result = this.database.connection.prepare(`
        UPDATE research_ideas
        SET status = 'archived', archived_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?
      `).run(now, now, id, expectedVersion)
      if (result.changes !== 1) {
        throw new ResearchError('research/version-conflict', `Idea "${id}" changed during archive`, {
          ideaId: id,
          expectedVersion,
        })
      }
      this.recordTimeline(id, 'idea.archived', 'idea', id,
        reason === undefined ? 'Idea archived' : `Idea archived: ${reason}`,
        reason === undefined ? {} : { reason }, now)
      return this.getIdea(id) as ResearchIdea
    })
  }

  /**
   * Add one directed relation, canonicalizing `related_to` and making repeats
   * idempotent while the prior edge is active.
   * @param input - endpoint ids, kind, note, and optional group.
   * @returns the active relation.
   */
  addIdeaRelation(input: AddIdeaRelationInput): ResearchIdeaRelation {
    if (!IDEA_RELATION_TYPES.includes(input.relationType)) {
      throw new ResearchError('research/relation-invalid', `unknown relation type "${input.relationType}"`, {
        relationType: input.relationType,
      })
    }
    let from = input.fromIdeaId
    let to = input.toIdeaId
    if (from === to) {
      throw new ResearchError('research/relation-invalid', 'an Idea cannot relate to itself', { ideaId: from })
    }
    this.assertIdeaExists(from)
    this.assertIdeaExists(to)
    if (input.relationType === 'related_to' && from > to) {
      const swap = from
      from = to
      to = swap
    }
    const existing = this.database.connection.prepare(`
      SELECT * FROM research_idea_relations
      WHERE from_idea_id = ? AND to_idea_id = ? AND relation_type = ? AND status = 'active'
    `).get(from, to, input.relationType)
    if (existing !== undefined) return mapRelation(existing)
    const now = Date.now()
    const id = IdeaRelationId(`rel_${randomUUID()}`)
    return this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT INTO research_idea_relations (
          id, from_idea_id, to_idea_id, relation_type, status, note, group_id,
          supersedes_relation_id, created_by, created_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)
      `).run(id, from, to, input.relationType, input.note?.trim() ?? '', input.groupId ?? null,
        input.createdBy ?? 'user', now)
      const summary = `Idea relation added: ${input.relationType}`
      const payload = { relationId: id, fromIdeaId: from, toIdeaId: to, relationType: input.relationType }
      this.recordTimeline(from, 'idea.relation_added', 'idea_relation', id, summary, payload, now)
      this.recordTimeline(to, 'idea.relation_added', 'idea_relation', id, summary, payload, now)
      return mapRelation(this.database.connection
        .prepare('SELECT * FROM research_idea_relations WHERE id = ?')
        .get(id) as SqlRow)
    })
  }

  /**
   * Supersede one relation; historical rows remain queryable.
   * @param id - relation identity.
   * @returns the superseded relation.
   */
  removeIdeaRelation(id: IdeaRelationId): ResearchIdeaRelation {
    const current = this.database.connection
      .prepare('SELECT * FROM research_idea_relations WHERE id = ?')
      .get(id)
    if (current === undefined) {
      throw new ResearchError('research/relation-not-found', `relation "${id}" not found`, { relationId: id })
    }
    const relation = mapRelation(current)
    if (relation.status !== 'active') return relation
    const now = Date.now()
    return this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE research_idea_relations SET status = 'superseded' WHERE id = ? AND status = 'active'
      `).run(id)
      const payload = {
        relationId: id,
        fromIdeaId: relation.fromIdeaId,
        toIdeaId: relation.toIdeaId,
        relationType: relation.relationType,
      }
      this.recordTimeline(relation.fromIdeaId, 'idea.relation_removed', 'idea_relation', id,
        'Idea relation superseded', payload, now)
      this.recordTimeline(relation.toIdeaId, 'idea.relation_removed', 'idea_relation', id,
        'Idea relation superseded', payload, now)
      return mapRelation(this.database.connection
        .prepare('SELECT * FROM research_idea_relations WHERE id = ?')
        .get(id) as SqlRow)
    })
  }

  /**
   * List every active or historical relation touching one Idea.
   * @param ideaId - Idea identity.
   * @returns relations ordered newest first.
   */
  listIdeaRelations(ideaId: IdeaId): ResearchIdeaRelation[] {
    return this.database.connection.prepare(`
      SELECT * FROM research_idea_relations
      WHERE from_idea_id = ? OR to_idea_id = ?
      ORDER BY created_at DESC, id ASC
    `).all(ideaId, ideaId).map(mapRelation)
  }

  /**
   * Read one Idea's append-only timeline.
   * @param ideaId - Idea identity.
   * @param limit - maximum events, clamped to 200.
   * @returns newest-first events.
   */
  listTimeline(ideaId: IdeaId, limit: number = DEFAULT_TIMELINE_LIMIT): ResearchTimelineEvent[] {
    this.assertIdeaExists(ideaId)
    const bounded = Math.min(Math.max(limit, 1), MAX_TIMELINE_LIMIT)
    return this.database.connection.prepare(`
      SELECT * FROM research_timeline_events
      WHERE idea_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(ideaId, bounded).map(mapTimeline)
  }

  /** Load one Idea or throw the stable not-found failure. */
  private requireIdea(id: IdeaId): ResearchIdea {
    const idea = this.getIdea(id)
    if (idea === undefined) {
      throw new ResearchError('research/idea-not-found', `Idea "${id}" not found`, { ideaId: id })
    }
    return idea
  }

  /** Verify one referenced Idea exists. */
  private assertIdeaExists(id: IdeaId): void {
    if (this.getIdea(id) === undefined) {
      throw new ResearchError('research/idea-not-found', `Idea "${id}" not found`, { ideaId: id })
    }
  }

  /** Reject a reparent that would form a cycle. */
  private assertNoCycle(id: IdeaId, parent: IdeaId): void {
    let cursor: IdeaId | undefined = parent
    const seen = new Set<string>()
    while (cursor !== undefined) {
      if (cursor === id) {
        throw new ResearchError('research/parent-cycle', 'Idea parent change would create a cycle', {
          ideaId: id,
          parentIdeaId: parent,
        })
      }
      if (seen.has(cursor)) {
        throw new ResearchError('research/parent-cycle', 'existing Idea parent chain contains a cycle', {
          ideaId: cursor,
        })
      }
      seen.add(cursor)
      cursor = this.getIdea(cursor)?.parentIdeaId
    }
  }

  /** Append one timeline row inside the caller's transaction. */
  private recordTimeline(
    ideaId: IdeaId,
    eventType: string,
    entityType: string | undefined,
    entityId: string | undefined,
    summary: string,
    payload: unknown,
    createdAt: number,
  ): void {
    this.database.connection.prepare(`
      INSERT INTO research_timeline_events (
        id, idea_id, event_type, entity_type, entity_id, summary, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(TimelineEventId(`tl_${randomUUID()}`), ideaId, eventType, entityType ?? null,
      entityId ?? null, summary, JSON.stringify(payload), createdAt)
  }
}
