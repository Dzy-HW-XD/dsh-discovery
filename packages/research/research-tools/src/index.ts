/**
 * Host Remote owner and model-facing Phase 1 research tool. The Remote
 * namespace is `research`; the tool is `research_idea`. Both delegate to the
 * single `researchCore` service and never open SQLite themselves.
 * @module @deepseek-ai/dsh-research-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { ExtractorCoordinator, SummaryCoordinator } from '@deepseek-ai/dsh-research-memory'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import ResearchCore, {
  IDEA_RELATION_TYPES,
  IDEA_STATUSES,
  IdeaId,
  IdeaRelationId,
  ResearchError,
  type IdeaRelationType,
  type IdeaStatus,
  type ResearchIdea,
  type ResearchIdeaRelation,
  type ResearchTimelineEvent,
} from '@deepseek-ai/dsh-research-core'
import { ResearchComposition } from './composition.ts'
import { ResearchSessionCreator } from './session-creator.ts'
import { toCheckpointView, toIdeaLinkView, toSessionView } from './views.ts'
import type {
  AddIdeaRelationRequest,
  ArchiveIdeaRequest,
  CreateIdeaRequest,
  CreateResearchSessionRequest,
  FinalizeResearchSessionRequest,
  GetIdeaRequest,
  GetResearchSessionRequest,
  IdeaRelationView,
  IdeaView,
  LinkResearchSessionRequest,
  ListIdeaRelationsRequest,
  ListIdeasRequest,
  ListResearchSessionsRequest,
  RemoveIdeaRelationRequest,
  ResearchSessionDetailView,
  ResearchSessionSummaryView,
  SummarizeSessionRequest,
  ResearchWorkspaceRequest,
  ResearchWorkspaceView,
  SummaryReferenceView,
  WorkspaceEntityView,
  WorkspaceRelationView,
  ResearchSessionView,
  TimelineEventView,
  TimelineRequest,
  UnlinkResearchSessionRequest,
  UpdateIdeaRequest,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    researchController: ResearchController
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'research/idea-not-found': Record<string, string | number | boolean | null>
    'research/relation-not-found': Record<string, string | number | boolean | null>
    'research/session-not-found': Record<string, string | number | boolean | null>
    'research/event-gap': Record<string, string | number | boolean | null>
    'research/outbox-not-found': Record<string, string | number | boolean | null>
    'research/workspace-not-found': Record<string, string | number | boolean | null>
    'research/model-unavailable': Record<string, string | number | boolean | null>
    'research/agent-unavailable': Record<string, string | number | boolean | null>
    'research/source-not-found': Record<string, string | number | boolean | null>
    'research/claim-not-found': Record<string, string | number | boolean | null>
    'research/evidence-not-found': Record<string, string | number | boolean | null>
    'research/hypothesis-not-found': Record<string, string | number | boolean | null>
    'research/artifact-not-found': Record<string, string | number | boolean | null>
    'research/entity-not-found': Record<string, string | number | boolean | null>
    'research/artifact-hash-mismatch': Record<string, string | number | boolean | null>
    'research/duplicate': Record<string, string | number | boolean | null>
    'research/memory-not-found': Record<string, string | number | boolean | null>
    'research/memory-conflict-not-found': Record<string, string | number | boolean | null>
    'research/memory-source-invalid': Record<string, string | number | boolean | null>
    'research/memory-transition-invalid': Record<string, string | number | boolean | null>
    'research/version-conflict': Record<string, string | number | boolean | null>
    'research/invalid-transition': Record<string, string | number | boolean | null>
    'research/invalid-input': Record<string, string | number | boolean | null>
    'research/parent-cycle': Record<string, string | number | boolean | null>
    'research/relation-invalid': Record<string, string | number | boolean | null>
    'research/database-unavailable': Record<string, string | number | boolean | null>
  }
}

/** Convert a domain Idea into the wire-safe view. */
function toIdeaView(idea: ResearchIdea): IdeaView {
  return {
    id: idea.id,
    title: idea.title,
    description: idea.description,
    researchQuestion: idea.researchQuestion,
    objectives: idea.objectives,
    status: idea.status,
    ...idea.parentIdeaId === undefined ? {} : { parentIdeaId: idea.parentIdeaId },
    currentSummary: idea.currentSummary,
    createdAt: idea.createdAt,
    updatedAt: idea.updatedAt,
    ...idea.archivedAt === undefined ? {} : { archivedAt: idea.archivedAt },
    version: idea.version,
    createdBy: idea.createdBy,
  }
}

