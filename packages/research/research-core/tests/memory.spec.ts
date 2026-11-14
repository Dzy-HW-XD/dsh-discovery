import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it } from 'vitest'
import ResearchCore, {
  IdeaId,
  type CreateMemoryInput,
} from '../src/index.ts'
import { ResearchDatabase } from '../src/database.ts'

const roots: string[] = []
const contexts: Context[] = []

async function bench(): Promise<{
  root: string
  core: ResearchCore
  ideaId: IdeaId
  sessionId: SessionId
}> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-research-memory-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ResearchCore, { root })
  const core = ctx.researchCore
  const idea = core.createIdea({ title: 'Memory Idea', researchQuestion: 'What persists?' })
  const sessionId = SessionId('session-memory')
  core.sessionBindings.createPendingSession({ sessionId, ideaId: idea.id })
  core.sessionBindings.markSessionActive(sessionId)
  return { root, core, ideaId: idea.id, sessionId }
}

const review = { changeReason: 'reviewed', changeSource: 'review' as const, createdBy: 'user' }

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('research memory store', () => {
  it('creates a versioned memory with Session provenance and separates epistemic from lifecycle', async () => {
    const { core, ideaId, sessionId } = await bench()
    const memory = core.memory.createMemory({
      ideaId,
      memoryType: 'fact',
      title: 'Clamping reduces propagation',
      content: 'Bounded activation reduced observed propagation in the mock experiment.',
      epistemicStatus: 'verified',
      lifecycleStatus: 'active',
      confidence: 0.8,
      sourceSessionId: sessionId,
      sourceEventSeqs: [3],
      sources: [{ sessionId, eventSeq: 3, quote: 'observed reduction' }],
    })
    expect(memory).toMatchObject({
      memoryType: 'fact',
      epistemicStatus: 'verified',
      lifecycleStatus: 'active',
      confidence: 0.8,
      version: 1,
      sourceSessionId: sessionId,
    })
    expect(memory.sources).toHaveLength(1)
    expect(memory.relations).toEqual([])
    expect(core.memory.listVersions(ideaId, memory.id)).toHaveLength(1)
    expect(core.memory.getMemory(ideaId, memory.id)).toMatchObject({ id: memory.id })
  })

  it('appends immutable versions for updates and preserves the old snapshot', async () => {
    const { core, ideaId, sessionId } = await bench()
    const memory = core.memory.createMemory({
      ideaId,
      memoryType: 'hypothesis',
      title: 'H1',
      content: 'Attention is more sensitive to bit flips.',
      epistemicStatus: 'inferred',
      sourceSessionId: sessionId,
    })
    const updated = core.memory.updateMemory(ideaId, memory.id, {
      epistemicStatus: 'supported',
      content: 'Attention is more sensitive under BF16.',
      lifecycleStatus: 'active',
    }, { ...review, sourceSessionId: sessionId, sourceEventSeq: 5 })
    expect(updated).toMatchObject({
      epistemicStatus: 'supported',
      lifecycleStatus: 'active',
      version: 2,
    })
    expect(updated.promotedAt).toBeTypeOf('number')
    const versions = core.memory.listVersions(ideaId, memory.id)
    expect(versions.map(version => version.version)).toEqual([2, 1])
    expect(versions[1]?.changeReason).toBe('created')
    expect(JSON.stringify(versions[1]?.snapshot)).toContain('Attention is more sensitive to bit flips.')
    expect(versions[0]?.changeReason).toBe('reviewed')
  })

  it('enforces evidence for facts and explicit Session provenance for preferences', async () => {
    const { core, ideaId, sessionId } = await bench()
    expect(() => core.memory.createMemory({
      ideaId,
      memoryType: 'fact',
      title: 'Unsupported fact',
      content: 'No source at all.',
      epistemicStatus: 'verified',
    })).toThrow(/requires provenance/)
    const preference = core.memory.createMemory({
      ideaId,
      memoryType: 'preference',
      title: 'Work preference',
      content: 'User prefers architecture analysis before coding.',
      epistemicStatus: 'verified',
      sourceSessionId: sessionId,
      sources: [{ sessionId, eventSeq: 2 }],
    })
    expect(preference.memoryType).toBe('preference')
    expect(() => core.memory.createMemory({
      ideaId,
      memoryType: 'preference',
      title: 'Inferred preference',
      content: 'User probably likes diagrams.',
    })).toThrow(/requires a Session source/)
    const other = core.createIdea({ title: 'Other idea' })
    const otherSession = SessionId('session-other')
    core.sessionBindings.createPendingSession({ sessionId: otherSession, ideaId: other.id })
    expect(() => core.memory.createMemory({
      ideaId,
      memoryType: 'hypothesis',
      title: 'Cross idea',
      content: 'Wrong Session.',
      sourceSessionId: otherSession,
    })).toThrow(/another Idea/)
  })

  it('deduplicates exact content and attaches new provenance instead of duplicating', async () => {
    const { core, ideaId, sessionId } = await bench()
    const input: CreateMemoryInput = {
      ideaId,
      memoryType: 'finding',
      title: 'Finding',
      content: 'The same result.',
      epistemicStatus: 'supported',
      sourceSessionId: sessionId,
      sources: [{ sessionId, eventSeq: 1 }],
    }
    const first = core.memory.createMemory(input)
    const second = core.memory.createMemory(input)
    expect(second.id).toBe(first.id)
    const expanded = core.memory.createMemory({
      ...input,
      sources: [{ sessionId, eventSeq: 2 }],
    })
    expect(expanded.id).toBe(first.id)
    expect(core.memory.getMemory(ideaId, first.id)?.sources).toHaveLength(2)
    expect(core.memory.listVersions(ideaId, first.id)).toHaveLength(1)
  })

  it('enforces lifecycle transitions without deleting memory history', async () => {
    const { core, ideaId, sessionId } = await bench()
    const memory = core.memory.createMemory({
      ideaId,
      memoryType: 'decision',
      title: 'No dual-bit study',
      content: 'Phase one excludes dual-bit flips.',
      epistemicStatus: 'verified',
      sourceSessionId: sessionId,
    })
    const archived = core.memory.archiveMemory(ideaId, memory.id, { ...review, changeReason: 'superseded decision' })
    expect(archived).toMatchObject({ lifecycleStatus: 'archived', version: 2 })
    expect(archived.archivedAt).toBeTypeOf('number')
    const restored = core.memory.restoreMemory(ideaId, memory.id, 'active', { ...review, changeReason: 'restored' })
    expect(restored).toMatchObject({ lifecycleStatus: 'active', version: 3 })
    expect(restored.archivedAt).toBeUndefined()
    expect(() => core.memory.updateMemory(ideaId, memory.id, { lifecycleStatus: 'candidate' }, review))
      .toThrow(/cannot move from active to candidate/)
    expect(core.memory.listVersions(ideaId, memory.id)).toHaveLength(3)
  })

  it('validates memory relations and preserves both sides of a conflict', async () => {
    const { core, ideaId, sessionId } = await bench()
    const a = core.memory.createMemory({
      ideaId, memoryType: 'hypothesis', title: 'H supported', content: 'H is supported.',
      epistemicStatus: 'supported', sourceSessionId: sessionId,
    })
    const b = core.memory.createMemory({
      ideaId, memoryType: 'hypothesis', title: 'H refuted', content: 'H is refuted under condition X.',
      epistemicStatus: 'refuted', sourceSessionId: sessionId,
    })
    const relation = core.memory.addRelation(ideaId, a.id, {
      entityType: 'memory', entityId: b.id, relationType: 'conflicts_with', note: 'same hypothesis',
    })
    expect(relation.relationType).toBe('conflicts_with')
    expect(core.memory.getMemory(ideaId, a.id)?.relations).toHaveLength(1)
    expect(() => core.memory.addRelation(ideaId, a.id, {
      entityType: 'claim', entityId: 'missing', relationType: 'about',
    })).toThrow(/not found/)
    const conflict = core.memory.createConflict({
      ideaId, memoryAId: a.id, memoryBId: b.id, conflictType: 'contradiction',
      description: 'Supported and refuted versions', detectedBy: 'test',
    })
    expect(conflict.status).toBe('open')
    expect(core.memory.createConflict({
      ideaId, memoryAId: a.id, memoryBId: b.id, conflictType: 'contradiction',
      description: 'duplicate', detectedBy: 'test',
    }).id).toBe(conflict.id)
    expect(core.memory.getMemory(ideaId, a.id)?.lifecycleStatus).toBe('candidate')
    expect(core.memory.getMemory(ideaId, b.id)?.lifecycleStatus).toBe('candidate')
    const resolved = core.memory.resolveConflict(ideaId, conflict.id, 'resolved', 'Condition X explains both')
    expect(resolved).toMatchObject({ status: 'resolved', resolution: 'Condition X explains both' })
    expect(() => core.memory.resolveConflict(ideaId, conflict.id, 'dismissed', 'again'))
      .toThrow(/already closed/)
    expect(core.memory.listVersions(ideaId, a.id)).toHaveLength(1)
  })

  it('records retrieval selections idempotently and marks memory use once', async () => {
    const { core, ideaId, sessionId } = await bench()
    const memory = core.memory.createMemory({
      ideaId, memoryType: 'goal', title: 'Goal', content: 'Study GPU SDC.',
      epistemicStatus: 'verified', sourceSessionId: sessionId,
    })
    const input = {
      sessionId, ideaId, turn: 1, step: 1, memoryId: memory.id,
      rank: 0, layer: 'core' as const, reason: 'goal', tokenEstimate: 12,
    }
    const first = core.memory.recordSelection(input)
    const second = core.memory.recordSelection(input)
    expect(second.id).toBe(first.id)
    expect(core.memory.listSelections(ideaId, sessionId)).toHaveLength(1)
    expect(core.memory.getMemory(ideaId, memory.id)?.useCount).toBe(1)
    expect(() => core.memory.recordSelection({ ...input, turn: 2, tokenEstimate: -1 }))
      .toThrow(/non-negative integers/)
  })

  it('isolates memories, histories, conflicts, and selections by Idea', async () => {
    const { core, ideaId, sessionId } = await bench()
    const other = core.createIdea({ title: 'Other memory idea' })
    const memory = core.memory.createMemory({
      ideaId, memoryType: 'goal', title: 'Only this idea', content: 'Scoped goal.',
      epistemicStatus: 'verified', sourceSessionId: sessionId,
    })
    expect(core.memory.listMemories(other.id)).toEqual([])
    expect(core.memory.getMemory(other.id, memory.id)).toBeUndefined()
    expect(() => core.memory.listVersions(other.id, memory.id)).toThrow(/not found/)
    expect(core.memory.listConflicts(other.id)).toEqual([])
    expect(core.memory.listSelections(other.id)).toEqual([])
    expect(core.memory.counts(ideaId)).toMatchObject({ total: 1 })
    expect(core.memory.counts(ideaId).byLifecycle.candidate).toBe(1)
    const otherSession = SessionId('session-other-memory')
    core.sessionBindings.createPendingSession({ sessionId: otherSession, ideaId: other.id })
    const otherMemory = core.memory.createMemory({
      ideaId: other.id, memoryType: 'goal', title: 'Other goal', content: 'Other goal.',
      epistemicStatus: 'verified', sourceSessionId: otherSession,
    })
    expect(() => core.memory.createConflict({
      ideaId, memoryAId: memory.id, memoryBId: otherMemory.id, conflictType: 'contradiction',
      description: 'cross idea', detectedBy: 'test',
    })).toThrow(/not found/)
  })

  it('rolls back when a validation or transaction step fails', async () => {
    const { core, ideaId, sessionId } = await bench()
    const memory = core.memory.createMemory({
      ideaId, memoryType: 'hypothesis', title: 'Base', content: 'Base content.',
      epistemicStatus: 'inferred', sourceSessionId: sessionId,
    })
    expect(() => core.memory.updateMemory(ideaId, memory.id, {
      content: 'Should not persist',
      sources: [{ sessionId, eventSeq: 9 }],
      relations: [{ entityType: 'claim', entityId: 'missing', relationType: 'about' }],
    }, review)).toThrow(/not found/)
    expect(core.memory.getMemory(ideaId, memory.id)).toMatchObject({
      content: 'Base content.', version: 1,
    })
    expect(core.memory.getMemory(ideaId, memory.id)?.sources).toHaveLength(0)
  })
})

