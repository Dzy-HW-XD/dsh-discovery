import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ResearchCore, { IdeaId } from '@deepseek-ai/dsh-research-core'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  private readonly responses: StreamChunk[][]

  constructor(count: number) {
    super()
    this.responses = Array.from({ length: count }, (_, index) => textResponse(`answer ${index + 1}`))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('scripted adapter exhausted')
    for (const chunk of response) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

async function bench(): Promise<{ ctx: Context; adapter: ScriptedAdapter; controller: ResearchController }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-research-lifecycle-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new ScriptedAdapter(8)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'mock' }),
  } as never)
  await ctx.plugin(ResearchCore, { root })
  await ctx.plugin(ResearchController)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.researchController.ready
  return { ctx, adapter, controller: ctx.researchController }
}

function prompt(adapter: ScriptedAdapter, index: number): string {
  const request = adapter.requests[index]
  if (request === undefined) throw new Error(`missing request ${index}`)
  return JSON.stringify(request.messages)
}

function toolNames(adapter: ScriptedAdapter, index: number): string[] {
  const request = adapter.requests[index]
  if (request === undefined) throw new Error(`missing request ${index}`)
  return (request.tools ?? []).map(tool => tool.name)
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.researchCore.events.flush().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Research Session lifecycle', () => {
  it('creates a Session through AgentSetup and exposes the Idea brief and scoped tool on the first request', async () => {
    const { ctx, adapter, controller } = await bench()
    const idea = controller.createIdea({
      title: 'Bounded Activation',
      researchQuestion: 'Does clamping reduce SDC propagation?',
      currentSummary: 'Initial literature pass',
    })
    const binding = await controller.createSession({ ideaId: idea.id, cwd: tmpdir() })
    expect(binding).toMatchObject({ status: 'active', ideaId: idea.id, role: 'primary' })
    const agent = ctx.agents.get(SessionId(binding.sessionId))
    expect(agent).toBeDefined()
    agent!.followup(createUserMessage({ content: [{ type: 'text', text: 'Summarize the research state.' }], source: { kind: 'user' } }))
    await agent!.whenIdle()
    expect(prompt(adapter, 0)).toContain('Bounded Activation')
    expect(prompt(adapter, 0)).toContain('Does clamping reduce SDC propagation?')
    expect(toolNames(adapter, 0)).toEqual(expect.arrayContaining([
      'research_session', 'research_source', 'research_concept', 'research_claim', 'research_evidence', 'research_graph',
      'research_question', 'research_gap', 'research_hypothesis', 'research_discovery',
      'research_artifact', 'research_branch', 'research_decision',
    ]))
    expect(controller.listSessions({ ideaId: idea.id })).toHaveLength(1)
    await ctx.researchCore.events.flush()
    const checkpoint = controller.getSession({ sessionId: binding.sessionId })?.checkpoint
    expect(checkpoint?.lastSuccessfullyProcessedSeq).toBeGreaterThanOrEqual(0)
    expect(ctx.researchCore.outbox.pendingCount()).toBe(0)
  })

  it('installs the composition through agent/created for a standard Agent created without setup', async () => {
    const { ctx, adapter, controller } = await bench()
    const idea = controller.createIdea({
      title: 'Fallback Idea',
      researchQuestion: 'Can a standard Agent resume research context?',
    })
    const sessionId = SessionId('session-fallback')
    ctx.researchCore.sessionBindings.createPendingSession({ sessionId, ideaId: IdeaId(idea.id) })
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: tmpdir() },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Use the fallback context.' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    expect(prompt(adapter, 0)).toContain('Fallback Idea')
    expect(prompt(adapter, 0)).toContain('Can a standard Agent resume research context?')
    expect(toolNames(adapter, 0)).toContain('research_session')
    await handle.dispose()
    expect(controller.getSession({ sessionId })).toMatchObject({ session: { status: 'active' } })
    expect(controller.getSession({ sessionId })?.session.status).not.toBe('finalized')
  })

  it('does not inject Research context into an unlinked Inbox Session', async () => {
    const { ctx, adapter, controller } = await bench()
    const sessionId = SessionId('session-inbox-only')
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: tmpdir() },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await controller.ready
    expect(controller.getSession({ sessionId })).toMatchObject({
      session: { status: 'inbox', role: 'inbox' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ordinary request' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(prompt(adapter, 0)).not.toContain('Research Idea')
    expect(toolNames(adapter, 0)).not.toContain('research_session')
    await handle.dispose()
  })

  it('links a live Inbox Session and removes the composition when unlinked', async () => {
    const { ctx, adapter, controller } = await bench()
    const idea = controller.createIdea({ title: 'Live Link' })
    const sessionId = SessionId('session-live-link')
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: tmpdir() },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    controller.linkSession({ sessionId, ideaId: idea.id })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(prompt(adapter, 0)).toContain('Live Link')
    expect(toolNames(adapter, 0)).toContain('research_session')

    controller.unlinkSession({ sessionId })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(prompt(adapter, 1)).toContain('Current runtime context: none')
    expect(toolNames(adapter, 1)).not.toContain('research_session')
    expect(controller.getSession({ sessionId })).toMatchObject({ session: { status: 'inbox' } })
    await handle.dispose()
  })

  it('finalizes a Session without disposing its DSH history', async () => {
    const { ctx, controller } = await bench()
    const idea = controller.createIdea({ title: 'Finalize' })
    const binding = await controller.createSession({ ideaId: idea.id, cwd: tmpdir() })
    const finalized = controller.finalizeSession({ sessionId: binding.sessionId, summary: 'done' })
    expect(finalized).toMatchObject({ status: 'finalized' })
    expect(ctx.sessions.get(SessionId(binding.sessionId))).toBeDefined()
    expect(controller.listTimeline({ ideaId: idea.id }).map(event => event.eventType)).toContain('idea.session_finalized')
  })
  it('supports multiple Sessions under one Idea and keeps binding state after Agent disposal', async () => {
    const { ctx, controller } = await bench()
    const idea = controller.createIdea({ title: 'Multi Session Idea' })
    const first = await controller.createSession({ ideaId: idea.id, cwd: tmpdir() })
    const second = await controller.createSession({ ideaId: idea.id, cwd: tmpdir() })
    expect(controller.listSessions({ ideaId: idea.id })).toHaveLength(2)
    expect(first.sessionId).not.toBe(second.sessionId)
    const handle = ctx.agents.get(SessionId(first.sessionId))
    expect(handle).toBeDefined()
    await ctx.agents.get(SessionId(first.sessionId))?.ctx.fiber.dispose?.()
    // Disposing the Agent does not finalize the research binding.
    expect(controller.getSession({ sessionId: first.sessionId })).toMatchObject({ session: { status: 'active' } })
  })

  it('attaches a created Session to the requested Workspace', async () => {
    const { ctx, controller } = await bench()
    const idea = controller.createIdea({ title: 'Workspace Idea' })
    const attachSession = vi.fn(async () => {})
    const path = tmpdir()
    ctx.provide('workspaceRegistry', {
      get: (id: string) => id === 'workspace-1'
        ? { id: 'workspace-1', path, attachSession }
        : undefined,
    } as never)
    const binding = await controller.createSession({ ideaId: idea.id, workspaceId: 'workspace-1' })
    expect(attachSession).toHaveBeenCalledWith(binding.sessionId)
  })

  it('creates and queries Phase 3 artifacts through the scoped tools', async () => {
    const { ctx, controller } = await bench()
    const idea = controller.createIdea({ title: 'Tool Artifacts' })
    const binding = await controller.createSession({ ideaId: idea.id, cwd: tmpdir() })
    const agent = ctx.agents.get(SessionId(binding.sessionId))
    expect(agent).toBeDefined()
    let call = 0
    const invoke = async (name: string, args: Record<string, unknown>): Promise<void> => {
      await ctx.tools.execute({
        agent: agent!,
        signal: new AbortController().signal,
        log: { turn: 1, step: 1 },
        calls: [{
          type: 'tool-call',
          id: ToolCallId(`artifact-call-${call++}`),
          name,
          arguments: JSON.stringify(args),
        }],
      })
    }
    await invoke('research_source', {
      action: 'import', ideaId: idea.id, title: 'Mock Source', sourceType: 'web', url: 'https://example.com/mock',
    })
    const source = ctx.researchCore.artifacts.listSources(IdeaId(idea.id))[0]
    expect(source).toBeDefined()
    await invoke('research_source', {
      action: 'locate', ideaId: idea.id, sourceId: source!.id, locatorType: 'url_fragment', locator: '#result', quote: 'quoted result',
    })
    await invoke('research_claim', {
      action: 'create', ideaId: idea.id, statement: 'The mock result supports bounded activation.',
      epistemicStatus: 'reported', sourceIds: [source!.id],
    })
    const claim = ctx.researchCore.artifacts.listClaims(IdeaId(idea.id))[0]
    expect(claim).toMatchObject({ origin: { originSessionId: binding.sessionId, originToolCallId: 'artifact-call-2' } })
    await invoke('research_evidence', {
      action: 'create', ideaId: idea.id, sourceId: source!.id, claimId: claim!.id,
      evidenceType: 'supports', quote: 'quoted result',
    })
    const evidence = ctx.researchCore.artifacts.listEvidence(IdeaId(idea.id))[0]
    await invoke('research_graph', {
      action: 'relate', ideaId: idea.id, fromEntityType: 'evidence', fromEntityId: evidence!.id,
      toEntityType: 'claim', toEntityId: claim!.id, relationType: 'supports',
    })
    await invoke('research_hypothesis', {
      action: 'create', ideaId: idea.id, title: 'Tool hypothesis', description: 'Created through the scoped tool.',
    })
    await invoke('research_artifact', {
      action: 'create', ideaId: idea.id, artifactType: 'markdown', title: 'Tool report', content: '# Tool report',
    })
    await invoke('research_question', { action: 'create', ideaId: idea.id, question: 'Does the tool path persist?' })
    await invoke('research_gap', {
      action: 'create', ideaId: idea.id, gapType: 'knowledge_gap', gapDescription: 'No tool-path coverage',
    })
    await invoke('research_discovery', {
      action: 'create', ideaId: idea.id, discoveryType: 'other', description: 'Tool path discovery',
    })
    await invoke('research_decision', {
      action: 'create', ideaId: idea.id, title: 'Keep tool path', decision: 'Retain the scoped tools',
    })
    await invoke('research_branch', { action: 'create', ideaId: idea.id, title: 'Tool branch' })
    await invoke('research_graph', { action: 'entities', ideaId: idea.id })
    expect(ctx.researchCore.artifacts.countEntities(IdeaId(idea.id))).toMatchObject({
      sources: 1, claims: 1, evidence: 1, relations: 1, questions: 1, gaps: 1,
      hypotheses: 1, discoveries: 1, decisions: 1, artifacts: 1, branches: 1,
    })
    const artifact = ctx.researchCore.artifacts.listArtifacts(IdeaId(idea.id))[0]
    expect(ctx.researchCore.artifacts.verifyArtifact(artifact!.id).valid).toBe(true)
  })

})
