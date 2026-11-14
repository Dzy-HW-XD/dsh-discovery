/**
 * Per-Agent Research composition. The same installer serves the pre-publication
 * `AgentSetup` path and the `agent/created` fallback; it is idempotent per live
 * Agent and can be removed when a Session returns to the Inbox.
 * @module @deepseek-ai/dsh-research-tools/composition
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryContextService } from '@deepseek-ai/dsh-research-memory'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import ResearchCore, {
  IdeaId,
  ResearchError,
  type ResearchSessionBinding,
} from '@deepseek-ai/dsh-research-core'
import { toCheckpointView, toSessionView } from './views.ts'
import { researchArtifactTools } from './artifact-tools.ts'
import type { ResearchSessionDetailView } from './types.ts'

const PROTOCOL = `You are working inside a long-lived Research Idea.
Use research_session to inspect this Idea's Sessions and processing checkpoints.
Never present an inferred claim as a reported fact. Cite source ids when they exist.
The Research timeline is append-only; archival is not deletion.`

const MAX_BRIEF_LENGTH = 4000

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Synthetic Research Memory context injected at the first step of a turn. */
    'research-memory': { kind: 'research-memory' }
  }
}

function userText(message: { source?: { kind?: string }; content: readonly { type: string; text?: string }[] }): string {
  if (message.source?.kind !== 'user') return ''
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

interface Installation {
  readonly ideaId: string
  dispose(): void
}

/** JSON-safe copy at the model-output boundary. */
function jsonValue(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/**
 * Build the scoped `research_session` tool.
 * @param core - research core service.
 * @param sessionId - owning Session identity; finalize is limited to it.
 * @returns the tool definition.
 */
export function researchSessionTool(core: ResearchCore, sessionId: SessionId) {
  return defineTool({
    name: 'research_session',
    description:
      'Inspect the current Research Idea Sessions and checkpoints. Actions: list (Idea Sessions), '
      + 'get (one binding, checkpoint, and referenced Ideas), finalize (mark the current Session '
      + 'research-complete). Finalize is a research decision, not Session deletion; DSH history remains intact.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'get', 'finalize'] },
      ideaId: { type: 'string', description: 'Idea id for list; defaults to the current binding.' },
      sessionId: { type: 'string', description: 'Session id for get; defaults to the current Session.' },
      summary: { type: 'string', description: 'Optional finalize note.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      await Promise.resolve()
      exec.signal.throwIfAborted()
      const current = core.sessionBindings.getSession(sessionId)
      if (current === undefined) {
        throw new ResearchError('research/session-not-found', `Session "${sessionId}" is not bound`, { sessionId })
      }
      switch (args.action) {
        case 'list': {
          const ideaId = args.ideaId === undefined ? current.ideaId : args.ideaId
          if (ideaId === undefined) return jsonValue({ action: 'list', sessions: [] })
          return jsonValue({
            action: 'list',
            sessions: core.sessionBindings.listSessions(IdeaId(ideaId)).map(toSessionView),
          })
        }
        case 'get': {
          const targetId = args.sessionId === undefined ? sessionId : SessionId(args.sessionId)
          const target = core.sessionBindings.getSession(targetId)
          if (target === undefined) return jsonValue({ action: 'get', session: null, checkpoint: null, links: [] })
          const checkpoint = core.sessionBindings.getCheckpoint(targetId)
          const detail: ResearchSessionDetailView = {
            session: toSessionView(target),
            checkpoint: checkpoint === undefined ? null : toCheckpointView(checkpoint),
            links: core.sessionBindings.listSessionIdeaLinks(targetId).map(link => ({
              sessionId: link.sessionId,
              ideaId: link.ideaId,
              linkType: link.linkType,
              note: link.note,
              createdAt: link.createdAt,
            })),
          }
          return jsonValue({ action: 'get', ...detail })
        }
        case 'finalize': {
          if (args.sessionId !== undefined && args.sessionId !== sessionId) {
            throw new ResearchError('research/invalid-input', 'a Session can only finalize itself', {
              sessionId,
              requested: args.sessionId,
            })
          }
          return jsonValue({
            action: 'finalize',
            session: toSessionView(core.sessionBindings.finalizeSession(sessionId, args.summary)),
          })
        }
        default:
          throw new ResearchError('research/invalid-input', 'unknown research_session action', {
            action: String(args.action),
          })
      }
    },
  })
}

/** Per-Agent Research prompt, context, and scoped-tool installer. */
export class ResearchComposition {
  private readonly installed = new WeakMap<Agent, Installation>()

  /**
   * @param core - research core service.
   */
  constructor(
    private readonly core: ResearchCore,
    private readonly memoryContext?: MemoryContextService,
  ) {}

  /**
   * Install the Research protocol for one binding.
   * @param agentCtx - live Agent scope.
   * @param agent - Agent receiving the composition.
   * @param supplied - binding to install; omitted means read by `agent.id`.
   * @returns whether a new composition was installed.
   */
  install(agentCtx: Context, agent: Agent, supplied?: ResearchSessionBinding): boolean {
    const binding = supplied ?? this.core.sessionBindings.getSession(agent.id)
    if (binding?.ideaId === undefined) return false
    const existing = this.installed.get(agent)
    if (existing !== undefined) {
      if (existing.ideaId === binding.ideaId) return false
      this.uninstall(agent)
    }
    const idea = this.core.ideas.getIdea(binding.ideaId)
    if (idea === undefined) return false
    const recent = this.core.sessionBindings.listSessions(idea.id).slice(0, 3)
    const brief = [
      '# Research Idea',
      `Title: ${idea.title}`,
      `Status: ${idea.status}`,
      `Research question: ${idea.researchQuestion || '(none)'}`,
      `Current summary: ${idea.currentSummary || '(none)'}`,
      recent.length === 0
        ? 'Recent Sessions: (none)'
        : `Recent Sessions: ${recent.map(session => `${session.sessionId} (${session.status})`).join(', ')}`,
      'Use research_session to inspect Session bindings and checkpoints. Structured claims, evidence, and hypotheses arrive in later phases.',
    ].join('\n').slice(0, MAX_BRIEF_LENGTH)
    const disposers: (() => void)[] = []
    try {
      disposers.push(agentCtx.systemPrompt.section({ name: 'research:protocol', order: 500, text: PROTOCOL }))
      disposers.push(agentCtx.systemPrompt.context({ name: 'research:idea-brief', order: 500, required: true, text: brief }))
      if (this.memoryContext !== undefined) {
        disposers.push(agentCtx.systemPrompt.context({
          name: 'research:core-memory',
          order: 501,
          required: true,
          text: () => {
            try {
              return this.memoryContext?.coreContext(idea.id) ?? ''
            } catch (error: unknown) {
              agentCtx.logger.warn(`research: core memory assembly failed: ${String(error)}`)
              return ''
            }
          },
        }))
        disposers.push(agentCtx.on('agent/pre-step', async (payload, next) => {
          if (payload.step !== 1 || this.memoryContext === undefined) return next()
          const query = payload.messages.map(message => userText(message)).filter(text => text !== '').join('\n').trim()
          if (query === '') return next()
          const decision = await next()
          if (decision.kind !== 'enter') return decision
          try {
            const built = this.memoryContext.buildTurn({
              ideaId: idea.id,
              sessionId: agent.id,
              query,
              turn: payload.turn,
              step: payload.step,
            })
            if (built.relevantVisibleText === '') return decision
            return {
              ...decision,
              messages: [...decision.messages, createUserMessage({
                content: [{ type: 'text', text: built.relevantVisibleText }],
                source: { kind: 'research-memory' },
              })],
            }
          } catch (error: unknown) {
            agentCtx.logger.warn(`research: relevant memory injection failed: ${String(error)}`)
            return decision
          }
        }))
      }
      disposers.push(agentCtx.tools.register(researchSessionTool(this.core, agent.id)))
      for (const tool of researchArtifactTools(this.core, agent.id)) {
        disposers.push(agentCtx.tools.register(tool))
      }
    } catch (error: unknown) {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* setup rollback already owns the primary failure */ }
      }
      throw error
    }
    this.installed.set(agent, {
      ideaId: binding.ideaId,
      dispose: () => {
        for (const dispose of disposers.reverse()) {
          try { dispose() } catch { /* scope teardown is best-effort after Agent disposal */ }
        }
      },
    })
    return true
  }

  /**
   * Remove a live composition, if any.
   * @param agent - Agent whose registrations should be removed.
   * @returns whether a composition was removed.
   */
  uninstall(agent: Agent): boolean {
    const existing = this.installed.get(agent)
    if (existing === undefined) return false
    this.installed.delete(agent)
    existing.dispose()
    return true
  }

  /**
   * Whether an Agent currently carries the Research composition.
   * @param agent - candidate Agent.
   * @returns true when installed.
   */
  isInstalled(agent: Agent): boolean {
    return this.installed.has(agent)
  }
}