/** Convert a domain relation into the wire-safe view. */
function toRelationView(relation: ResearchIdeaRelation): IdeaRelationView {
  return {
    id: relation.id,
    fromIdeaId: relation.fromIdeaId,
    toIdeaId: relation.toIdeaId,
    relationType: relation.relationType,
    status: relation.status,
    note: relation.note,
    ...relation.groupId === undefined ? {} : { groupId: relation.groupId },
    ...relation.supersedesRelationId === undefined ? {} : { supersedesRelationId: relation.supersedesRelationId },
    createdBy: relation.createdBy,
    createdAt: relation.createdAt,
  }
}

/** Convert a domain timeline event into the wire-safe view. */
function toTimelineView(event: ResearchTimelineEvent): TimelineEventView {
  return {
    id: event.id,
    ideaId: event.ideaId,
    ...event.sessionId === undefined ? {} : { sessionId: event.sessionId },
    eventType: event.eventType,
    ...event.entityType === undefined ? {} : { entityType: event.entityType },
    ...event.entityId === undefined ? {} : { entityId: event.entityId },
    summary: event.summary,
    payload: event.payload,
    createdAt: event.createdAt,
  }
}

/**
 * Build one compact workspace row.
 * @param kind - entity kind.
 * @param id - domain identity.
 * @param title - display title.
 * @param createdAt - creation timestamp.
 * @param options - optional status and update timestamp.
 * @returns the wire row.
 */
function toWorkspaceEntity(
  kind: string,
  id: string,
  title: string,
  createdAt: number,
  options: { status?: string; updatedAt?: number } = {},
): WorkspaceEntityView {
  return {
    id,
    kind,
    title,
    ...options.status === undefined ? {} : { status: options.status },
    createdAt,
    ...options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt },
  }
}

/**
 * Project one stored Summary to the wire.
 * @param summary - domain Summary.
 * @returns wire-safe Summary.
 */
function toSummaryView(summary: import('@deepseek-ai/dsh-research-core').ResearchSessionSummary): ResearchSessionSummaryView {
  const refs = (items: readonly import('@deepseek-ai/dsh-research-core').SummaryReference[]): SummaryReferenceView[] =>
    items.map(item => ({
      entityType: item.entityType,
      entityId: item.entityId,
      label: item.label,
      ...item.version === undefined ? {} : { version: item.version },
    }))
  return {
    id: summary.id,
    sessionId: summary.sessionId,
    ...summary.ideaId === undefined ? {} : { ideaId: summary.ideaId },
    objective: summary.objective,
    summary: summary.summary,
    keyFindings: refs(summary.keyFindings),
    hypothesesCreated: refs(summary.hypothesesCreated),
    hypothesesValidated: refs(summary.hypothesesValidated),
    hypothesesRejected: refs(summary.hypothesesRejected),
    decisions: refs(summary.decisions),
    failedAttempts: refs(summary.failedAttempts),
    unresolvedQuestions: refs(summary.unresolvedQuestions),
    generatedArtifacts: refs(summary.generatedArtifacts),
    nextSteps: summary.nextSteps,
    sourceReferences: refs(summary.sourceReferences),
    eventStartSeq: summary.eventStartSeq,
    eventEndSeq: summary.eventEndSeq,
    generationVersion: summary.generationVersion,
    generationStatus: summary.generationStatus,
    status: summary.status,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  }
}

/**
 * Convert a domain failure into the wire failure vocabulary; unknown failures
 * remain defects and propagate to the Gateway.
 * @param error - caught failure.
 */
function throwRemote(error: unknown): never {
  if (error instanceof ResearchError) {
    throw new RemoteError(error.code, error.message, error.details)
  }
  throw error
}

/** Validate one status from the wire. */
function admittedStatus(value: string): IdeaStatus {
  if (!(IDEA_STATUSES as readonly string[]).includes(value)) {
    throw new ResearchError('research/invalid-input', `unknown Idea status "${value}"`, { field: 'status' })
  }
  return value as IdeaStatus
}

