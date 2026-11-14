import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it } from 'vitest'
import ResearchCore from '../src/index.ts'
import { ResearchDatabase } from '../src/database.ts'
import { IdeaManager } from '../src/ideas.ts'
import { ResearchOutbox } from '../src/outbox.ts'
import { ResearchSessionManager } from '../src/sessions.ts'

const roots: string[] = []
const databases: ResearchDatabase[] = []
const contexts: Context[] = []

function open(): { db: ResearchDatabase; ideas: IdeaManager; sessions: ResearchSessionManager; outbox: ResearchOutbox; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-research-sessions-'))
  roots.push(root)
  const db = new ResearchDatabase(root)
  databases.push(db)
  return { db, ideas: new IdeaManager(db), sessions: new ResearchSessionManager(db), outbox: new ResearchOutbox(db), root }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
  for (const db of databases.splice(0)) {
    try { db.close() } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('research session bindings', () => {
  it('creates a pending binding, activates it, lists it, and finalizes it', () => {
    const { ideas, sessions } = open()
    const idea = ideas.createIdea({ title: 'Idea' })
    const sessionId = SessionId('session-1')
    const pending = sessions.createPendingSession({ sessionId, ideaId: idea.id, cwd: '/tmp/research' })
    expect(pending.status).toBe('pending')
    expect(pending.ideaId).toBe(idea.id)
    expect(sessions.getCheckpoint(sessionId)).toMatchObject({
      lastSeenSeq: -1,
      lastSuccessfullyProcessedSeq: -1,
      lastSummarizedSeq: -1,
      status: 'idle',
    })

    const active = sessions.markSessionActive(sessionId, 'research')
    expect(active.status).toBe('active')
    expect(active.agentPreset).toBe('research')
    expect(sessions.listSessions(idea.id)).toHaveLength(1)
    expect(ideas.getIdea(idea.id)?.lastSessionId).toBe(sessionId)
    expect(ideas.listTimeline(idea.id).map(event => event.eventType)).toContain('idea.session_linked')

    const finalized = sessions.finalizeSession(sessionId, 'done')
    expect(finalized.status).toBe('finalized')
    expect(finalized.finalizedAt).toBeDefined()
    expect(ideas.listTimeline(idea.id).map(event => event.eventType)).toContain('idea.session_finalized')
  })

  it('records an Inbox, links and unlinks a Session without deleting history', () => {
    const { ideas, sessions } = open()
    const idea = ideas.createIdea({ title: 'Idea' })
    const sessionId = SessionId('session-inbox')
    const inbox = sessions.ensureInboxSession({ sessionId, cwd: '/tmp/inbox', origin: 'ui' })
    expect(inbox).toMatchObject({ status: 'inbox', role: 'inbox' })
    expect(inbox.ideaId).toBeUndefined()
    expect(sessions.listInboxSessions().map(session => session.sessionId)).toContain(sessionId)

    const linked = sessions.linkSessionToIdea(sessionId, idea.id)
    expect(linked).toMatchObject({ ideaId: idea.id, role: 'primary', status: 'active', bindingSource: 'manual' })
    expect(sessions.listInboxSessions()).toEqual([])
    const link = sessions.addSessionIdeaReference(sessionId, idea.id, 'knowledge_reuse', 'reuse claim')
    expect(link).toMatchObject({ ideaId: idea.id, linkType: 'knowledge_reuse', note: 'reuse claim' })
    expect(sessions.listSessionIdeaLinks(sessionId)).toHaveLength(1)

    const unlinked = sessions.unlinkSession(sessionId)
    expect(unlinked).toMatchObject({ role: 'inbox', status: 'inbox' })
    expect(unlinked.ideaId).toBeUndefined()
    expect(sessions.listInboxSessions()).toHaveLength(1)
    expect(ideas.listTimeline(idea.id).map(event => event.eventType)).toContain('idea.session_unlinked')
  })

  it('advances only the contiguous successful watermark and preserves gaps', () => {
    const { ideas, sessions } = open()
    const idea = ideas.createIdea({ title: 'Idea' })
    const sessionId = SessionId('session-checkpoint')
    sessions.createPendingSession({ sessionId, ideaId: idea.id })

    expect(sessions.recordEventsSeen(sessionId, 10)).toMatchObject({
      lastSeenSeq: 10,
      lastSuccessfullyProcessedSeq: -1,
    })
    expect(sessions.commitProcessedEvent(sessionId, 0)).toMatchObject({
      lastSuccessfullyProcessedSeq: 0,
      lastSeenSeq: 10,
    })
    expect(() => sessions.commitProcessedEvent(sessionId, 2)).toThrow(/gap/)
    expect(sessions.getCheckpoint(sessionId)?.lastSuccessfullyProcessedSeq).toBe(0)
    expect(sessions.commitProcessedEvent(sessionId, 1)).toMatchObject({ lastSuccessfullyProcessedSeq: 1 })
    expect(sessions.commitProcessedEvent(sessionId, 1).lastSuccessfullyProcessedSeq).toBe(1)
    expect(() => sessions.commitSummaryThrough(sessionId, 3)).toThrow(/cannot exceed/)
    expect(sessions.commitSummaryThrough(sessionId, 1).lastSummarizedSeq).toBe(1)
    const failed = sessions.markCheckpointFailed(sessionId, 'llm unavailable')
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastSuccessfullyProcessedSeq: 1 })
    expect(sessions.markInheritedPrefixProcessed(sessionId, 2).lastSuccessfullyProcessedSeq).toBe(2)
  })

  it('persists bindings and watermarks across a database reopen', () => {
    const { db, ideas, sessions, root } = open()
    const idea = ideas.createIdea({ title: 'Persisted' })
    const sessionId = SessionId('session-persisted')
    sessions.createPendingSession({ sessionId, ideaId: idea.id })
    sessions.recordEventsSeen(sessionId, 0)
    sessions.commitProcessedEvent(sessionId, 0)
    db.close()
    databases.splice(databases.indexOf(db), 1)
    const reopened = new ResearchDatabase(root)
    databases.push(reopened)
    const reopenedSessions = new ResearchSessionManager(reopened)
    expect(reopenedSessions.getSession(sessionId)).toMatchObject({ ideaId: idea.id, status: 'pending' })
    expect(reopenedSessions.getCheckpoint(sessionId)).toMatchObject({
      lastSeenSeq: 0,
      lastSuccessfullyProcessedSeq: 0,
    })
  })
})

