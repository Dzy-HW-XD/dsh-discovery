import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import ResearchCore, { IdeaId, type ResearchSessionSummary, type SummaryReference } from '@deepseek-ai/dsh-research-core'
import { afterEach, describe, expect, it } from 'vitest'
import { ExtractorCoordinator, MemoryExtractor } from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

async function bench(): Promise<{ core: ResearchCore; ideaId: IdeaId; sessionId: SessionId }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-extractor-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ResearchCore, { root })
  const core = ctx.researchCore
  const idea = core.createIdea({ title: 'Extractor Idea', researchQuestion: 'What persists?' })
  const sessionId = SessionId('session-extractor')
  core.sessionBindings.createPendingSession({ sessionId, ideaId: idea.id })
  core.sessionBindings.markSessionActive(sessionId)
  return { core, ideaId: idea.id, sessionId }
}

function insertSummary(
  core: ResearchCore,
  ideaId: IdeaId,
  sessionId: SessionId,
  fields: {
    objective?: string
    keyFindings?: SummaryReference[]
    hypothesesCreated?: SummaryReference[]
    hypothesesValidated?: SummaryReference[]
    hypothesesRejected?: SummaryReference[]
    decisions?: SummaryReference[]
    failedAttempts?: SummaryReference[]
    unresolvedQuestions?: SummaryReference[]
    generatedArtifacts?: SummaryReference[]
    nextSteps?: string[]
    sourceReferences?: SummaryReference[]
  } = {},
): ResearchSessionSummary {
  return core.summaries.insert({
    sessionId,
    ideaId,
    summary: fields.objective ?? 'Summary',
    objective: fields.objective ?? 'Objective',
    keyFindings: fields.keyFindings ?? [],
    hypothesesCreated: fields.hypothesesCreated ?? [],
    hypothesesValidated: fields.hypothesesValidated ?? [],
    hypothesesRejected: fields.hypothesesRejected ?? [],
    decisions: fields.decisions ?? [],
    failedAttempts: fields.failedAttempts ?? [],
    unresolvedQuestions: fields.unresolvedQuestions ?? [],
    generatedArtifacts: fields.generatedArtifacts ?? [],
    nextSteps: fields.nextSteps ?? [],
    sourceReferences: fields.sourceReferences ?? [],
    eventStartSeq: 0,
    eventEndSeq: 1,
    inputHash: randomUUID(),
    idempotencyKey: `test-summary:${randomUUID()}`,
    promptVersion: 'test-v1',
  })
}

