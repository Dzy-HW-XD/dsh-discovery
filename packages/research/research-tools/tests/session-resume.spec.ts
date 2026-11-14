import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ResearchCore, { IdeaId } from '@deepseek-ai/dsh-research-core'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'
import ResearchController from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (character): StreamChunk => ({ type: 'text-delta', index: 0, text: character })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of textResponse('resumed answer')) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

async function bench(): Promise<{ ctx: Context; adapter: ScriptedAdapter; controller: ResearchController; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-research-resume-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'mock' }),
  } as never)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(ResearchCore, { root: join(root, 'research') })
  await ctx.plugin(ResearchController)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.researchController.ready
  return { ctx, adapter, controller: ctx.researchController, root }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.researchCore.events.flush().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Research Session resume fallback', () => {
  it('restores the composition on agent/created before the first resumed request', async () => {
    const { ctx, adapter, controller } = await bench()
    const idea = controller.createIdea({
      title: 'Resumed Idea',
      researchQuestion: 'Does the fallback survive resume?',
    })
    const sessionId = SessionId('session-resume-fallback')
    const cwd = tmpdir()
    const detached = ctx.sessions.prepare(sessionId, { meta: { cwd } })
    const stored = await ctx.sessionPersistence.create(detached.header)
    await stored.append([
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    await stored.close()
    ctx.researchCore.sessionBindings.createPendingSession({ sessionId, ideaId: IdeaId(idea.id), cwd })

    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(controller.getSession({ sessionId })).toMatchObject({ session: { status: 'active' } })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Continue the research.' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    const request = adapter.requests[0]
    expect(request).toBeDefined()
    const prompt = JSON.stringify(request!.messages)
    expect(prompt).toContain('Resumed Idea')
    expect(prompt).toContain('Does the fallback survive resume?')
    expect((request!.tools ?? []).map(tool => tool.name)).toContain('research_session')
    await handle.dispose()
  })
})
