/**
 * Host Remote owner and model-facing Phase 1 research tool. The Remote
 * namespace is `research`; the tool is `research_idea`. Both delegate to the
 * single `researchCore` service and never open SQLite themselves.
 * @module @deepseek-ai/dsh-research-tools
 */

import type { Context } from '@deepseek-ai/cordis'
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
import type {
  AddIdeaRelationRequest,
  ArchiveIdeaRequest,
  CreateIdeaRequest,
  GetIdeaRequest,
  IdeaRelationView,
  IdeaView,
  ListIdeaRelationsRequest,
  ListIdeasRequest,
  RemoveIdeaRelationRequest,
  TimelineEventView,
  TimelineRequest,
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
    eventType: event.eventType,
    ...event.entityType === undefined ? {} : { entityType: event.entityType },
    ...event.entityId === undefined ? {} : { entityId: event.entityId },
    summary: event.summary,
    payload: event.payload,
    createdAt: event.createdAt,
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

  /**
   * @param ctx - Host context carrying the research core and tool registry.
   */
  constructor(ctx: Context) {
    super(ctx, 'researchController', { namespace: 'research' })
    const core = ctx.researchCore
    ctx.effect(() => ctx.tools.register(researchIdeaTool(core)), 'research-tools: research_idea')
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
