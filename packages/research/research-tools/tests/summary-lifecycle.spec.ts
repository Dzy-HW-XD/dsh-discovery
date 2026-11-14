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
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
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

async function bench(): Promise<{ ctx: Context; controller: ResearchController; adapter: ScriptedAdapter }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-summary-lifecycle-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'mock' }),
  } as never)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'query.db') })
  await ctx.plugin(ResearchCore, { root: join(root, 'research') })
  await ctx.plugin(ResearchController)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.researchController.ready
  return { ctx, controller: ctx.researchController, adapter }
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
    const { ctx, controller, adapter } = await bench()
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
    agent!.followup(createUserMessage({
      content: [{ type: 'text', text: 'What did we find about the mock finding?' }],
      source: { kind: 'user' },
    }))
    await agent!.whenIdle()
    const latest = adapter.requests.at(-1)
    expect(latest).toBeDefined()
    expect(JSON.stringify(latest!.messages)).toContain('Relevant research memories')
    expect(JSON.stringify(latest!.messages)).toContain('Mock finding from the lifecycle test.')
    const selections = ctx.researchCore.memory.listSelections(IdeaId(idea.id), binding.sessionId)
    expect(selections.some(selection => selection.layer === 'relevant' && selection.injectionStatus === 'injected')).toBe(true)
    ctx.researchCore.memory.createMemory({
      ideaId: IdeaId(idea.id),
      memoryType: 'goal',
      title: 'GPU SDC goal',
      content: 'Study GPU SDC propagation across model layers.',
      epistemicStatus: 'verified',
      lifecycleStatus: 'active',
      sourceSessionId: binding.sessionId,
      sources: [{ sessionId: binding.sessionId, eventSeq: 1 }],
    })
    const second = await controller.createSession({ ideaId: idea.id, cwd: tmpdir() })
    const secondAgent = ctx.agents.get(SessionId(second.sessionId))
    secondAgent!.followup(createUserMessage({
      content: [{ type: 'text', text: 'Suggest an unrelated cooking recipe.' }],
      source: { kind: 'user' },
    }))
    await secondAgent!.whenIdle()
    expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain('Core memory')
    expect(JSON.stringify(adapter.requests.at(-1)?.messages)).not.toContain('Relevant research memories')
    expect(ctx.researchCore.memory.listSelections(IdeaId(idea.id), second.sessionId)
      .some(selection => selection.layer === 'core' && selection.injectionLocation === 'system-prompt')).toBe(true)
  })
})
