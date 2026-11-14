import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import ResearchCore, { IdeaId } from '@deepseek-ai/dsh-research-core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MemoryContextBuilder,
  MemoryContextService,
  MemoryRetriever,
} from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

async function bench(): Promise<{ core: ResearchCore; ideaId: IdeaId; sessionId: SessionId }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-retrieval-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ResearchCore, { root })
  const core = ctx.researchCore
  const idea = core.createIdea({ title: 'GPU SDC Retrieval', researchQuestion: 'How does SDC propagate?' })
  const sessionId = SessionId('session-retrieval')
  core.sessionBindings.createPendingSession({ sessionId, ideaId: idea.id })
  core.sessionBindings.markSessionActive(sessionId)
  return { core, ideaId: idea.id, sessionId }
}

function memory(core: ResearchCore, ideaId: IdeaId, sessionId: SessionId, input: {
  type?: 'goal' | 'fact' | 'finding' | 'hypothesis' | 'decision' | 'constraint' | 'failure' | 'open_question' | 'strategy' | 'preference'
  title: string
  content: string
  epistemic?: 'verified' | 'supported' | 'inferred' | 'unverified' | 'disputed' | 'refuted'
  lifecycle?: 'candidate' | 'active' | 'superseded' | 'rejected' | 'archived'
}) {
  return core.memory.createMemory({
    ideaId,
    memoryType: input.type ?? 'fact',
    title: input.title,
    content: input.content,
    epistemicStatus: input.epistemic ?? 'supported',
    lifecycleStatus: input.lifecycle ?? 'active',
    sourceSessionId: sessionId,
    sources: [{ sessionId, eventSeq: 1 }],
  })
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('memory FTS5', () => {
  it('searches English, Chinese, mixed text, short fallback, and special characters', async () => {
    const { core, ideaId, sessionId } = await bench()
    memory(core, ideaId, sessionId, { title: 'BF16 GEMM drift', content: 'Tensor Core BF16 GEMM shows output drift.' })
    memory(core, ideaId, sessionId, { title: '位翻转传播', content: 'GPU 位翻转会影响 GEMM 输出。' })
    memory(core, ideaId, sessionId, { title: 'SDC marker', content: 'SDC appears in the accumulator.' })
    expect(core.memory.searchMemories(ideaId, 'GEMM').length).toBeGreaterThanOrEqual(2)
    expect(core.memory.searchMemories(ideaId, '位翻转').length).toBe(1)
    expect(core.memory.searchMemories(ideaId, 'GEMM 位翻转').length).toBeGreaterThanOrEqual(2)
    expect(core.memory.searchMemories(ideaId, 'SD').length).toBe(1)
    expect(core.memory.searchMemories(ideaId, 'C++')).toHaveLength(0)
    expect(core.memory.searchMemories(ideaId, '')).toHaveLength(0)
  })

  it('keeps the index in sync with updates and transaction rollback, and can rebuild', async () => {
    const { core, ideaId, sessionId } = await bench()
    const item = memory(core, ideaId, sessionId, { title: 'Alpha marker', content: 'Alpha content.' })
    expect(core.memory.searchMemories(ideaId, 'Alpha')).toHaveLength(1)
    core.memory.updateMemory(ideaId, item.id, { title: 'Beta marker', content: 'Beta content.' }, {
      changeReason: 'rename', changeSource: 'review', createdBy: 'user',
    })
    expect(core.memory.searchMemories(ideaId, 'Alpha')).toHaveLength(0)
    expect(core.memory.searchMemories(ideaId, 'Beta')).toHaveLength(1)
    expect(() => core.database.transaction(() => {
      core.database.connection.prepare('UPDATE research_memory_records SET title = ?, content = ? WHERE id = ?')
        .run('Gamma marker', 'Gamma content.', item.id)
      throw new Error('rollback')
    })).toThrow('rollback')
    expect(core.memory.searchMemories(ideaId, 'Beta')).toHaveLength(1)
    expect(core.memory.searchMemories(ideaId, 'Gamma')).toHaveLength(0)
    core.database.connection.prepare('DELETE FROM research_memory_fts').run()
    expect(core.memory.searchMemories(ideaId, 'Beta')).toHaveLength(0)
    core.memory.rebuildSearchIndex()
    expect(core.memory.searchMemories(ideaId, 'Beta')).toHaveLength(1)
  })
})

describe('memory retrieval and ranking', () => {
  it('filters by Idea and lifecycle and includes historical states only in explicit history', async () => {
    const { core, ideaId, sessionId } = await bench()
    const other = core.createIdea({ title: 'Other Retrieval' })
    const otherSession = SessionId('session-retrieval-other')
    core.sessionBindings.createPendingSession({ sessionId: otherSession, ideaId: other.id })
    const active = memory(core, ideaId, sessionId, { title: 'GEMM active finding', content: 'GEMM is stable.', epistemic: 'verified' })
    memory(core, other.id, otherSession, { title: 'GEMM other idea', content: 'GEMM other idea.' })
    const refuted = memory(core, ideaId, sessionId, {
      title: 'GEMM refuted hypothesis', content: 'GEMM refuted.', type: 'hypothesis', epistemic: 'refuted', lifecycle: 'active',
    })
    const archived = memory(core, ideaId, sessionId, {
      title: 'GEMM archived decision', content: 'GEMM archived.', type: 'decision', lifecycle: 'archived',
    })
    const retriever = new MemoryRetriever(core)
    const current = retriever.retrieve(ideaId, 'GEMM', 'initial')
    expect(current.relevant.map(item => item.memory.id)).toContain(active.id)
    expect(current.relevant.map(item => item.memory.id)).not.toContain(refuted.id)
    expect(current.relevant.map(item => item.memory.id)).not.toContain(archived.id)
    expect(current.core.map(item => item.memory.id)).not.toContain(refuted.id)
    const historical = retriever.retrieve(ideaId, 'GEMM', 'explicit-history')
    expect(historical.relevant.map(item => item.memory.id)).toEqual(expect.arrayContaining([active.id, refuted.id, archived.id]))
    expect(historical.relevant.some(item => item.memory.ideaId === other.id)).toBe(false)
  })

  it('ranks relevant supported knowledge above unrelated verified memory', async () => {
    const { core, ideaId, sessionId } = await bench()
    const relevant = memory(core, ideaId, sessionId, { title: 'Attention BF16 error', content: 'Attention BF16 error propagates.', epistemic: 'supported' })
    memory(core, ideaId, sessionId, { title: 'Server BIOS version', content: 'The server BIOS is 2.1.', epistemic: 'verified' })
    const result = new MemoryRetriever(core).retrieve(ideaId, 'Attention BF16', 'initial')
    expect(result.relevant[0]?.memory.id).toBe(relevant.id)
    expect(result.relevant[0]?.score).toBeGreaterThan(0)
    expect(result.relevant[0]?.reasons.length).toBeGreaterThan(0)
  })
})

describe('memory context and selection log', () => {
  it('enforces core/relevant/total token budgets and keeps status/source labels', async () => {
    const { core, ideaId, sessionId } = await bench()
    for (let index = 0; index < 12; index += 1) {
      memory(core, ideaId, sessionId, {
        title: `Long memory ${index}`,
        content: 'Very long research content '.repeat(8),
        type: index === 0 ? 'goal' : 'fact',
      })
    }
    const built = new MemoryContextBuilder({
      coreBudget: 280, relevantBudget: 160, totalBudget: 380,
      estimateTokens: text => Math.ceil(text.length / 3),
    }).build(new MemoryRetriever(core).retrieve(ideaId, 'Very long research', 'initial'))
    expect(built.coreTokens).toBeLessThanOrEqual(280)
    expect(built.relevantTokens).toBeLessThanOrEqual(160)
    expect(built.estimatedTokens).toBeLessThanOrEqual(380)
    expect(built.coreText).toContain('verified = confirmed')
    expect(built.relevantText === '' || built.relevantText.includes('sources:')).toBe(true)
    expect(built.tokenizerType).toBe('estimated')
  })

  it('records the injected versions and avoids re-injecting unchanged relevant memory', async () => {
    const { core, ideaId, sessionId } = await bench()
    memory(core, ideaId, sessionId, {
      title: 'Idea goal', content: 'Study GEMM SDC.', type: 'goal', epistemic: 'verified',
    })
    const fact = memory(core, ideaId, sessionId, {
      title: 'GEMM result', content: 'GEMM result is stable.', epistemic: 'supported',
    })
    const service = new MemoryContextService({
      core, estimateTokens: text => Math.ceil(text.length / 3),
    })
    const first = service.buildTurn({ ideaId, sessionId, query: 'GEMM', turn: 1, step: 1 })
    expect(first.coreVisibleText).toContain('Research memories')
    expect(first.relevantVisibleText).toContain('GEMM result')
    const firstSelections = core.memory.listSelections(ideaId, sessionId)
    expect(firstSelections.some(selection => selection.memoryId === fact.id && selection.layer === 'relevant')).toBe(true)
    expect(firstSelections.every(selection => selection.injectionStatus === 'injected')).toBe(true)
    expect(firstSelections.some(selection => selection.injectionLocation === 'system-prompt')).toBe(true)
    expect(firstSelections.some(selection => selection.injectionLocation === 'agent-pre-step')).toBe(true)
    const second = service.buildTurn({ ideaId, sessionId, query: 'GEMM', turn: 2, step: 1 })
    expect(second.relevantVisibleText).toBe('')
    const updated = core.memory.updateMemory(ideaId, fact.id, {
      content: 'GEMM result is stable under BF16.',
    }, { changeReason: 'refined', changeSource: 'review', createdBy: 'user' })
    const third = service.buildTurn({ ideaId, sessionId, query: 'GEMM', turn: 3, step: 1 })
    expect(third.relevantVisibleText).toContain('BF16')
    expect(core.memory.listSelections(ideaId, sessionId).some(selection =>
      selection.memoryId === updated.id && selection.memoryVersion === 2 && selection.turn === 3)).toBe(true)
  })

  it('uses explicit history mode for historical queries', async () => {
    const { core, ideaId, sessionId } = await bench()
    const archived = memory(core, ideaId, sessionId, {
      title: 'Old GEMM decision', content: 'Old GEMM decision.', type: 'decision', lifecycle: 'archived',
    })
    const service = new MemoryContextService({ core, estimateTokens: text => Math.ceil(text.length / 3) })
    const built = service.buildTurn({ ideaId, sessionId, query: 'Why did we choose the old GEMM decision before?', turn: 1, step: 1 })
    expect(built.mode).toBe('explicit-history')
    expect(built.relevantVisibleText).toContain('Old GEMM decision')
    expect(core.memory.listSelections(ideaId, sessionId).some(selection => selection.memoryId === archived.id)).toBe(true)
  })
})
