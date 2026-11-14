/**
 * Cordis service for the research workspace core. The service owns the single
 * SQLite connection and delegates Ideas, Session bindings, checkpoints, and
 * the durable outbox to their repositories.
 * @module @deepseek-ai/dsh-research-core
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ResearchDatabase } from './database.ts'
import { IdeaManager } from './ideas.ts'
import { ResearchOutbox } from './outbox.ts'
import { ResearchSessionManager } from './sessions.ts'
import { ResearchSessionEventProcessor } from './events.ts'
import { ResearchArtifactStore } from './artifacts.ts'
import { ResearchMemoryStore } from './memory-store.ts'
import { ResearchSummaryStore } from './summary-store.ts'
import type {
  AddIdeaRelationInput,
  CreateIdeaInput,
  IdeaId,
  IdeaRelationId,
  ListIdeasFilter,
  ResearchIdea,
  ResearchIdeaRelation,
  ResearchTimelineEvent,
  ResearchChangedEvent,
  UpdateIdeaInput,
} from './types.ts'

export * from './database.ts'
export * from './errors.ts'
export * from './ideas.ts'
export * from './outbox.ts'
export * from './sessions.ts'
export * from './events.ts'
export * from './artifact-types.ts'
export * from './artifacts.ts'
export * from './memory-types.ts'
export * from './memory-repository.ts'
export * from './memory-store.ts'
export * from './summary-types.ts'
export * from './summary-store.ts'
export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    researchCore: ResearchCore
  }
}

/** Deployment configuration for the research database. */
export interface Config {
  /** Directory containing `database.sqlite`; defaults to `$DSH_HOME/research`. */
  readonly root?: string
}

/** Research workspace core service. */
export default class ResearchCore extends Service {
  static Config: z<Config> = z.object({
    root: z.string().default(dshHomePath('research')),
  })

  /** The open Phase 1 database. */
  readonly database: ResearchDatabase
  /** Idea lifecycle and relation operations. */
  readonly ideas: IdeaManager
  /** Session-to-Idea bindings and processing watermarks. */
  readonly sessionBindings: ResearchSessionManager
  /** Durable Research side-effect queue. */
  readonly outbox: ResearchOutbox
  /** Session event processor and recovery owner. */
  readonly events: ResearchSessionEventProcessor
  /** Phase 3 sources, knowledge entities, and research artifacts. */
  readonly artifacts: ResearchArtifactStore
  /** Phase 5 versioned memory store. */
  readonly memory: ResearchMemoryStore
  /** Phase 5 structured Session summaries. */
  readonly summaries: ResearchSummaryStore

  /**
   * @param ctx - Host context owning the service lifetime.
   * @param config - database root.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'researchCore')
    this.database = new ResearchDatabase(config.root ?? dshHomePath('research'))
    this.ideas = new IdeaManager(this.database)
    this.sessionBindings = new ResearchSessionManager(this.database)
    this.outbox = new ResearchOutbox(this.database)
    this.events = new ResearchSessionEventProcessor(ctx, this.database, this.sessionBindings, this.outbox)
    this.artifacts = new ResearchArtifactStore(this.database)
    this.memory = new ResearchMemoryStore(this.database)
    this.memory.rebuildSearchIndex()
    this.summaries = new ResearchSummaryStore(this.database)
    ctx.effect(() => () => {
      this.events.dispose()
      this.database.close()
    }, 'research-core: database')
  }

  /**
   * Create one Idea.
   * @param input - title and optional research fields.
   * @returns the committed Idea.
   */
  createIdea(input: CreateIdeaInput): ResearchIdea {
    const idea = this.ideas.createIdea(input)
    this.emitChanged('idea.created', idea.id)
    return idea
  }

  /**
   * Read one Idea.
   * @param id - Idea identity.
   * @returns the Idea, or undefined.
   */
  getIdea(id: IdeaId): ResearchIdea | undefined {
    return this.ideas.getIdea(id)
  }

  /**
   * Read the parent of one Idea.
   * @param id - child Idea identity.
   * @returns the parent Idea, or undefined for a root Idea.
   */
  parentOf(id: IdeaId): ResearchIdea | undefined {
    return this.ideas.parentOf(id)
  }

  /**
   * List the direct children of one Idea.
   * @param id - parent Idea identity.
   * @returns direct children ordered by most recent update.
   */
  childrenOf(id: IdeaId): ResearchIdea[] {
    return this.ideas.childrenOf(id)
  }

  /**
   * List Ideas.
   * @param filter - status, archive visibility, query, parent, and limit.
   * @returns matching Ideas.
   */
  listIdeas(filter?: ListIdeasFilter): ResearchIdea[] {
    return this.ideas.listIdeas(filter)
  }

  /**
   * Update one Idea under optimistic concurrency.
   * @param id - Idea identity.
   * @param patch - mutable fields.
   * @param expectedVersion - caller-observed version.
   * @returns the committed Idea.
   */
  updateIdea(id: IdeaId, patch: UpdateIdeaInput, expectedVersion: number): ResearchIdea {
    const idea = this.ideas.updateIdea(id, patch, expectedVersion)
    this.emitChanged('idea.updated', idea.id)
    return idea
  }

  /**
   * Archive one Idea.
   * @param id - Idea identity.
   * @param expectedVersion - caller-observed version.
   * @param reason - optional archival reason.
   * @returns the archived Idea.
   */
  archiveIdea(id: IdeaId, expectedVersion: number, reason?: string): ResearchIdea {
    const idea = this.ideas.archiveIdea(id, expectedVersion, reason)
    this.emitChanged('idea.archived', idea.id)
    return idea
  }

  /**
   * Add one directed Idea relation.
   * @param input - endpoints and relation kind.
   * @returns the active relation.
   */
  addIdeaRelation(input: AddIdeaRelationInput): ResearchIdeaRelation {
    const relation = this.ideas.addIdeaRelation(input)
    this.emitChanged('idea.relation-added', relation.fromIdeaId)
    this.emitChanged('idea.relation-added', relation.toIdeaId)
    return relation
  }

  /**
   * Supersede one relation.
   * @param id - relation identity.
   * @returns the superseded relation.
   */
  removeIdeaRelation(id: IdeaRelationId): ResearchIdeaRelation {
    const relation = this.ideas.removeIdeaRelation(id)
    this.emitChanged('idea.relation-removed', relation.fromIdeaId)
    this.emitChanged('idea.relation-removed', relation.toIdeaId)
    return relation
  }

  /**
   * List relations touching one Idea.
   * @param ideaId - Idea identity.
   * @returns relations newest first.
   */
  listIdeaRelations(ideaId: IdeaId): ResearchIdeaRelation[] {
    return this.ideas.listIdeaRelations(ideaId)
  }

  /**
   * Read one Idea's timeline.
   * @param ideaId - Idea identity.
   * @param limit - maximum events.
   * @returns newest-first timeline events.
   */
  listTimeline(ideaId: IdeaId, limit?: number): ResearchTimelineEvent[] {
    return this.ideas.listTimeline(ideaId, limit)
  }

  /** Dispatch one post-commit change envelope; listener failures stay contained. */
  private emitChanged(kind: ResearchChangedEvent['kind'], ideaId: IdeaId): void {
    try {
      this.ctx.emit('research/changed', { schemaVersion: 1, kind, ideaId, occurredAt: Date.now() })
    } catch (error: unknown) {
      this.ctx.logger.warn(`research: change listener failed for ${ideaId}: ${String(error)}`)
    }
  }
}
