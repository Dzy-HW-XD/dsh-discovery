/**
 * Deterministic, Idea-scoped memory retrieval and ranking. FTS5 supplies text
 * recall; lifecycle, epistemic state, provenance, recency, and conflict state
 * shape the final order.
 * @module @deepseek-ai/dsh-research-memory/memory-retrieval
 */

import type ResearchCore from '@deepseek-ai/dsh-research-core'
import type {
  MemoryConflict,
  MemoryEpistemicStatus,
  MemoryLifecycleStatus,
  MemoryType,
  ResearchMemory,
} from '@deepseek-ai/dsh-research-core'

/** Retrieval mode. */
export type MemoryRetrievalMode = 'initial' | 'incremental' | 'explicit-history'

/** One scored memory with a reproducible explanation. */
export interface ScoredMemory {
  readonly memory: ResearchMemory
  readonly layer: 'core' | 'relevant'
  readonly rank: number
  readonly score: number
  readonly textRelevance: number
  readonly epistemicScore: number
  readonly sourceScore: number
  readonly relationScore: number
  readonly recencyScore: number
  readonly conflictPenalty: number
  readonly reasons: readonly string[]
  readonly hasConflict: boolean
}

/** Retrieval result before token budgeting. */
export interface MemoryRetrievalResult {
  readonly core: readonly ScoredMemory[]
  readonly relevant: readonly ScoredMemory[]
  readonly conflicts: readonly MemoryConflict[]
}

/** Ranking and retrieval configuration. */
export interface RetrievalConfig {
  readonly weights?: Readonly<{
    text: number
    epistemic: number
    source: number
    relation: number
    recency: number
    conflict: number
  }>
  readonly relevantLimit?: number
  readonly relationLimit?: number
}

const TYPE_PRIORITY: Readonly<Record<MemoryType, number>> = {
  goal: 1.0, constraint: 0.95, decision: 0.9, strategy: 0.8, fact: 0.78,
  finding: 0.72, open_question: 0.65, hypothesis: 0.55, failure: 0.5, preference: 0.85,
}

const CORE_TYPES = new Set<MemoryType>(['goal', 'constraint', 'decision', 'strategy', 'open_question', 'preference'])

const EPISTEMIC_SCORE: Readonly<Record<MemoryEpistemicStatus, number>> = {
  verified: 1, supported: 0.85, inferred: 0.6, unverified: 0.45, disputed: 0.3, refuted: 0.2,
}

const DEFAULT_WEIGHTS = { text: 0.45, epistemic: 0.2, source: 0.12, relation: 0.08, recency: 0.08, conflict: 0.07 }

const STOP_WORDS = new Set(['why', 'did', 'we', 'choose', 'the', 'old', 'before', 'what', 'was', 'is', 'of', 'in', 'on', 'a', 'an', 'to', 'and', 'or', 'for', 'with', 'how', 'does', 'do', 'this', 'that', 'it', 'our'])

function directQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/gu, ' ')
}

function searchQuery(query: string): string {
  const terms = directQuery(query).split(/[^\p{L}\p{N}]+/u)
    .map(term => term.toLowerCase())
    .filter(term => term.length >= 3 && !STOP_WORDS.has(term))
    .slice(0, 8)
  if (terms.length === 0) return query.trim()
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
}

/** Idea-scoped retrieval engine. */
export class MemoryRetriever {
  private readonly weights: NonNullable<RetrievalConfig['weights']>
  private readonly relevantLimit: number
  private readonly relationLimit: number

  /**
   * @param core - research core service.
   * @param config - ranking weights and limits.
   */
  constructor(private readonly core: ResearchCore, config: RetrievalConfig = {}) {
    this.weights = config.weights ?? DEFAULT_WEIGHTS
    this.relevantLimit = config.relevantLimit ?? 20
    this.relationLimit = config.relationLimit ?? 3
  }

