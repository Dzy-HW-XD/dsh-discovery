/**
 * Research workspace browser half: one `main` keyed panel and its sidebar
 * entry. The panel consumes the generated `research` Remote namespace.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-research-tools/remote'
import type {
  AddIdeaRelationRequest,
  ArchiveIdeaRequest,
  CreateIdeaRequest,
  GetIdeaRequest,
  IdeaRelationView,
  IdeaView,
  ListIdeaRelationsRequest,
  ListIdeasRequest,
  ListResearchSessionsRequest,
  ResearchWorkspaceRequest,
  TimelineEventView,
  TimelineRequest,
  UpdateIdeaRequest,
} from '@deepseek-ai/dsh-research-tools/types'
import { ResearchPanel, type ResearchPanelInjected } from './ResearchPanel.tsx'
import { ResearchPanelIcon } from './ResearchPanelIcon.tsx'
import { en, ja, es, fr, de, ru, pt, zh, NS } from './locales.ts'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'research' as MainPanelId

/** Services required by the panel, its Remote calls, and localized copy. */
export const inject = ['slots', 'locale', 'remote', 'remote.research', 'layout', 'uiWorkspace'] as const

async function unwrap<T>(result: Promise<RemoteResult<T>>): Promise<T> {
  const settled = await result
  if (!settled.ok) throw settled.error
  return settled.value
}

/** Build the panel's Host-operation face over the generated Remote contract. */
function panelInject(ctx: ClientContext): ResearchPanelInjected {
  return {
    listIdeas: (request: ListIdeasRequest) => unwrap(ctx.remote.research.listIdeas(request)),
    getIdea: (ideaId: string) => unwrap(ctx.remote.research.getIdea({ ideaId } satisfies GetIdeaRequest)),
    createIdea: (request: CreateIdeaRequest) => unwrap(ctx.remote.research.createIdea(request)),
    updateIdea: (request: UpdateIdeaRequest) => unwrap(ctx.remote.research.updateIdea(request)),
    archiveIdea: (request: ArchiveIdeaRequest) => unwrap(ctx.remote.research.archiveIdea(request)),
    addIdeaRelation: (request: AddIdeaRelationRequest) => unwrap(ctx.remote.research.addIdeaRelation(request)),
    listIdeaRelations: (ideaId: string) => unwrap(ctx.remote.research.listIdeaRelations({ ideaId } satisfies ListIdeaRelationsRequest)),
    listTimeline: (ideaId: string) => unwrap(ctx.remote.research.listTimeline({ ideaId } satisfies TimelineRequest)),
    getWorkspace: (ideaId: string) => unwrap(ctx.remote.research.getWorkspace({ ideaId } satisfies ResearchWorkspaceRequest)),
    listSessions: (ideaId: string) => unwrap(ctx.remote.research.listSessions({ ideaId } satisfies ListResearchSessionsRequest)),
    listInboxSessions: () => unwrap(ctx.remote.research.listInboxSessions()),
    createSession: (ideaId: string) => unwrap(ctx.remote.research.createSession({ ideaId })),
    linkSession: (sessionId: string, ideaId: string) => unwrap(ctx.remote.research.linkSession({ sessionId, ideaId })),
    unlinkSession: (sessionId: string) => unwrap(ctx.remote.research.unlinkSession({ sessionId })),
    finalizeSession: (sessionId: string) => unwrap(ctx.remote.research.finalizeSession({ sessionId })),
    openSession: (sessionId: string) => { ctx.uiWorkspace.openSession(sessionId as SessionId) },
  }
}

/**
 * Register the Research main panel and sidebar entry.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-research-workspace: dictionaries')
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => panelInject(ctx),
  }, ResearchPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: -100,
    label: () => ctx.locale.bind(NS)('panel'),
    locale: NS,
  }, ResearchPanelIcon))
}

export { ResearchPanel, ResearchPanelIcon }
export type { IdeaView, IdeaRelationView, TimelineEventView, ResearchPanelInjected }
