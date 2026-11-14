import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchDatabase } from '../src/database.ts'
import { ResearchError } from '../src/errors.ts'
import { IdeaManager } from '../src/ideas.ts'
import { IDEA_STATUS_TRANSITIONS, IdeaId, type IdeaStatus } from '../src/types.ts'

const roots: string[] = []
const databases: ResearchDatabase[] = []

function open(): { db: ResearchDatabase; ideas: IdeaManager; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-research-core-'))
  roots.push(root)
  const db = new ResearchDatabase(root)
  databases.push(db)
  return { db, ideas: new IdeaManager(db), root }
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    try { db.close() } catch { /* already closed by a test */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('research-core ideas', () => {
  it('creates, reads, updates, and persists an Idea across a reopen', () => {
    const { db, ideas, root } = open()
    const created = ideas.createIdea({
      title: 'Bounded Activation',
      description: 'Study bounded activation and SDC',
      researchQuestion: 'Does clamping reduce SDC propagation?',
      objectives: ['Review literature', 'Build a taxonomy'],
    })
    expect(created.status).toBe('seed')
    expect(created.version).toBe(1)
    expect(ideas.getIdea(created.id)?.title).toBe('Bounded Activation')
    expect(ideas.listIdeas()).toHaveLength(1)

    const updated = ideas.updateIdea(created.id, {
      currentSummary: 'Initial taxonomy drafted',
      status: 'exploring',
    }, created.version)
    expect(updated.status).toBe('exploring')
    expect(updated.version).toBe(2)
    expect(updated.currentSummary).toBe('Initial taxonomy drafted')

    db.close()
    databases.splice(databases.indexOf(db), 1)
    const reopened = new ResearchDatabase(root)
    databases.push(reopened)
    const reopenedIdeas = new IdeaManager(reopened)
    const restored = reopenedIdeas.getIdea(created.id)
    expect(restored).toMatchObject({
      title: 'Bounded Activation',
      status: 'exploring',
      currentSummary: 'Initial taxonomy drafted',
      version: 2,
    })
    expect(reopenedIdeas.listTimeline(created.id).map(event => event.eventType))
      .toEqual(expect.arrayContaining(['idea.created', 'idea.status_changed']))
  })

  it('enforces optimistic concurrency and the explicit transition table', () => {
    const { ideas } = open()
    const idea = ideas.createIdea({ title: 'Versioned Idea' })
    expect(() => ideas.updateIdea(idea.id, { title: 'stale' }, 99)).toThrow(ResearchError)
    try {
      ideas.updateIdea(idea.id, { title: 'stale' }, 99)
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchError)
      expect((error as ResearchError).code).toBe('research/version-conflict')
    }
    expect(() => ideas.updateIdea(idea.id, { status: 'mature' }, 1)).toThrow(/cannot move/)
    expect(ideas.updateIdea(idea.id, { status: 'exploring' }, 1).status).toBe('exploring')
    expect(ideas.updateIdea(idea.id, { status: 'seed' }, 2).status).toBe('seed')
    expect(IDEA_STATUS_TRANSITIONS.mature).toContain('developing')
  })

  it('archives without deleting and allows restoration through the status table', () => {
    const { ideas } = open()
    const idea = ideas.createIdea({ title: 'Archive Me' })
    const archived = ideas.archiveIdea(idea.id, 1, 'superseded direction')
    expect(archived.status).toBe('archived')
    expect(archived.archivedAt).toBeDefined()
    expect(ideas.listIdeas()).toEqual([])
    expect(ideas.listIdeas({ includeArchived: true })).toHaveLength(1)
    const restored = ideas.updateIdea(idea.id, { status: 'exploring' }, archived.version)
    expect(restored.status).toBe('exploring')
    expect(restored.archivedAt).toBeUndefined()
    expect(ideas.listTimeline(idea.id).map(event => event.eventType))
      .toEqual(expect.arrayContaining(['idea.archived', 'idea.status_changed']))
  })

  it('keeps one authoritative parent edge and rejects cycles', () => {
    const { ideas } = open()
    const parent = ideas.createIdea({ title: 'Parent' })
    const child = ideas.createIdea({ title: 'Child', parentIdeaId: parent.id })
    const grandchild = ideas.createIdea({ title: 'Grandchild', parentIdeaId: child.id })
    expect(child.parentIdeaId).toBe(parent.id)
    expect(ideas.parentOf(child.id)?.id).toBe(parent.id)
    expect(ideas.parentOf(parent.id)).toBeUndefined()
    expect(ideas.childrenOf(parent.id).map(idea => idea.id)).toEqual([child.id])
    expect(ideas.listIdeas({ parentIdeaId: parent.id }).map(idea => idea.id)).toEqual([child.id])
    expect(() => ideas.updateIdea(parent.id, { parentIdeaId: grandchild.id }, parent.version))
      .toThrow(/cycle/)
    const detached = ideas.updateIdea(grandchild.id, { parentIdeaId: null }, grandchild.version)
    expect(detached.parentIdeaId).toBeUndefined()
  })

  it('stores directed relations, canonicalizes related_to, and supersedes removals', () => {
    const { ideas } = open()
    const a = ideas.createIdea({ title: 'A' })
    const b = ideas.createIdea({ title: 'B' })
    const c = ideas.createIdea({ title: 'C' })

    const related = ideas.addIdeaRelation({
      fromIdeaId: b.id,
      toIdeaId: a.id,
      relationType: 'related_to',
      note: 'same mechanism',
    })
    expect(related.fromIdeaId < related.toIdeaId).toBe(true)
    expect(ideas.addIdeaRelation({
      fromIdeaId: a.id,
      toIdeaId: b.id,
      relationType: 'related_to',
    }).id).toBe(related.id)

    const derived = ideas.addIdeaRelation({
      fromIdeaId: c.id,
      toIdeaId: a.id,
      relationType: 'derived_from',
      groupId: 'g1',
    })
    expect(derived.relationType).toBe('derived_from')
    expect(derived.fromIdeaId).toBe(c.id)
    expect(derived.toIdeaId).toBe(a.id)
    expect(ideas.addIdeaRelation({
      fromIdeaId: c.id,
      toIdeaId: b.id,
      relationType: 'merged_from',
      groupId: 'g1',
    }).relationType).toBe('merged_from')

    expect(ideas.listIdeaRelations(a.id)).toHaveLength(2)
    expect(ideas.listIdeaRelations(b.id).map(relation => relation.relationType))
      .toEqual(expect.arrayContaining(['related_to', 'merged_from']))
    const removed = ideas.removeIdeaRelation(derived.id)
    expect(removed.status).toBe('superseded')
    expect(ideas.removeIdeaRelation(derived.id).status).toBe('superseded')
    expect(ideas.listIdeaRelations(a.id).find(relation => relation.id === derived.id)?.status)
      .toBe('superseded')
  })

  it('rejects self-relations and invalid references', () => {
    const { ideas } = open()
    const a = ideas.createIdea({ title: 'A' })
    expect(() => ideas.addIdeaRelation({ fromIdeaId: a.id, toIdeaId: a.id, relationType: 'references' }))
      .toThrow(/itself/)
    expect(() => ideas.addIdeaRelation({
      fromIdeaId: a.id,
      toIdeaId: IdeaId('idea_missing'),
      relationType: 'references',
    })).toThrow(/not found/)
  })

  it('records an append-only timeline for create/update/archive/relation changes', () => {
    const { ideas } = open()
    const a = ideas.createIdea({ title: 'A' })
    const b = ideas.createIdea({ title: 'B' })
    ideas.addIdeaRelation({ fromIdeaId: a.id, toIdeaId: b.id, relationType: 'references' })
    ideas.updateIdea(a.id, { status: 'exploring' }, a.version)
    const types = ideas.listTimeline(a.id).map(event => event.eventType)
    expect(types).toEqual(expect.arrayContaining(['idea.created', 'idea.relation_added', 'idea.status_changed']))
    expect(types.indexOf('idea.created')).toBeGreaterThan(types.indexOf('idea.status_changed'))
  })

  it('accepts the full status vocabulary and exposes a stable invalid-status failure', () => {
    const { ideas } = open()
    const statuses: IdeaStatus[] = ['seed', 'exploring', 'developing', 'reviewing', 'mature', 'archived']
    for (const status of statuses) {
      const idea = ideas.createIdea({ title: `Idea ${status}`, status })
      expect(idea.status).toBe(status)
    }
  })
  it('opens an existing v1 database without replaying the migration', () => {
    const { db, ideas, root } = open()
    ideas.createIdea({ title: 'Persisted' })
    db.close()
    databases.splice(databases.indexOf(db), 1)
    const reopened = new ResearchDatabase(root)
    databases.push(reopened)
    const rows = reopened.connection
      .prepare('SELECT version, name FROM research_schema_migrations ORDER BY version')
      .all()
    expect(rows).toHaveLength(5)
    expect(rows[0]).toMatchObject({ version: 1, name: 'ideas' })
    expect(rows[1]).toMatchObject({ version: 2, name: 'sessions' })
    expect(rows[2]).toMatchObject({ version: 3, name: 'artifacts' })
    expect(rows[3]).toMatchObject({ version: 4, name: 'memory' })
    expect(rows[4]).toMatchObject({ version: 5, name: 'session-summaries' })
    expect(reopened.connection.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('research_sessions','research_session_idea_links','research_session_checkpoints','research_outbox') ORDER BY name",
    ).all().map(row => row['name'])).toEqual([
      'research_outbox', 'research_session_checkpoints', 'research_session_idea_links', 'research_sessions',
    ])
    expect(new IdeaManager(reopened).listIdeas()).toHaveLength(1)
  })

})