/** Validate one relation kind from the wire. */
function admittedRelationType(value: string): IdeaRelationType {
  if (!(IDEA_RELATION_TYPES as readonly string[]).includes(value)) {
    throw new ResearchError('research/invalid-input', `unknown relation type "${value}"`, { field: 'relationType' })
  }
  return value as IdeaRelationType
}

/** Host Remote owner for the research namespace. */
export default class ResearchController extends TypertRemoteService {
  static inject = ['researchCore', 'tools']

  private readonly composition: ResearchComposition
  private readonly creator: ResearchSessionCreator
  private readonly summaryCoordinator: SummaryCoordinator | undefined
  private readonly extractionCoordinator: ExtractorCoordinator
  /** Startup reconciliation; tests may await this before asserting Inbox rows. */
  readonly ready: Promise<void>

  /**
   * @param ctx - Host context carrying the research core, Agent registry, and tool registry.
   */
  constructor(ctx: Context) {
    super(ctx, 'researchController', { namespace: 'research' })
    const core = ctx.researchCore
    this.composition = new ResearchComposition(core)
    this.creator = new ResearchSessionCreator(ctx, core, this.composition)
    core.events.setSessionLogReader(ctx.get('sessionQuery'))
    const query = ctx.get('sessionQuery')
    this.summaryCoordinator = query === undefined
      ? undefined
      : new SummaryCoordinator({ core, reader: query, logger: ctx.logger })
    this.summaryCoordinator?.start()
    this.extractionCoordinator = new ExtractorCoordinator({ core, logger: ctx.logger })
    this.extractionCoordinator.start()
    ctx.effect(() => () => {
      this.summaryCoordinator?.dispose()
      this.extractionCoordinator.dispose()
    }, 'research-tools: summary and extraction coordinators')
    ctx.effect(() => ctx.tools.register(researchIdeaTool(core)), 'research-tools: research_idea')

    ctx.on('session/created', (session) => {
      if (session.header.origin === 'subagent') return
      try {
        core.sessionBindings.ensureInboxSession({
          sessionId: session.id,
          ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
          origin: 'unknown',
        })
      } catch (error: unknown) {
        ctx.logger.warn(`research: cannot register Inbox Session ${session.id}: ${String(error)}`)
      }
    })
    ctx.on('session/event', (session, event) => {
      try {
        core.events.observe(session.id, event)
      } catch (error: unknown) {
        ctx.logger.warn(`research: cannot observe Session event ${session.id}/${event.seq}: ${String(error)}`)
      }
    })
    ctx.on('session/disposed', (session) => {
      if (ctx.get('sessionQuery') === undefined || core.sessionBindings.getSession(session.id) === undefined) return
      void core.events.scanSession(session.id)
        .then(() => {
          this.summaryCoordinator?.enqueue(session.id)
          void this.summaryCoordinator?.pump()
        })
        .catch((error: unknown) => {
          ctx.logger.warn(`research: final Session scan failed for ${session.id}: ${String(error)}`)
        })
    })
    ctx.on('agent/created', ({ agent }) => {
      let binding = core.sessionBindings.getSession(agent.id)
      if (binding?.ideaId === undefined) return
      try {
        if (!this.composition.isInstalled(agent) && (binding.status === 'pending' || binding.status === 'failed')) {
          binding = core.sessionBindings.markSessionActive(agent.id)
        }
        this.composition.install(agent.ctx, agent, binding)
      } catch (error: unknown) {
        ctx.logger.warn(`research: agent composition fallback failed for ${agent.id}: ${String(error)}`)
      }
    })
    this.ready = this.reconcile()
  }