describe('research outbox', () => {
  it('enqueues idempotently, claims, completes, retries, and recovers', () => {
    const { outbox } = open()
    const input = {
      topic: 'research/session-event',
      aggregateType: 'research_session',
      aggregateId: 'session-1',
      idempotencyKey: 'key-1',
      payload: { sessionId: 'session-1', seq: 0, type: 'turn/start', time: 1 },
    }
    expect(outbox.enqueue(input)).toBe(true)
    expect(outbox.enqueue(input)).toBe(false)
    expect(outbox.pendingCount()).toBe(1)
    expect(outbox.nextDueAt()).toBeTypeOf('number')

    const [claimed] = outbox.claimPending(10)
    expect(claimed).toMatchObject({ idempotencyKey: 'key-1', status: 'pending', attempts: 0 })
    expect(outbox.pendingCount()).toBe(0)
    outbox.retry(claimed!.id, 'retry later', 0, false)
    expect(outbox.pendingCount()).toBe(1)
    const [again] = outbox.claimPending(10)
    outbox.complete(again!.id)
    expect(outbox.get(again!.id)?.status).toBe('done')

    expect(outbox.enqueue({ ...input, idempotencyKey: 'key-2' })).toBe(true)
    const [processing] = outbox.claimPending(10)
    expect(outbox.recoverProcessing()).toBe(1)
    expect(outbox.get(processing!.id)?.status).toBe('pending')
  })
})