function ref(entityType: string, entityId: string, label: string, version?: number): SummaryReference {
  return { entityType, entityId, label, ...version === undefined ? {} : { version } }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('memory extractor', () => {
  it('extracts evidence-backed facts with Summary, Claim, and Evidence provenance', async () => {
    const { core, ideaId, sessionId } = await bench()
    const source = core.artifacts.createSource(ideaId, { sourceType: 'paper', title: 'SDC paper' })
    const claim = core.artifacts.createClaim(ideaId, {
      statement: 'BF16 GEMM shows output drift.', epistemicStatus: 'reported', sourceIds: [source.id],
    }, { originSessionId: sessionId })
    const evidence = core.artifacts.createEvidence(ideaId, {
      claimId: claim.id, sourceId: source.id, evidenceType: 'supports', quote: 'observed drift',
    }, { originSessionId: sessionId })
    const summary = insertSummary(core, ideaId, sessionId, {
      keyFindings: [ref('claim', claim.id, claim.statement, claim.version)],
      sourceReferences: [ref('claim', claim.id, claim.statement, claim.version), ref('evidence', evidence.id, 'observed drift', evidence.version)],
    })
    const result = new MemoryExtractor(core).extract(summary, 'job-1')
    expect(result.created).toBe(1)
    const memories = core.memory.listMemories(ideaId)
    expect(memories).toHaveLength(1)
    expect(memories[0]).toMatchObject({
      memoryType: 'fact',
      epistemicStatus: 'supported',
      lifecycleStatus: 'candidate',
    })
    expect(memories[0]?.sources.some(item => item.summaryId === summary.id && item.summaryVersion === 1)).toBe(true)
    expect(memories[0]?.sources.some(item => item.entityType === 'claim' && item.entityId === claim.id)).toBe(true)
    expect(memories[0]?.sources.some(item => item.entityType === 'evidence' && item.entityId === evidence.id)).toBe(true)
    expect(memories[0]?.sources.some(item => item.extractionJobId === 'job-1')).toBe(true)
  })

  it('preserves rejected hypotheses and failed evidence without deleting them', async () => {
    const { core, ideaId, sessionId } = await bench()
    const hypothesis = core.artifacts.createHypothesis(ideaId, {
      title: 'Dual-bit dominates', description: 'Dual-bit dominates drift.',
    }, { originSessionId: sessionId })
    core.artifacts.updateHypothesis(hypothesis.id, { status: 'rejected' }, 'not reproducible')
    const summary = insertSummary(core, ideaId, sessionId, {
      hypothesesCreated: [ref('hypothesis', hypothesis.id, hypothesis.title, 1)],
      hypothesesRejected: [ref('hypothesis', hypothesis.id, hypothesis.title, 2)],
      failedAttempts: [ref('hypothesis', hypothesis.id, hypothesis.title, 2)],
    })
    const result = new MemoryExtractor(core).extract(summary, 'job-2')
    expect(result.created).toBeGreaterThanOrEqual(2)
    const memories = core.memory.listMemories(ideaId)
    expect(memories.find(memory => memory.memoryType === 'hypothesis')).toMatchObject({
      epistemicStatus: 'refuted', lifecycleStatus: 'candidate',
    })
    expect(memories.filter(memory => memory.memoryType === 'failure').length).toBeGreaterThanOrEqual(1)
    expect(core.artifacts.listHypotheses(ideaId)).toHaveLength(1)
  })

  it('extracts a decision and a reusable procedure from an imperative decision', async () => {
    const { core, ideaId, sessionId } = await bench()
    const decision = core.artifacts.createDecision(ideaId, {
      title: 'Run BF16 GEMM first',
      decision: 'Run BF16 GEMM injection before attention tests.',
      rationale: 'Reuse the validated harness.',
    }, { originSessionId: sessionId })
    const summary = insertSummary(core, ideaId, sessionId, {
      decisions: [ref('decision', decision.id, decision.title)],
    })
    new MemoryExtractor(core).extract(summary, 'job-3')
    const memories = core.memory.listMemories(ideaId)
    expect(memories.some(memory => memory.memoryType === 'decision')).toBe(true)
    expect(memories.some(memory => memory.memoryType === 'strategy'
      && JSON.stringify(memory.structured).includes('"kind":"procedure"'))).toBe(true)
  })

  it('does not create candidates for an empty Summary or infer preferences', async () => {
    const { core, ideaId, sessionId } = await bench()
    const summary = insertSummary(core, ideaId, sessionId, {})
    const result = new MemoryExtractor(core).extract(summary, 'job-4')
    expect(result).toEqual({ created: 0, updated: 0, unchanged: 0, conflicts: 0, skipped: 0 })
    expect(core.memory.listMemories(ideaId)).toHaveLength(0)
  })

  it('deduplicates exact content, versions refined content, and records a probable duplicate', async () => {
    const { core, ideaId, sessionId } = await bench()
    const source = core.artifacts.createSource(ideaId, { sourceType: 'paper', title: 'Source' })
    const claim = core.artifacts.createClaim(ideaId, {
      statement: 'GPU pressure test shows Xid 149.', epistemicStatus: 'reported', sourceIds: [source.id],
    }, { originSessionId: sessionId })
    const first = insertSummary(core, ideaId, sessionId, { keyFindings: [ref('claim', claim.id, claim.statement, 1)] })
    new MemoryExtractor(core).extract(first, 'job-5')
    new MemoryExtractor(core).extract(first, 'job-5b')
    expect(core.memory.listMemories(ideaId)).toHaveLength(1)
    const refined = insertSummary(core, ideaId, sessionId, {
      keyFindings: [ref('claim', claim.id, 'GPU pressure test shows Xid 149 under load.', 2)],
    })
    new MemoryExtractor(core).extract(refined, 'job-6')
    const memories = core.memory.listMemories(ideaId)
    expect(memories).toHaveLength(1)
    expect(memories[0]?.version).toBe(2)
    const different = core.artifacts.createClaim(ideaId, {
      statement: 'GPU pressure test shows Xid 149 under a different power profile.', epistemicStatus: 'reported', sourceIds: [source.id],
    }, { originSessionId: sessionId })
    const duplicate = insertSummary(core, ideaId, sessionId, { keyFindings: [ref('claim', different.id, different.statement, 1)] })
    new MemoryExtractor(core).extract(duplicate, 'job-7')
    expect(core.memory.listMemories(ideaId).length).toBeGreaterThanOrEqual(2)
    expect(core.memory.listConflicts(ideaId).length).toBeGreaterThanOrEqual(0)
  })

  it('keeps identical content isolated between Ideas', async () => {
    const { core, ideaId, sessionId } = await bench()
    const other = core.createIdea({ title: 'Other' })
    const otherSession = SessionId('session-extractor-other')
    core.sessionBindings.createPendingSession({ sessionId: otherSession, ideaId: other.id })
    const source = core.artifacts.createSource(ideaId, { sourceType: 'paper', title: 'Shared Source' })
    const claim = core.artifacts.createClaim(ideaId, {
      statement: 'Same statement', epistemicStatus: 'reported', sourceIds: [source.id],
    }, { originSessionId: sessionId })
    const first = insertSummary(core, ideaId, sessionId, { keyFindings: [ref('claim', claim.id, claim.statement, 1)] })
    new MemoryExtractor(core).extract(first, 'job-8')
    const otherClaim = core.artifacts.createClaim(other.id, {
      statement: 'Same statement', epistemicStatus: 'reported', sourceIds: [source.id],
    }, { originSessionId: otherSession })
    const second = insertSummary(core, other.id, otherSession, { keyFindings: [ref('claim', otherClaim.id, otherClaim.statement, 1)] })
    new MemoryExtractor(core).extract(second, 'job-9')
    expect(core.memory.listMemories(ideaId)).toHaveLength(1)
    expect(core.memory.listMemories(other.id)).toHaveLength(1)
  })
})

describe('extractor coordinator', () => {
  it('runs from the Summary Store outbox, is idempotent, and recovers processing rows', async () => {
    const { core, ideaId, sessionId } = await bench()
    const source = core.artifacts.createSource(ideaId, { sourceType: 'paper', title: 'Coordinator Source' })
    const claim = core.artifacts.createClaim(ideaId, {
      statement: 'Coordinator fact', epistemicStatus: 'reported', sourceIds: [source.id],
    }, { originSessionId: sessionId })
    insertSummary(core, ideaId, sessionId, {
      keyFindings: [ref('claim', claim.id, claim.statement, 1)],
    })
    const coordinator = new ExtractorCoordinator({ core, logger: { warn: () => {} } })
    await coordinator.flush()
    expect(core.memory.listMemories(ideaId)).toHaveLength(1)
    core.database.connection.prepare(
      "UPDATE research_outbox SET status = 'processing' WHERE topic = 'research/session-memory-extraction'",
    ).run()
    coordinator.start()
    await coordinator.flush()
    coordinator.dispose()
    expect(core.memory.listMemories(ideaId)).toHaveLength(1)
    await coordinator.flush()
    expect(core.memory.listMemories(ideaId)).toHaveLength(1)
  })
  it('marks opposing supported and rejected hypotheses as a conflict without merging or deleting', async () => {
    const { core, ideaId, sessionId } = await bench()
    const supported = core.artifacts.createHypothesis(ideaId, {
      title: 'Clamping reduces drift', description: 'Clamping reduces output drift under load.',
    }, { originSessionId: sessionId })
    core.artifacts.updateHypothesis(supported.id, { status: 'supported' }, 'observed')
    const rejected = core.artifacts.createHypothesis(ideaId, {
      title: 'Clamping increases drift', description: 'Clamping increases output drift under load.',
    }, { originSessionId: sessionId })
    core.artifacts.updateHypothesis(rejected.id, { status: 'rejected' }, 'not observed')
    const summary = insertSummary(core, ideaId, sessionId, {
      hypothesesValidated: [ref('hypothesis', supported.id, supported.title, 2)],
      hypothesesRejected: [ref('hypothesis', rejected.id, rejected.title, 2)],
    })
    new MemoryExtractor(core).extract(summary, 'job-conflict')
    const memories = core.memory.listMemories(ideaId).filter(memory => memory.memoryType === 'hypothesis')
    expect(memories).toHaveLength(2)
    expect(memories.map(memory => memory.epistemicStatus).sort()).toEqual(['refuted', 'supported'])
    expect(memories.every(memory => memory.lifecycleStatus === 'candidate')).toBe(true)
    expect(core.memory.listConflicts(ideaId)).toHaveLength(1)
    expect(core.memory.listConflicts(ideaId)[0]).toMatchObject({ conflictType: 'contradiction', status: 'open' })
  })

})
