/**
 * Research Session creation over `ctx.agents.create({ setup })`. The pending
 * binding is written before the DSH Session exists so setup can read it and
 * install the Research composition before the Agent is published.
 * @module @deepseek-ai/dsh-research-tools/session-creator
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-workspace'
import ResearchCore, { IdeaId, ResearchError, type ResearchSessionBinding } from '@deepseek-ai/dsh-research-core'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { ResearchComposition } from './composition.ts'
import { toSessionView } from './views.ts'
import type { CreateResearchSessionRequest, ResearchSessionView } from './types.ts'

/** Create Research Sessions and persist the pending binding before publication. */
export class ResearchSessionCreator {
  /**
   * @param ctx - Host context carrying the Agent registry, defaults, and Workspaces.
   * @param core - research core service.
   * @param composition - per-Agent Research installer.
   */
  constructor(
    private readonly ctx: Context,
    private readonly core: ResearchCore,
    private readonly composition: ResearchComposition,
  ) {}

  /**
   * Create one Session under an Idea.
   * @param request - Idea identity, optional cwd, and optional Workspace.
   * @returns the active binding.
   */
  async create(request: CreateResearchSessionRequest): Promise<ResearchSessionView> {
    const idea = this.core.ideas.getIdea(IdeaId(request.ideaId))
    if (idea === undefined) {
      throw new ResearchError('research/idea-not-found', `Idea "${request.ideaId}" not found`, {
        ideaId: request.ideaId,
      })
    }
    const workspace = request.workspaceId === undefined
      ? undefined
      : this.ctx.get('workspaceRegistry')?.get(WorkspaceId(request.workspaceId))
    if (request.workspaceId !== undefined && workspace === undefined) {
      throw new ResearchError('research/workspace-not-found', `Workspace "${request.workspaceId}" not found`, {
        workspaceId: request.workspaceId,
      })
    }
    const cwd = resolve(workspace?.path ?? request.cwd ?? idea.workspacePath ?? process.cwd())
    if (!isAbsolute(cwd)) {
      throw new ResearchError('research/invalid-input', 'research Session cwd must be absolute', { cwd })
    }
    try {
      await mkdir(cwd, { recursive: true })
    } catch (error: unknown) {
      throw new ResearchError('research/invalid-input', `cannot create research Session cwd "${cwd}"`, {
        cwd,
        cause: error instanceof Error ? error.message : String(error),
      })
    }
    const defaults = this.ctx.get('agentDefaultModel')
    if (defaults === undefined) {
      throw new ResearchError('research/model-unavailable', 'Agent default model is not mounted', {})
    }
    const selection = defaults.currentSelection()
    const agentOptions: AgentOptions = {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }
    const sessionId = SessionId(`session-${randomUUID()}`)
    const pending = this.core.sessionBindings.createPendingSession({
      sessionId,
      ideaId: idea.id,
      cwd,
      ...workspace === undefined ? {} : { workspaceId: workspace.id },
      origin: 'ui',
    })
    const agents = this.ctx.get('agents')
    if (agents === undefined) {
      throw new ResearchError('research/agent-unavailable', 'Agent registry is not mounted', {})
    }
    let handle: AgentHandle | undefined
    try {
      handle = await agents.create({
        sessionId,
        meta: { cwd },
        agentOptions,
        setup: (agentCtx, agent) => {
          if (!this.composition.install(agentCtx, agent, pending)) {
            throw new ResearchError('research/session-not-found', 'research Session binding disappeared during setup', {
              sessionId,
            })
          }
        },
      })
      if (workspace !== undefined) {
        try {
          await workspace.attachSession(sessionId)
        } catch (error: unknown) {
          throw new ResearchError('research/invalid-input', `research Session could not attach to Workspace "${workspace.id}"`, {
            sessionId,
            workspaceId: workspace.id,
            cause: error instanceof Error ? error.message : String(error),
          })
        }
      }
      const active = this.core.sessionBindings.markSessionActive(sessionId)
      return toSessionView(active)
    } catch (error: unknown) {
      await handle?.dispose().catch(() => { /* creation failure remains primary */ })
      try {
        this.core.sessionBindings.markSessionFailed(sessionId, error instanceof Error ? error.message : String(error))
      } catch (markError: unknown) {
        this.ctx.logger.warn(`research: cannot mark failed Session ${sessionId}: ${String(markError)}`)
      }
      throw error
    }
  }

  /**
   * Install Research composition on an already-live bound Agent.
   * @param binding - current binding.
   * @returns whether a composition was installed.
   */
  installForLiveBinding(binding: ResearchSessionBinding): boolean {
    const agent = this.ctx.get('agents')?.get(binding.sessionId)
    return agent === undefined ? false : this.composition.install(agent.ctx, agent, binding)
  }

  /**
   * Remove Research composition from a live Agent.
   * @param sessionId - DSH Session identity.
   * @returns whether a composition was removed.
   */
  uninstallForLiveSession(sessionId: SessionId): boolean {
    const agent = this.ctx.get('agents')?.get(sessionId)
    return agent === undefined ? false : this.composition.uninstall(agent)
  }
}