describe('research event processing', () => {
  it('observes events idempotently, advances success in the outbox transaction, and tolerates gaps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-research-events-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ResearchCore, { root })
    const core = ctx.researchCore
    const idea = core.createIdea({ title: 'Event Idea' })
    const sessionId = SessionId('session-events')
    core.sessionBindings.createPendingSession({ sessionId, ideaId: idea.id })
    core.sessionBindings.markSessionActive(sessionId)

    const event = (seq: number, type: 'turn/start' | 'turn/end'): SessionEvent => ({
      type,
      seq,
      time: seq + 1,
      data: type === 'turn/start' ? { turn: 1 } : { turn: 1, reason: { kind: 'completed' } },
    }) as SessionEvent

    core.events.observe(sessionId, event(0, 'turn/start'))
    await core.events.flush()
    expect(core.sessionBindings.getCheckpoint(sessionId)).toMatchObject({
      lastSeenSeq: 0,
      lastSuccessfullyProcessedSeq: 0,
      status: 'idle',
    })
    expect(core.outbox.pendingCount()).toBe(0)

    core.events.observe(sessionId, event(0, 'turn/start'))
    await core.events.flush()
    expect(core.sessionBindings.getCheckpoint(sessionId)?.lastSuccessfullyProcessedSeq).toBe(0)

    core.events.observe(sessionId, event(2, 'turn/end'))
    await core.events.flush()
    expect(core.sessionBindings.getCheckpoint(sessionId)?.lastSuccessfullyProcessedSeq).toBe(0)

    core.database.connection.prepare("UPDATE research_outbox SET next_attempt_at = 0 WHERE status = 'pending'").run()
    core.events.observe(sessionId, event(1, 'turn/end'))
    core.database.connection.prepare("UPDATE research_outbox SET next_attempt_at = 0 WHERE status = 'pending'").run()
    await core.events.flush()
    expect(core.sessionBindings.getCheckpoint(sessionId)).toMatchObject({
      lastSeenSeq: 2,
      lastSuccessfullyProcessedSeq: 2,
    })
  })
  it('upgrades an existing Phase 1 database through the v2 migration', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-research-upgrade-'))
    roots.push(root)
    mkdirSync(root, { recursive: true })
    const legacy = new DatabaseSync(join(root, 'database.sqlite'))
    legacy.exec(`
      CREATE TABLE research_schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO research_schema_migrations VALUES (1, 'ideas', 'legacy', 1);
      CREATE TABLE research_ideas (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE research_idea_relations (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE research_timeline_events (id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 1;
    `)
    legacy.close()
    const upgraded = new ResearchDatabase(root)
    databases.push(upgraded)
    expect(upgraded.connection.prepare('SELECT version FROM research_schema_migrations ORDER BY version').all()
      .map(row => row['version'])).toEqual([1, 2])
    const ideaColumns = upgraded.connection.prepare('PRAGMA table_info(research_ideas)').all().map(row => row['name'])
    expect(ideaColumns).toEqual(expect.arrayContaining(['workspace_id', 'workspace_path', 'last_session_id']))
    const timelineColumns = upgraded.connection.prepare('PRAGMA table_info(research_timeline_events)').all().map(row => row['name'])
    expect(timelineColumns).toContain('session_id')
    expect(upgraded.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research_outbox'").get())
      .toMatchObject({ name: 'research_outbox' })
  })

  it('processes a pending outbox row after a simulated crash and does not duplicate it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-research-crash-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ResearchCore, { root })
    const core = ctx.researchCore
    const idea = core.createIdea({ title: 'Crash Idea' })
    const sessionId = SessionId('session-crash')
    core.sessionBindings.createPendingSession({ sessionId, ideaId: idea.id })
    core.sessionBindings.recordEventsSeen(sessionId, 0)
    core.outbox.enqueue({
      topic: 'research/session-event',
      aggregateType: 'research_session',
      aggregateId: sessionId,
      idempotencyKey: `session-event:${sessionId}:0`,
      payload: { sessionId, seq: 0, type: 'turn/start', time: 1 },
    })
    await core.events.pump()
    expect(core.sessionBindings.getCheckpoint(sessionId)?.lastSuccessfullyProcessedSeq).toBe(0)
    expect(core.outbox.pendingCount()).toBe(0)
    core.outbox.enqueue({
      topic: 'research/session-event',
      aggregateType: 'research_session',
      aggregateId: sessionId,
      idempotencyKey: `session-event:${sessionId}:0`,
      payload: { sessionId, seq: 0, type: 'turn/start', time: 1 },
    })
    await core.events.pump()
    expect(core.sessionBindings.getCheckpoint(sessionId)?.lastSuccessfullyProcessedSeq).toBe(0)
  })

})
