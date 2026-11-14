import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import ResearchCore, { IdeaId, ResearchDatabase } from '@deepseek-ai/dsh-research-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SummaryEngine, SummaryCoordinator, type SummarySessionEvent } from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

async function bench(): Promise<{ core: ResearchCore; ideaId: IdeaId; sessionId: SessionId; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-summary-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ResearchCore, { root })
  const core = ctx.researchCore
  const idea = core.createIdea({ title: 'Summary Idea', researchQuestion: 'Does the summary preserve research state?' })
  const sessionId = SessionId('session-summary')
  core.sessionBindings.createPendingSession({ sessionId, ideaId: idea.id })
  core.sessionBindings.markSessionActive(sessionId)
  return { core, ideaId: idea.id, sessionId, root }
}

function userEvent(seq: number, text: string): SummarySessionEvent {
  return {
    seq,
    type: 'user/message',
    time: seq + 1,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

function turnEnd(seq: number): SummarySessionEvent {
  return { seq, type: 'turn/end', time: seq + 1, data: { turn: 1, reason: { kind: 'completed' } } }
}

function asSessionEvent(event: SummarySessionEvent): SessionEvent {
  return event as SessionEvent
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('deterministic summary engine', () => {
  it('references canonical claims, evidence, hypotheses, decisions, questions, and artifacts', async () => {
    const { core, ideaId, sessionId } = await bench()
    const provenance = { originSessionId: sessionId, originEventSeq: 1, originToolCallId: 'call-1' }
    const source = core.artifacts.createSource(ideaId, { sourceType: 'paper', title: 'GPU SDC paper' })
    const claim = core.artifacts.createClaim(ideaId, {
      statement: 'BF16 GEMM shows observable output drift.',
      epistemicStatus: 'reported',
      sourceIds: [source.id],
    }, provenance)
    const evidence = core.artifacts.createEvidence(ideaId, {
      claimId: claim.id,
      sourceId: source.id,
      evidenceType: 'supports',
      quote: 'observed drift',
    }, provenance)
    const validated = core.artifacts.createHypothesis(ideaId, {
      title: 'Clamping helps', description: 'Clamping reduces drift.',
    }, provenance)
    core.artifacts.updateHypothesis(validated.id, { status: 'supported' }, 'evidence observed')
    const rejected = core.artifacts.createHypothesis(ideaId, {
      title: 'Dual-bit effect', description: 'Dual-bit flips dominate.',
    }, provenance)
    core.artifacts.updateHypothesis(rejected.id, { status: 'rejected' }, 'not reproducible')
    core.artifacts.createQuestion(ideaId, { question: 'Does MTP amplify drift?' }, provenance)
    core.artifacts.createGap(ideaId, {
      gapType: 'knowledge_gap', gapDescription: 'No attention benchmark exists.',
    }, provenance)
    core.artifacts.createDecision(ideaId, {
      title: 'Focus on GEMM', decision: 'Study GEMM before attention.',
    }, provenance)
    const discovery = core.artifacts.createDiscovery(ideaId, {
      discoveryType: 'knowledge_bridge', description: 'GEMM and attention share accumulation paths.',
    }, provenance)
    core.artifacts.createArtifact(ideaId, {
      artifactType: 'markdown', title: 'Report', content: '# Findings',
    }, provenance)
    const engine = new SummaryEngine(core)
    const generated = engine.generate({
      sessionId, ideaId, startSeq: 0, endSeq: 10,
      events: [userEvent(0, 'Study GPU Tensor Core bit flips.'), turnEnd(1)],
    })
    expect(generated.objective).toBe('Study GPU Tensor Core bit flips.')
    expect(generated.keyFindings.map(item => item.entityId)).toContain(claim.id)
    expect(generated.hypothesesValidated.map(item => item.entityId)).toContain(validated.id)
    expect(generated.hypothesesRejected.map(item => item.entityId)).toContain(rejected.id)
    expect(generated.failedAttempts.map(item => item.entityId)).toContain(rejected.id)
    expect(generated.keyFindings.map(item => item.entityId)).toContain(discovery.id)
    expect(generated.sourceReferences.some(item => item.entityId === source.id)).toBe(true)
    expect(generated.sourceReferences.some(item => item.entityId === evidence.id)).toBe(true)
    expect(generated.unresolvedQuestions).toHaveLength(2)
    expect(generated.nextSteps.length).toBeGreaterThan(0)
    expect(generated.summary).toContain('Objective:')
    expect(generated.inputHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('produces a minimal summary for an empty Session without inventing findings', async () => {
    const { core, ideaId, sessionId } = await bench()
    const generated = new SummaryEngine(core).generate({
      sessionId, ideaId, startSeq: 0, endSeq: 0, events: [],
    })
    expect(generated.objective).toBe('Does the summary preserve research state?')
    expect(generated.keyFindings).toEqual([])
    expect(generated.summary).toContain('No research entities were produced')
  })
})

describe('summary coordinator lifecycle', () => {
  it('turns a committed turn/end event into a summary and is idempotent', async () => {
    const { core, ideaId, sessionId } = await bench()
    const events: SummarySessionEvent[] = [userEvent(0, 'Study GPU Tensor Core bit flips.'), turnEnd(1)]
    const reader = { readSession: vi.fn(async () => ({ inheritedEventCount: 0, events })) }
    const coordinator = new SummaryCoordinator({ core, reader, logger: { warn: () => {} } })
    core.events.observe(sessionId, asSessionEvent(events[0]!))
    core.events.observe(sessionId, asSessionEvent(events[1]!))
    await core.events.flush()
    await coordinator.flush()
    const summaries = core.summaries.list({ ideaId: ideaId, sessionId })
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ objective: 'Study GPU Tensor Core bit flips.', generationStatus: 'completed' })
    core.events.observe(sessionId, asSessionEvent(events[1]!))
    await core.events.flush()
    await coordinator.flush()
    expect(core.summaries.list({ ideaId: ideaId, sessionId })).toHaveLength(1)
  })

  it('creates a new summary version for a later turn and retains the superseded history', async () => {
    const { core, ideaId, sessionId } = await bench()
    const events: SummarySessionEvent[] = [userEvent(0, 'Start.'), turnEnd(1)]
    const reader = { readSession: vi.fn(async () => ({ inheritedEventCount: 0, events })) }
    const coordinator = new SummaryCoordinator({ core, reader, logger: { warn: () => {} } })
    core.events.observe(sessionId, asSessionEvent(events[0]!))
    core.events.observe(sessionId, asSessionEvent(events[1]!))
    await core.events.flush()
    await coordinator.flush()
    events.push(turnEnd(2))
    core.events.observe(sessionId, asSessionEvent(events[2]!))
    await core.events.flush()
    await coordinator.flush()
    const summaries = core.summaries.list({ ideaId: ideaId, sessionId })
    expect(summaries).toHaveLength(2)
    expect(summaries.map(item => item.generationVersion)).toEqual([2, 1])
    expect(summaries[1]?.status).toBe('superseded')
  })

  it('recovers a worker row left processing after a simulated crash', async () => {
    const { core, ideaId, sessionId } = await bench()
    const events: SummarySessionEvent[] = [userEvent(0, 'Recover me.'), turnEnd(1)]
    const reader = { readSession: vi.fn(async () => ({ inheritedEventCount: 0, events })) }
    const coordinator = new SummaryCoordinator({ core, reader, logger: { warn: () => {} } })
    coordinator.enqueue(sessionId)
    core.database.connection.prepare(
      "UPDATE research_outbox SET status = 'processing' WHERE topic = 'research/session-summary'",
    ).run()
    coordinator.start()
    await coordinator.flush()
    coordinator.dispose()
    expect(core.summaries.list({ ideaId: ideaId, sessionId })).toHaveLength(1)
  })

  it('retries a failed generation and then completes', async () => {
    const { core, ideaId, sessionId } = await bench()
    const events: SummarySessionEvent[] = [userEvent(0, 'Retry me.'), turnEnd(1)]
    const readSession = vi.fn()
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValue({ inheritedEventCount: 0, events })
    const coordinator = new SummaryCoordinator({ core, reader: { readSession }, logger: { warn: () => {} } })
    coordinator.enqueue(sessionId)
    await coordinator.pump()
    expect(core.summaries.list({ ideaId: ideaId, sessionId })).toHaveLength(0)
    core.database.connection.prepare(
      "UPDATE research_outbox SET next_attempt_at = 0 WHERE topic = 'research/session-summary' AND status = 'pending'",
    ).run()
    await coordinator.pump()
    expect(core.summaries.list({ ideaId: ideaId, sessionId })).toHaveLength(1)
  })

  it('isolates summaries by Session and Idea', async () => {
    const { core, ideaId, sessionId } = await bench()
    const events: SummarySessionEvent[] = [userEvent(0, 'First.'), turnEnd(1)]
    const reader = { readSession: vi.fn(async () => ({ inheritedEventCount: 0, events })) }
    const coordinator = new SummaryCoordinator({ core, reader, logger: { warn: () => {} } })
    coordinator.enqueue(sessionId)
    await coordinator.flush()
    const other = core.createIdea({ title: 'Other' })
    const otherSession = SessionId('session-summary-other')
    core.sessionBindings.createPendingSession({ sessionId: otherSession, ideaId: other.id })
    coordinator.enqueue(otherSession)
    await coordinator.flush()
    expect(core.summaries.list({ ideaId: ideaId })).toHaveLength(1)
    expect(core.summaries.list({ ideaId: other.id })).toHaveLength(1)
    expect(core.summaries.list({ sessionId })).toHaveLength(1)
  })
  it('upgrades a v4 summary table to v5 without losing existing rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-summary-upgrade-'))
    roots.push(root)
    const legacy = new DatabaseSync(join(root, 'database.sqlite'))
    legacy.exec(`
      CREATE TABLE research_schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO research_schema_migrations VALUES (1, 'ideas', 'legacy', 1);
      INSERT INTO research_schema_migrations VALUES (2, 'sessions', 'legacy', 2);
      INSERT INTO research_schema_migrations VALUES (3, 'artifacts', 'legacy', 3);
      INSERT INTO research_schema_migrations VALUES (4, 'memory', 'legacy', 4);
      CREATE TABLE research_memory_sources (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE research_memory_records (id TEXT PRIMARY KEY, idea_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL) STRICT;
      CREATE TABLE research_memory_selections (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE research_session_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        idea_id TEXT,
        summary TEXT NOT NULL,
        event_start_seq INTEGER NOT NULL,
        event_end_seq INTEGER NOT NULL,
        input_hash TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO research_session_summaries VALUES
        ('sum_legacy', 'session_legacy', 'idea_legacy', 'legacy summary', 0, 1, 'hash', 1, 'candidate', 'v1', 1);
      PRAGMA user_version = 4;
    `)
    legacy.close()
    const upgraded = new ResearchDatabase(root)
    expect(upgraded.connection.prepare('SELECT version FROM research_schema_migrations ORDER BY version').all()
      .map(row => row['version'])).toEqual([1, 2, 3, 4, 5, 6, 7])
    const columns = upgraded.connection.prepare('PRAGMA table_info(research_session_summaries)').all().map(row => row['name'])
    expect(columns).toEqual(expect.arrayContaining([
      'objective', 'key_findings_json', 'generation_status', 'idempotency_key', 'updated_at',
    ]))
    expect(upgraded.connection.prepare('SELECT id, summary FROM research_session_summaries').all())
      .toEqual([{ id: 'sum_legacy', summary: 'legacy summary' }])
    upgraded.close()
  })

  it('references a Claim created in an earlier Session when this Session adds Evidence', async () => {
    const { core, ideaId, sessionId } = await bench()
    const laterSession = SessionId('session-summary-b')
    core.sessionBindings.createPendingSession({ sessionId: laterSession, ideaId })
    const source = core.artifacts.createSource(ideaId, { sourceType: 'paper', title: 'Cross Session Source' })
    const claim = core.artifacts.createClaim(ideaId, {
      statement: 'Earlier claim', epistemicStatus: 'reported', sourceIds: [source.id],
    }, { originSessionId: sessionId })
    const evidence = core.artifacts.createEvidence(ideaId, {
      claimId: claim.id, sourceId: source.id, evidenceType: 'supports', quote: 'new evidence',
    }, { originSessionId: laterSession })
    const generated = new SummaryEngine(core).generate({
      sessionId: laterSession, ideaId, startSeq: 0, endSeq: 1,
      events: [userEvent(0, 'Add evidence.'), turnEnd(1)],
    })
    expect(generated.keyFindings.map(item => item.entityId)).toContain(claim.id)
    expect(generated.sourceReferences.map(item => item.entityId)).toContain(claim.id)
    expect(generated.sourceReferences.map(item => item.entityId)).toContain(evidence.id)
  })

})
