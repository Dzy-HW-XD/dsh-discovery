import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ResearchCore, { IdeaId } from '@deepseek-ai/dsh-research-core'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import ResearchController from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

class ScriptedAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = 'Recorded a mock research answer.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const character of text) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield { type: 'text-delta', index: 0, text: character }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function bench(): Promise<{ ctx: Context; controller: ResearchController }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-summary-lifecycle-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter())
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'mock' }),
  } as never)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'query.db') })
  await ctx.plugin(ResearchCore, { root: join(root, 'research') })
  await ctx.plugin(ResearchController)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.researchController.ready
  return { ctx, controller: ctx.researchController }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.researchCore.events.flush().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Summary lifecycle with a real Agent Session', () => {
  it('summarizes a completed turn through the Remote and real Session log', async () => {
    const { ctx, controller } = await bench()
    const idea = controller.createIdea({
      title: 'Lifecycle Summary',
      researchQuestion: 'Does the turn become a structured summary?',
    })
    const binding = await controller.createSession({ ideaId: idea.id, cwd: tmpdir() })
    const agent = ctx.agents.get(SessionId(binding.sessionId))
    expect(agent).toBeDefined()
    agent!.followup(createUserMessage({
      content: [{ type: 'text', text: 'Study GPU Tensor Core bit flips in this Session.' }],
      source: { kind: 'user' },
    }))
    await agent!.whenIdle()
    await ctx.sessions.flush(agent!.session)
    await ctx.researchCore.events.flush()
    const source = ctx.researchCore.artifacts.createSource(IdeaId(idea.id), {
      sourceType: 'paper', title: 'Summary lifecycle source',
    })
    ctx.researchCore.artifacts.createClaim(IdeaId(idea.id), {
      statement: 'Mock finding from the lifecycle test.',
      epistemicStatus: 'reported',
      sourceIds: [source.id],
    }, { originSessionId: binding.sessionId })
    const summary = await controller.summarizeSession({ sessionId: binding.sessionId })
    expect(summary).not.toBeNull()
    expect(summary).toMatchObject({
      sessionId: binding.sessionId,
      generationStatus: 'completed',
      objective: 'Study GPU Tensor Core bit flips in this Session.',
    })
    expect(summary!.sourceReferences.some(item => item.entityType === 'claim')).toBe(true)
    expect(summary!.summary).toContain('Objective:')
    expect(ctx.researchCore.memory.listMemories(IdeaId(idea.id))).toHaveLength(1)
    expect(ctx.researchCore.memory.listMemories(IdeaId(idea.id))[0]).toMatchObject({
      memoryType: 'fact', lifecycleStatus: 'candidate', epistemicStatus: 'unverified',
    })
  })
})