  /**
   * Retrieve Core and Relevant memory for one Idea.
   * @param ideaId - owning Idea.
   * @param query - current user query.
   * @param mode - initial, incremental, or explicit history.
   * @param excludeMemoryIds - already injected memory ids.
   * @returns scored core/relevant memories and open conflicts.
   */
  retrieve(
    ideaId: ResearchMemory['ideaId'],
    query: string,
    mode: MemoryRetrievalMode = 'initial',
    excludeMemoryIds: readonly string[] = [],
  ): MemoryRetrievalResult {
    const all = this.core.memory.listMemories(ideaId)
    const conflicts = this.core.memory.listConflicts(ideaId, 'open')
    const conflicted = new Set(conflicts.flatMap(conflict => [conflict.memoryAId, conflict.memoryBId]))
    const core = all
      .filter(memory => CORE_TYPES.has(memory.memoryType)
        && (memory.lifecycleStatus === 'active' || memory.lifecycleStatus === 'candidate')
        && memory.epistemicStatus !== 'refuted'
        && memory.epistemicStatus !== 'disputed')
      .map(memory => this.score(memory, 0.6, 0, conflicted.has(memory.id), 'core'))
      .sort(this.order)
      .slice(0, 24)
    const statuses: readonly MemoryLifecycleStatus[] = mode === 'explicit-history'
      ? ['active', 'candidate', 'superseded', 'rejected', 'archived']
      : ['active', 'candidate']
    const queryText = directQuery(query)
    const hits = queryText === ''
      ? []
      : this.core.memory.searchMemories(ideaId, searchQuery(queryText), { lifecycleStatuses: statuses, limit: this.relevantLimit + 8 })
    const excluded = new Set([...excludeMemoryIds, ...core.map(item => item.memory.id)])
    const relevant = hits
      .filter(hit => !excluded.has(hit.memory.id))
      .filter(hit => mode === 'explicit-history' || hit.memory.epistemicStatus !== 'refuted')
      .map(hit => this.score(hit.memory, hit.textRelevance, 0, conflicted.has(hit.memory.id), 'relevant'))
      .sort(this.order)
      .slice(0, this.relevantLimit)
    this.expandRelations(relevant, all, conflicted, excluded, mode)
    relevant.sort(this.order)
    return { core, relevant, conflicts }
  }

  private expandRelations(
    relevant: ScoredMemory[],
    all: readonly ResearchMemory[],
    conflicted: ReadonlySet<string>,
    excluded: ReadonlySet<string>,
    mode: MemoryRetrievalMode,
  ): void {
    const present = new Set<string>(relevant.map(item => item.memory.id))
    for (const item of [...relevant]) {
      const related = item.memory.relations
        .filter(relation => relation.entityType === 'memory' && !excluded.has(relation.entityId) && !present.has(relation.entityId))
        .slice(0, this.relationLimit)
      for (const relation of related) {
        const memory = all.find(candidate => candidate.id === relation.entityId)
        if (memory === undefined) continue
        if (mode !== 'explicit-history'
          && !['active', 'candidate'].includes(memory.lifecycleStatus)) continue
        present.add(memory.id)
        relevant.push(this.score(memory, 0.45, 0.5, conflicted.has(memory.id), 'relevant'))
      }
    }
  }

  private score(
    memory: ResearchMemory,
    textRelevance: number,
    relationScore: number,
    hasConflict: boolean,
    layer: 'core' | 'relevant',
  ): ScoredMemory {
    const epistemicScore = EPISTEMIC_SCORE[memory.epistemicStatus]
    const sourceScore = Math.min(1, memory.sources.length / 3)
    const days = Math.max(0, (Date.now() - memory.updatedAt) / 86_400_000)
    const recencyScore = Math.exp(-days / 120)
    const conflictPenalty = hasConflict ? 1 : 0
    const typeBoost = TYPE_PRIORITY[memory.memoryType] / 10
    const score = this.weights.text * textRelevance
      + this.weights.epistemic * epistemicScore
      + this.weights.source * sourceScore
      + this.weights.relation * relationScore
      + this.weights.recency * recencyScore
      - this.weights.conflict * conflictPenalty
      + typeBoost
    const reasons = [
      `text=${textRelevance.toFixed(3)}`,
      `epistemic=${memory.epistemicStatus}`,
      `sources=${String(memory.sources.length)}`,
      `recency=${recencyScore.toFixed(3)}`,
      ...hasConflict ? ['open conflict'] : [],
      `type=${memory.memoryType}`,
    ]
    return {
      memory, layer, rank: 0, score,
      textRelevance, epistemicScore, sourceScore, relationScore,
      recencyScore, conflictPenalty, reasons, hasConflict,
    }
  }

  private readonly order = (left: ScoredMemory, right: ScoredMemory): number => {
    if (right.score !== left.score) return right.score - left.score
    return left.memory.id.localeCompare(right.memory.id)
  }
}
