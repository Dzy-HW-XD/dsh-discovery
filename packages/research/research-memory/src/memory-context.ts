/**
 * Composes retrieval, budgeting, and selection logging for one Agent turn. Core
 * and Relevant are built together so the recorded Selection Log matches the
 * memory versions handed to the Agent.
 * @module @deepseek-ai/dsh-research-memory/memory-context
 */

import type ResearchCore from '@deepseek-ai/dsh-research-core'
import { MemoryId, type IdeaId } from '@deepseek-ai/dsh-research-core'
import { MemoryContextBuilder, type BuiltMemoryContext, type ContextBuilderConfig } from './context-builder.ts'
import { MemoryRetriever, type MemoryRetrievalMode, type RetrievalConfig } from './memory-retrieval.ts'

/** Options accepted by `MemoryContextService`. */
export interface MemoryContextOptions {
  readonly core: ResearchCore
  readonly estimateTokens?: (text: string) => number
  readonly contextConfig?: ContextBuilderConfig
  readonly retrievalConfig?: RetrievalConfig
}

/** Per-turn context and the items actually admitted. */
export interface TurnMemoryContext extends BuiltMemoryContext {
  readonly mode: MemoryRetrievalMode
  readonly coreVisibleText: string
  readonly relevantVisibleText: string
}

const HISTORY_QUERY = /\b(?:history|historical|previous|earlier|before|recall|why did)\b|之前|历史|最早|回顾|为什么/iu

/** Synchronous retrieval/context facade used by Agent hooks. */
export class MemoryContextService {
  private readonly retriever: MemoryRetriever
  private readonly builder: MemoryContextBuilder

  /**
   * @param options - research core, token estimator, and budgets.
   */
  constructor(private readonly options: MemoryContextOptions) {
    this.retriever = new MemoryRetriever(options.core, options.retrievalConfig)
    this.builder = new MemoryContextBuilder({
      ...options.contextConfig,
      ...options.estimateTokens === undefined ? {} : { estimateTokens: options.estimateTokens },
    })
  }

  /**
   * Render only Core Memory for `systemPrompt.context`.
   * @param ideaId - owning Idea.
   * @returns core serialization, or an empty string when no memory is selected.
   */
  coreContext(ideaId: IdeaId): string {
    const result = this.retriever.retrieve(ideaId, '', 'initial')
    return this.builder.build(result).coreText
  }

  /**
   * Build both layers for one turn and record the admitted versions.
   * @param input - Idea, Session, query, turn, and step.
   * @returns context text/items and the chosen mode.
   */
  buildTurn(input: {
    ideaId: IdeaId
    sessionId: string
    query: string
    turn: number
    step: number
  }): TurnMemoryContext {
    const selections = this.options.core.memory.listSelections(input.ideaId, input.sessionId)
    const mode: MemoryRetrievalMode = HISTORY_QUERY.test(input.query)
      ? 'explicit-history'
      : selections.length === 0 ? 'initial' : 'incremental'
    const memories = new Map<string, ReturnType<ResearchCore['memory']['listMemories']>[number]>(
      this.options.core.memory.listMemories(input.ideaId).map(memory => [memory.id, memory]),
    )
    const injectedVersions = new Map<string, number>()
    for (const selection of selections) {
      if (selection.layer !== 'relevant') continue
      injectedVersions.set(selection.memoryId, Math.max(
        injectedVersions.get(selection.memoryId) ?? 0,
        selection.memoryVersion,
      ))
    }
    const excluded = [...injectedVersions].flatMap(([memoryId, version]) => {
      const memory = memories.get(memoryId)
      return memory !== undefined && memory.version <= version ? [memoryId] : []
    })
    const result = this.retriever.retrieve(input.ideaId, input.query, mode, excluded)
    const built = this.builder.build(result)
    this.record(input, built)
    return {
      ...built,
      mode,
      coreVisibleText: built.coreText,
      relevantVisibleText: built.relevantText,
    }
  }

  private record(
    input: { ideaId: IdeaId; sessionId: string; turn: number; step: number },
    built: BuiltMemoryContext,
  ): void {
    const record = (item: BuiltMemoryContext['core'][number], location: 'system-prompt' | 'agent-pre-step'): void => {
      this.options.core.memory.recordSelection({
        sessionId: input.sessionId,
        ideaId: input.ideaId,
        turn: input.turn,
        step: input.step,
        memoryId: MemoryId(item.memoryId),
        rank: item.rank,
        layer: item.layer,
        reason: item.hasConflict ? 'memory selected with open conflict' : `memory selected: ${item.memoryType}`,
        tokenEstimate: item.tokenEstimate,
        memoryVersion: item.version,
        retrievalScore: item.score,
        injectionStatus: 'injected',
        injectionLocation: location,
      })
    }
    for (const item of built.core) record(item, 'system-prompt')
    for (const item of built.relevant) record(item, 'agent-pre-step')
  }
}