  /** Reconcile Inbox rows, pending creations, and missed Session events. */
  private async reconcile(): Promise<void> {
    const ctx = this.ctx
    try {
      const query = ctx.get('sessionQuery')
      if (query !== undefined) {
        for (const record of await query.listSessions()) {
          if (record.header.origin === 'subagent') continue
          try {
            this.ctx.researchCore.sessionBindings.ensureInboxSession({
              sessionId: record.header.id,
              ...record.header.cwd === undefined ? {} : { cwd: record.header.cwd },
              origin: 'unknown',
            })
          } catch (error: unknown) {
            ctx.logger.warn(`research: cannot reconcile Inbox Session ${record.header.id}: ${String(error)}`)
          }
        }
      }
      for (const pending of this.ctx.researchCore.sessionBindings.listPendingSessions()) {
        let exists = this.ctx.sessions.get(pending.sessionId) !== undefined
        if (!exists && query !== undefined) {
          try {
            await query.readSession(pending.sessionId)
            exists = true
          } catch { /* a missing persisted Session is a failed creation */ }
        }
        try {
          if (exists) this.ctx.researchCore.sessionBindings.markSessionActive(pending.sessionId)
          else this.ctx.researchCore.sessionBindings.markSessionFailed(pending.sessionId, 'pending Session did not exist after restart')
        } catch (error: unknown) {
          ctx.logger.warn(`research: cannot reconcile pending Session ${pending.sessionId}: ${String(error)}`)
        }
      }
      await this.ctx.researchCore.events.reconcile()
      await this.summaryCoordinator?.flush()
      await this.extractionCoordinator.flush()
    } catch (error: unknown) {
      ctx.logger.warn(`research: startup reconciliation failed: ${String(error)}`)
    }
  }