describe('research memory migration v4', () => {
  it('creates the memory schema from a fresh database and reopens idempotently', async () => {
    const { root, core, ideaId, sessionId } = await bench()
    const tables = core.database.connection.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'research_memory%' ORDER BY name
    `).all().map(row => row['name'])
    expect(tables).toEqual([
      'research_memory_conflicts', 'research_memory_records', 'research_memory_relations',
      'research_memory_selections', 'research_memory_sources', 'research_memory_versions',
    ])
    expect(core.database.connection.prepare('SELECT version FROM research_schema_migrations ORDER BY version').all()
      .map(row => row['version'])).toEqual([1, 2, 3, 4])
    core.memory.createMemory({
      ideaId, memoryType: 'goal', title: 'Persisted', content: 'Survives reopen.',
      epistemicStatus: 'verified', sourceSessionId: sessionId,
    })
    const reopened = new ResearchDatabase(root)
    expect(reopened.connection.prepare('SELECT COUNT(*) AS count FROM research_memory_records').get())
      .toMatchObject({ count: 1 })
    expect(reopened.connection.prepare('SELECT version FROM research_schema_migrations ORDER BY version').all()
      .map(row => row['version'])).toEqual([1, 2, 3, 4])
    reopened.close()
  })

  it('upgrades a minimal v3 database and preserves existing rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-research-memory-upgrade-'))
    roots.push(root)
    const legacy = new DatabaseSync(join(root, 'database.sqlite'))
    legacy.exec(`
      CREATE TABLE research_schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO research_schema_migrations VALUES (1, 'ideas', 'legacy', 1);
      INSERT INTO research_schema_migrations VALUES (2, 'sessions', 'legacy', 2);
      INSERT INTO research_schema_migrations VALUES (3, 'artifacts', 'legacy', 3);
      CREATE TABLE research_ideas (id TEXT PRIMARY KEY) STRICT;
      INSERT INTO research_ideas VALUES ('idea_legacy');
      CREATE TABLE research_sessions (session_id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE research_timeline_events (id TEXT PRIMARY KEY, idea_id TEXT NOT NULL) STRICT;
      PRAGMA user_version = 3;
    `)
    legacy.close()
    const upgraded = new ResearchDatabase(root)
    expect(upgraded.connection.prepare('SELECT version FROM research_schema_migrations ORDER BY version').all()
      .map(row => row['version'])).toEqual([1, 2, 3, 4])
    expect(upgraded.connection.prepare('SELECT id FROM research_ideas').all().map(row => row['id'])).toEqual(['idea_legacy'])
    expect(upgraded.connection.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research_memory_selections'",
    ).get()).toMatchObject({ name: 'research_memory_selections' })
    upgraded.close()
  })

  it('rolls back v4 when the migration cannot complete', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-research-memory-failure-'))
    roots.push(root)
    const legacy = new DatabaseSync(join(root, 'database.sqlite'))
    legacy.exec(`
      CREATE TABLE research_schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO research_schema_migrations VALUES (1, 'ideas', 'legacy', 1);
      INSERT INTO research_schema_migrations VALUES (2, 'sessions', 'legacy', 2);
      INSERT INTO research_schema_migrations VALUES (3, 'artifacts', 'legacy', 3);
      CREATE TABLE research_memory_records (id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 3;
    `)
    legacy.close()
    expect(() => new ResearchDatabase(root)).toThrow()
    const inspect = new DatabaseSync(join(root, 'database.sqlite'))
    expect(inspect.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 })
    expect(inspect.prepare('SELECT version FROM research_schema_migrations ORDER BY version').all()
      .map(row => row['version'])).toEqual([1, 2, 3])
    inspect.close()
  })
})