  /**
   * List Ideas.
   * @param request - filters.
   * @returns matching wire views.
   */
  @Remote('listIdeas')
  listIdeas(request: ListIdeasRequest): IdeaView[] {
    try {
      return this.ctx.researchCore.listIdeas({
        ...request.status === undefined ? {} : { status: admittedStatus(request.status) },
        ...request.includeArchived === undefined ? {} : { includeArchived: request.includeArchived },
        ...request.query === undefined ? {} : { query: request.query },
        ...request.parentIdeaId === undefined ? {} : { parentIdeaId: IdeaId(request.parentIdeaId) },
        ...request.limit === undefined ? {} : { limit: request.limit },
      }).map(toIdeaView)
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * Read one Idea.
   * @param request - Idea identity.
   * @returns the view, or null.
   */
  @Remote('getIdea')
  getIdea(request: GetIdeaRequest): IdeaView | null {
    try {
      const idea = this.ctx.researchCore.getIdea(IdeaId(request.ideaId))
      return idea === undefined ? null : toIdeaView(idea)
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * Create one Idea.
   * @param request - title and optional fields.
   * @returns the created view.
   */
  @Remote('createIdea')
  createIdea(request: CreateIdeaRequest): IdeaView {
    try {
      return toIdeaView(this.ctx.researchCore.createIdea({
        title: request.title,
        ...request.description === undefined ? {} : { description: request.description },
        ...request.researchQuestion === undefined ? {} : { researchQuestion: request.researchQuestion },
        ...request.objectives === undefined ? {} : { objectives: request.objectives },
        ...request.status === undefined ? {} : { status: admittedStatus(request.status) },
        ...request.parentIdeaId === undefined ? {} : { parentIdeaId: IdeaId(request.parentIdeaId) },
        ...request.currentSummary === undefined ? {} : { currentSummary: request.currentSummary },
      }))
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * Update one Idea under optimistic concurrency.
   * @param request - Idea, expected version, and patch.
   * @returns the committed view.
   */
  @Remote('updateIdea')
  updateIdea(request: UpdateIdeaRequest): IdeaView {
    try {
      return toIdeaView(this.ctx.researchCore.updateIdea(IdeaId(request.ideaId), {
        ...request.title === undefined ? {} : { title: request.title },
        ...request.description === undefined ? {} : { description: request.description },
        ...request.researchQuestion === undefined ? {} : { researchQuestion: request.researchQuestion },
        ...request.objectives === undefined ? {} : { objectives: request.objectives },
        ...request.status === undefined ? {} : { status: admittedStatus(request.status) },
        ...request.parentIdeaId === undefined ? {} : {
          parentIdeaId: request.parentIdeaId === null ? null : IdeaId(request.parentIdeaId),
        },
        ...request.currentSummary === undefined ? {} : { currentSummary: request.currentSummary },
      }, request.expectedVersion))
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * Archive one Idea.
   * @param request - Idea, expected version, and optional reason.
   * @returns the archived view.
   */
  @Remote('archiveIdea')
  archiveIdea(request: ArchiveIdeaRequest): IdeaView {
    try {
      return toIdeaView(this.ctx.researchCore.archiveIdea(
        IdeaId(request.ideaId), request.expectedVersion, request.reason,
      ))
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * Add one directed Idea relation.
   * @param request - endpoints and kind.
   * @returns the active relation view.
   */
  @Remote('addIdeaRelation')
  addIdeaRelation(request: AddIdeaRelationRequest): IdeaRelationView {
    try {
      return toRelationView(this.ctx.researchCore.addIdeaRelation({
        fromIdeaId: IdeaId(request.fromIdeaId),
        toIdeaId: IdeaId(request.toIdeaId),
        relationType: admittedRelationType(request.relationType),
        ...request.note === undefined ? {} : { note: request.note },
        ...request.groupId === undefined ? {} : { groupId: request.groupId },
      }))
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * Supersede one relation.
   * @param request - relation identity.
   * @returns the superseded relation view.
   */
  @Remote('removeIdeaRelation')
  removeIdeaRelation(request: RemoveIdeaRelationRequest): IdeaRelationView {
    try {
      return toRelationView(this.ctx.researchCore.removeIdeaRelation(IdeaRelationId(request.relationId)))
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * List relations touching one Idea.
   * @param request - Idea identity.
   * @returns relation views newest first.
   */
  @Remote('listIdeaRelations')
  listIdeaRelations(request: ListIdeaRelationsRequest): IdeaRelationView[] {
    try {
      return this.ctx.researchCore.listIdeaRelations(IdeaId(request.ideaId)).map(toRelationView)
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * Read one Idea timeline.
   * @param request - Idea identity and limit.
   * @returns timeline views newest first.
   */
  @Remote('listTimeline')
  listTimeline(request: TimelineRequest): TimelineEventView[] {
    try {
      return this.ctx.researchCore.listTimeline(IdeaId(request.ideaId), request.limit).map(toTimelineView)
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * Read the Phase 3 workspace projection for one Idea.
   * @param request - Idea identity.
   * @returns counts, compact entity rows, relations, Sessions, and timeline.
   */
  @Remote('getWorkspace')
  getWorkspace(request: ResearchWorkspaceRequest): ResearchWorkspaceView {
    try {
      const ideaId = IdeaId(request.ideaId)
      const core = this.ctx.researchCore
      const store = core.artifacts
      const entities: WorkspaceEntityView[] = [
        ...store.listSources(ideaId).map(source => toWorkspaceEntity('source', source.id, source.title, source.createdAt,
          { status: source.status, updatedAt: source.updatedAt })),
        ...store.listConcepts(ideaId).map(concept => toWorkspaceEntity('concept', concept.id, concept.name, concept.createdAt,
          { status: concept.status, updatedAt: concept.updatedAt })),
        ...store.listClaims(ideaId).map(claim => toWorkspaceEntity('claim', claim.id, claim.statement, claim.createdAt,
          { status: claim.status, updatedAt: claim.updatedAt })),
        ...store.listEvidence(ideaId).map(evidence => toWorkspaceEntity('evidence', evidence.id,
          evidence.quote === '' ? `Evidence (${evidence.evidenceType})` : evidence.quote, evidence.createdAt,
          { status: evidence.epistemicStatus, updatedAt: evidence.updatedAt })),
        ...store.listQuestions(ideaId).map(question => toWorkspaceEntity('question', question.id, question.question,
          question.createdAt, { status: question.status, updatedAt: question.updatedAt })),
        ...store.listGaps(ideaId).map(gap => toWorkspaceEntity('gap', gap.id, gap.gapDescription, gap.createdAt,
          { status: gap.status, updatedAt: gap.updatedAt })),
        ...store.listHypotheses(ideaId).map(hypothesis => toWorkspaceEntity('hypothesis', hypothesis.id, hypothesis.title,
          hypothesis.createdAt, { status: hypothesis.status, updatedAt: hypothesis.updatedAt })),
        ...store.listDiscoveries(ideaId).map(discovery => toWorkspaceEntity('discovery', discovery.id, discovery.description,
          discovery.createdAt, { status: discovery.status, updatedAt: discovery.updatedAt })),
        ...store.listDecisions(ideaId).map(decision => toWorkspaceEntity('decision', decision.id, decision.title,
          decision.createdAt)),
        ...store.listArtifacts(ideaId).map(artifact => toWorkspaceEntity('artifact', artifact.id, artifact.title,
          artifact.createdAt, { status: artifact.status, updatedAt: artifact.updatedAt })),
        ...store.listBranches(ideaId).map(branch => toWorkspaceEntity('branch', branch.id, branch.title,
          branch.createdAt, { status: branch.status, updatedAt: branch.updatedAt })),
      ]
      const relations: WorkspaceRelationView[] = store.listKnowledgeRelations(ideaId).map(relation => ({
        id: relation.id,
        fromEntityType: relation.fromEntityType,
        fromEntityId: relation.fromEntityId,
        toEntityType: relation.toEntityType,
        toEntityId: relation.toEntityId,
        relationType: relation.relationType,
        confidence: relation.confidence,
        status: relation.status,
      }))
      return {
        counts: store.countEntities(ideaId),
        entities,
        relations,
        sessions: core.sessionBindings.listSessions(ideaId).map(toSessionView),
        timeline: core.ideas.listTimeline(ideaId).map(toTimelineView),
      }
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * Generate and return the latest Session summary.
   * @param request - Session identity.
   * @returns the latest summary, or null for an unbound Session.
   */
  @Remote('summarizeSession')
  async summarizeSession(request: SummarizeSessionRequest): Promise<ResearchSessionSummaryView | null> {
    try {
      if (this.summaryCoordinator === undefined) {
        throw new ResearchError('research/database-unavailable', 'Session query is not mounted', {})
      }
      const summary = await this.summaryCoordinator.summarizeNow(SessionId(request.sessionId))
      await this.extractionCoordinator.flush()
      return summary === undefined ? null : toSummaryView(summary)
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * Create one Research Session under an Idea through `ctx.agents.create({ setup })`.
   * @param request - Idea, optional cwd, and optional Workspace.
   * @returns the active Session binding.
   */
  @Remote('createSession')
  async createSession(request: CreateResearchSessionRequest): Promise<ResearchSessionView> {
    try {
      return await this.creator.create(request)
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * List one Idea's Sessions.
   * @param request - Idea and archive visibility.
   * @returns Session views.
   */
  @Remote('listSessions')
  listSessions(request: ListResearchSessionsRequest): ResearchSessionView[] {
    try {
      return this.ctx.researchCore.sessionBindings
        .listSessions(IdeaId(request.ideaId), request.includeArchived)
        .map(toSessionView)
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * List unbound Inbox Sessions.
   * @returns Session views.
   */
  @Remote('listInboxSessions')
  listInboxSessions(): ResearchSessionView[] {
    return this.ctx.researchCore.sessionBindings.listInboxSessions().map(toSessionView)
  }

  /**
   * Read one Session with its checkpoint and referenced Ideas.
   * @param request - Session identity.
   * @returns the detail, or null.
   */
  @Remote('getSession')
  getSession(request: GetResearchSessionRequest): ResearchSessionDetailView | null {
    try {
      const sessionId = SessionId(request.sessionId)
      const binding = this.ctx.researchCore.sessionBindings.getSession(sessionId)
      if (binding === undefined) return null
      const checkpoint = this.ctx.researchCore.sessionBindings.getCheckpoint(sessionId)
      return {
        session: toSessionView(binding),
        checkpoint: checkpoint === undefined ? null : toCheckpointView(checkpoint),
        links: this.ctx.researchCore.sessionBindings.listSessionIdeaLinks(sessionId).map(toIdeaLinkView),
      }
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * Link an existing Session to an Idea.
   * @param request - Session and target Idea.
   * @returns the active binding.
   */
  @Remote('linkSession')
  linkSession(request: LinkResearchSessionRequest): ResearchSessionView {
    try {
      const binding = this.ctx.researchCore.sessionBindings.linkSessionToIdea(
        SessionId(request.sessionId), IdeaId(request.ideaId),
      )
      try {
        this.creator.installForLiveBinding(binding)
      } catch (error: unknown) {
        this.ctx.logger.warn(`research: live composition failed for linked Session ${request.sessionId}: ${String(error)}`)
      }
      void this.ctx.researchCore.events.scanSession(binding.sessionId).catch((error: unknown) => {
        this.ctx.logger.warn(`research: linked Session scan failed for ${request.sessionId}: ${String(error)}`)
      })
      return toSessionView(binding)
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * Return a Session to the Inbox.
   * @param request - Session identity.
   * @returns the Inbox binding.
   */
  @Remote('unlinkSession')
  unlinkSession(request: UnlinkResearchSessionRequest): ResearchSessionView {
    try {
      const binding = this.ctx.researchCore.sessionBindings.unlinkSession(SessionId(request.sessionId))
      this.creator.uninstallForLiveSession(binding.sessionId)
      return toSessionView(binding)
    } catch (error) {
      throwRemote(error)
    }
  }

  /**
   * Finalize one Session's research lifecycle.
   * @param request - Session and optional summary.
   * @returns the finalized binding.
   */
  @Remote('finalizeSession')
  finalizeSession(request: FinalizeResearchSessionRequest): ResearchSessionView {
    try {
      const sessionId = SessionId(request.sessionId)
      const current = this.ctx.researchCore.sessionBindings.getSession(sessionId)
      if (current === undefined) {
        throw new ResearchError('research/session-not-found', `Session "${sessionId}" not found`, { sessionId })
      }
      if (current.ideaId === undefined) {
        throw new ResearchError('research/invalid-input', 'an Inbox Session has no primary Idea to finalize', { sessionId })
      }
      if (current.status !== 'finalized' && current.status !== 'finalizing') {
        this.ctx.researchCore.sessionBindings.markSessionFinalizing(sessionId)
      }
      const finalized = this.ctx.researchCore.sessionBindings.finalizeSession(sessionId, request.summary)
      this.summaryCoordinator?.enqueue(sessionId)
      void this.summaryCoordinator?.pump()
      return toSessionView(finalized)
    } catch (error) {
      throwRemote(error)
    }
  }
}

/**
 * Build the single consolidated Phase 1 Idea tool.
 * @param core - research core service.
 * @returns the registered tool definition.
 */
function researchIdeaTool(core: ResearchCore) {
  return defineTool({
    name: 'research_idea',
    description:
      'Manage long-lived research Ideas and their relations. Use actions create/list/get/update/archive/'
      + 'add_relation/remove_relation/list_relations/timeline. Parent/child is set with parentIdeaId; '
      + 'relations are directed: related_to (symmetric), derived_from, merged_from, references. '
      + 'Archive is not deletion.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'list', 'get', 'update', 'archive', 'add_relation', 'remove_relation', 'list_relations', 'timeline'],
        description: 'Operation to perform.',
      },
      ideaId: { type: 'string', description: 'Idea id for get/update/archive/list_relations/timeline.' },
      title: { type: 'string', description: 'Idea title for create/update.' },
      description: { type: 'string', description: 'Idea description.' },
      researchQuestion: { type: 'string', description: 'Primary research question.' },
      objectives: { type: 'array', items: { type: 'string' }, description: 'Research objectives.' },
      status: { type: 'string', enum: IDEA_STATUSES, description: 'Idea lifecycle state.' },
      parentIdeaId: { type: 'string', description: 'Parent Idea id; omit on update to keep, use empty string to clear.' },
      currentSummary: { type: 'string', description: 'Current research summary.' },
      expectedVersion: { type: 'number', description: 'Required for update/archive; stale versions are rejected.' },
      reason: { type: 'string', description: 'Optional archive reason.' },
      query: { type: 'string', description: 'Literal title/description/research-question search.' },
      includeArchived: { type: 'boolean', description: 'Include archived Ideas in list results.' },
      limit: { type: 'number', description: 'Maximum rows for list/timeline.' },
      fromIdeaId: { type: 'string', description: 'Relation source Idea.' },
      toIdeaId: { type: 'string', description: 'Relation target Idea.' },
      relationType: { type: 'string', enum: IDEA_RELATION_TYPES, description: 'Directed relation kind.' },
      note: { type: 'string', description: 'Human-readable relation note.' },
      groupId: { type: 'string', description: 'Optional group for a merge/derive operation.' },
      relationId: { type: 'string', description: 'Relation id for remove_relation.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const require = (value: string | undefined, field: string): string => {
        if (value === undefined || value.trim().length === 0) {
          throw new ResearchError('research/invalid-input', `${field} is required for ${args.action}`, { field })
        }
        return value
      }
      const requireVersion = (value: number | undefined): number => {
        if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
          throw new ResearchError('research/invalid-input', `expectedVersion is required for ${args.action}`, {
            field: 'expectedVersion',
          })
        }
        return value
      }
      const result = ((): object => {
        switch (args.action) {
          case 'create':
            return {
              action: 'create',
              idea: toIdeaView(core.createIdea({
                title: require(args.title, 'title'),
                ...args.description === undefined ? {} : { description: args.description },
                ...args.researchQuestion === undefined ? {} : { researchQuestion: args.researchQuestion },
                ...args.objectives === undefined ? {} : { objectives: args.objectives },
                ...args.status === undefined ? {} : { status: admittedStatus(args.status) },
                ...args.parentIdeaId === undefined || args.parentIdeaId.length === 0 ? {} : { parentIdeaId: IdeaId(args.parentIdeaId) },
                ...args.currentSummary === undefined ? {} : { currentSummary: args.currentSummary },
              })),
            }
          case 'list':
            return {
              action: 'list',
              ideas: core.listIdeas({
                ...args.status === undefined ? {} : { status: admittedStatus(args.status) },
                ...args.includeArchived === undefined ? {} : { includeArchived: args.includeArchived },
                ...args.query === undefined ? {} : { query: args.query },
                ...args.parentIdeaId === undefined || args.parentIdeaId.length === 0 ? {} : { parentIdeaId: IdeaId(args.parentIdeaId) },
                ...args.limit === undefined ? {} : { limit: args.limit },
              }).map(toIdeaView),
            }
          case 'get': {
            const idea = core.getIdea(IdeaId(require(args.ideaId, 'ideaId')))
            return { action: 'get', idea: idea === undefined ? null : toIdeaView(idea) }
          }
          case 'update':
            return {
              action: 'update',
              idea: toIdeaView(core.updateIdea(IdeaId(require(args.ideaId, 'ideaId')), {
                ...args.title === undefined ? {} : { title: args.title },
                ...args.description === undefined ? {} : { description: args.description },
                ...args.researchQuestion === undefined ? {} : { researchQuestion: args.researchQuestion },
                ...args.objectives === undefined ? {} : { objectives: args.objectives },
                ...args.status === undefined ? {} : { status: admittedStatus(args.status) },
                ...args.parentIdeaId === undefined ? {} : {
                  parentIdeaId: args.parentIdeaId.length === 0 ? null : IdeaId(args.parentIdeaId),
                },
                ...args.currentSummary === undefined ? {} : { currentSummary: args.currentSummary },
              }, requireVersion(args.expectedVersion))),
            }
          case 'archive':
            return {
              action: 'archive',
              idea: toIdeaView(core.archiveIdea(
                IdeaId(require(args.ideaId, 'ideaId')),
                requireVersion(args.expectedVersion),
                args.reason,
              )),
            }
          case 'add_relation':
            return {
              action: 'add_relation',
              relation: toRelationView(core.addIdeaRelation({
                fromIdeaId: IdeaId(require(args.fromIdeaId, 'fromIdeaId')),
                toIdeaId: IdeaId(require(args.toIdeaId, 'toIdeaId')),
                relationType: admittedRelationType(require(args.relationType, 'relationType')),
                ...args.note === undefined ? {} : { note: args.note },
                ...args.groupId === undefined ? {} : { groupId: args.groupId },
              })),
            }
          case 'remove_relation':
            return {
              action: 'remove_relation',
              relation: toRelationView(core.removeIdeaRelation(IdeaRelationId(require(args.relationId, 'relationId')))),
            }
          case 'list_relations':
            return {
              action: 'list_relations',
              relations: core.listIdeaRelations(IdeaId(require(args.ideaId, 'ideaId'))).map(toRelationView),
            }
          case 'timeline':
            return {
              action: 'timeline',
              events: core.listTimeline(IdeaId(require(args.ideaId, 'ideaId')), args.limit).map(toTimelineView),
            }
          default:
            throw new ResearchError('research/invalid-input', 'unknown research_idea action', { action: String(args.action) })
        }
      })()
      await Promise.resolve()
      return JSON.parse(JSON.stringify(result)) as JsonValue
    },
  })
}
