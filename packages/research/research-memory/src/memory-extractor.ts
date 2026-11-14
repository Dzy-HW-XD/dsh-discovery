/**
 * Entity-first memory extraction. Candidates come from canonical Research DB
 * entities referenced by a Session summary; Summary prose alone never becomes
 * a fact. Extractor output is always lifecycle `candidate`.
 * @module @deepseek-ai/dsh-research-memory/memory-extractor
 */

import type ResearchCore from '@deepseek-ai/dsh-research-core'
import {
  type MemoryEntityType,
  type MemoryEpistemicStatus,
  type MemorySourceInput,
  type MemoryType,
  type ResearchClaim,
  type ResearchEvidence,
  type ResearchHypothesis,
  type ResearchSessionSummary,
  type SummaryReference,
} from '@deepseek-ai/dsh-research-core'
import type { IdeaId } from '@deepseek-ai/dsh-research-core'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Tunable duplicate/conflict thresholds. */
export interface ExtractorConfig {
  readonly updateThreshold?: number
  readonly duplicateThreshold?: number
  readonly conflictThreshold?: number
}

/** One candidate draft before deduplication. */
interface CandidateDraft {
  readonly memoryType: MemoryType
  readonly title: string
  readonly content: string
  readonly structured: Record<string, unknown>
  readonly epistemicStatus: MemoryEpistemicStatus
  readonly sources: readonly MemorySourceInput[]
  readonly entityType: MemoryEntityType
  readonly entityId: string
  readonly entityVersion?: number
}

/** Result counts from one extraction pass. */
export interface ExtractionResult {
  readonly created: number
  readonly updated: number
  readonly unchanged: number
  readonly conflicts: number
  readonly skipped: number
}

const DEFAULT_UPDATE = 0.85
const DEFAULT_DUPLICATE = 0.65
const DEFAULT_CONFLICT = 0.5
const PROCEDURE_START = /^(?:use|run|apply|start|record|check|measure|test|configure|enable|disable|execute|collect)\b/iu

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ')
}

function tokens(value: string): Set<string> {
  return new Set(normalize(value).split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 1))
}

function similarity(left: string, right: string): number {
  const a = tokens(left)
  const b = tokens(right)
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function label(value: string, limit: number = 240): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map(item => [item.id, item]))
}

function referenceKey(reference: SummaryReference): string {
  return `${reference.entityType}:${reference.entityId}`
}

function allReferences(summary: ResearchSessionSummary): SummaryReference[] {
  const seen = new Set<string>()
  const refs: SummaryReference[] = []
  for (const reference of [
    ...summary.keyFindings,
    ...summary.hypothesesCreated,
    ...summary.hypothesesValidated,
    ...summary.hypothesesRejected,
    ...summary.decisions,
    ...summary.failedAttempts,
    ...summary.unresolvedQuestions,
    ...summary.generatedArtifacts,
    ...summary.sourceReferences,
  ]) {
    const key = referenceKey(reference)
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(reference)
  }
  return refs
}

/**
 * Deterministic memory extractor over one Summary and its canonical entities.
 */
export class MemoryExtractor {
  private readonly updateThreshold: number
  private readonly duplicateThreshold: number
  private readonly conflictThreshold: number

  /**
   * @param core - research core service.
   * @param config - optional similarity thresholds.
   */
  constructor(private readonly core: ResearchCore, config: ExtractorConfig = {}) {
    this.updateThreshold = config.updateThreshold ?? DEFAULT_UPDATE
    this.duplicateThreshold = config.duplicateThreshold ?? DEFAULT_DUPLICATE
    this.conflictThreshold = config.conflictThreshold ?? DEFAULT_CONFLICT
  }

  /**
   * Extract candidate memories for one Summary row.
   * @param summary - persisted structured Summary.
   * @param extractionJobId - outbox row identity used for provenance.
   * @returns extraction counts.
   */
  extract(summary: ResearchSessionSummary, extractionJobId: string): ExtractionResult {
    if (summary.ideaId === undefined) return { created: 0, updated: 0, unchanged: 0, conflicts: 0, skipped: 0 }
    const ideaId = summary.ideaId
    const claims = byId(this.core.artifacts.listClaims(ideaId))
    const evidence = this.core.artifacts.listEvidence(ideaId)
    const hypotheses = byId(this.core.artifacts.listHypotheses(ideaId))
    const questions = byId(this.core.artifacts.listQuestions(ideaId))
    const gaps = byId(this.core.artifacts.listGaps(ideaId))
    const decisions = byId(this.core.artifacts.listDecisions(ideaId))
    const discoveries = byId(this.core.artifacts.listDiscoveries(ideaId))
    const drafts: CandidateDraft[] = []
    const refs = allReferences(summary)

    for (const reference of refs) {
      switch (reference.entityType) {
        case 'claim': {
          const claim = claims.get(reference.entityId)
          if (claim !== undefined) drafts.push(...this.claimDrafts(summary, claim, evidence))
          break
        }
        case 'hypothesis': {
          const hypothesis = hypotheses.get(reference.entityId)
          if (hypothesis !== undefined) drafts.push(this.hypothesisDraft(summary, hypothesis))
          break
        }
        case 'question': {
          const question = questions.get(reference.entityId)
          if (question !== undefined) {
            drafts.push(this.draft(summary, extractionJobId, 'open_question', question.question,
              question.question, { kind: 'question', questionId: question.id, version: question.version },
              'unverified', 'question', question.id, question.version))
          }
          break
        }
        case 'gap': {
          const gap = gaps.get(reference.entityId)
          if (gap !== undefined) {
            drafts.push(this.draft(summary, extractionJobId, 'open_question', gap.gapDescription,
              gap.gapDescription, { kind: 'gap', gapId: gap.id, version: gap.version },
              'unverified', 'gap', gap.id, gap.version))
          }
          break
        }
        case 'decision': {
          const decision = decisions.get(reference.entityId)
          if (decision !== undefined) {
            drafts.push(this.draft(summary, extractionJobId, 'decision', decision.title,
              decision.decision, { kind: 'decision', decisionId: decision.id },
              'supported', 'decision', decision.id))
            if (PROCEDURE_START.test(decision.decision.trim())) {
              drafts.push(this.draft(summary, extractionJobId, 'strategy', `Procedure: ${decision.title}`,
                decision.decision, { kind: 'procedure', decisionId: decision.id },
                'inferred', 'decision', decision.id))
            }
          }
          break
        }
        case 'discovery': {
          const discovery = discoveries.get(reference.entityId)
          if (discovery !== undefined) {
            drafts.push(this.draft(summary, extractionJobId, 'finding', label(discovery.description),
              discovery.description, { kind: 'discovery', discoveryId: discovery.id, version: discovery.version },
              discovery.status === 'accepted' ? 'supported' : 'inferred', 'discovery', discovery.id, discovery.version))
          }
          break
        }
        case 'evidence': {
          const item = evidence.find(candidate => candidate.id === reference.entityId)
          if (item !== undefined && (item.evidenceType === 'refutes' || item.evidenceType === 'contradicts')) {
            drafts.push(this.failureDraft(summary, item, undefined))
          }
          break
        }
        default:
          break
      }
    }

    for (const hypothesis of hypotheses.values()) {
      if (hypothesis.status === 'rejected'
        && !drafts.some(draft => draft.memoryType === 'failure' && draft.entityId === hypothesis.id)) {
        drafts.push(this.failureDraft(summary, undefined, hypothesis))
      }
    }

    let created = 0
    let updated = 0
    let unchanged = 0
    let conflicts = 0
    let skipped = 0
    let existing = this.core.memory.listMemories(ideaId)
    for (const draft of drafts) {
      const result = this.commitDraft(ideaId, summary, extractionJobId, draft, existing)
      if (result === 'created') created += 1
      else if (result === 'updated') updated += 1
      else if (result === 'unchanged') unchanged += 1
      else if (result === 'conflict') conflicts += 1
      else skipped += 1
      existing = this.core.memory.listMemories(ideaId)
    }
    return { created, updated, unchanged, conflicts, skipped }
  }

  private claimDrafts(summary: ResearchSessionSummary, claim: ResearchClaim, allEvidence: readonly ResearchEvidence[]): CandidateDraft[] {
    const related = allEvidence.filter(item => item.claimId === claim.id)
    const supports = related.filter(item => item.evidenceType === 'supports')
    const refutes = related.filter(item => item.evidenceType === 'refutes' || item.evidenceType === 'contradicts')
    if (refutes.length > 0) {
      return refutes.map(item => this.failureDraft(summary, item, undefined))
    }
    const epistemic: MemoryEpistemicStatus = supports.length > 0 ? 'supported' : 'unverified'
    const evidenceText = supports.map(item => item.quote || item.notes).filter(text => text.trim() !== '').join(' ')
    return [{
      memoryType: 'fact',
      title: label(claim.statement, 120),
      content: evidenceText === '' ? claim.statement : `${claim.statement}\nEvidence: ${evidenceText}`,
      structured: { kind: 'claim', claimId: claim.id, version: claim.version },
      epistemicStatus: epistemic,
      sources: [
        this.summarySource(summary),
        this.entitySource(summary, 'claim', claim.id, 'direct', claim.version),
        ...supports.map(item => this.entitySource(summary, 'evidence', item.id, 'supporting', item.version, item.quote)),
      ],
      entityType: 'claim',
      entityId: claim.id,
      entityVersion: claim.version,
    }]
  }

  private hypothesisDraft(summary: ResearchSessionSummary, hypothesis: ResearchHypothesis): CandidateDraft {
    const epistemic: MemoryEpistemicStatus = hypothesis.status === 'supported'
      ? 'supported'
      : hypothesis.status === 'rejected'
        ? 'refuted'
        : hypothesis.status === 'disputed' ? 'disputed' : 'unverified'
    return {
      memoryType: 'hypothesis',
      title: label(hypothesis.title, 120),
      content: hypothesis.description,
      structured: {
        kind: 'hypothesis', hypothesisId: hypothesis.id, version: hypothesis.currentVersion,
        status: hypothesis.status,
      },
      epistemicStatus: epistemic,
      sources: [this.summarySource(summary), this.entitySource(summary, 'hypothesis', hypothesis.id, 'direct', hypothesis.currentVersion)],
      entityType: 'hypothesis',
      entityId: hypothesis.id,
      entityVersion: hypothesis.currentVersion,
    }
  }

  private failureDraft(
    summary: ResearchSessionSummary,
    evidence: ResearchEvidence | undefined,
    hypothesis: ResearchHypothesis | undefined,
  ): CandidateDraft {
    if (evidence !== undefined) {
      return {
        memoryType: 'failure',
        title: label(`Failed attempt: ${evidence.quote || evidence.notes || evidence.evidenceType}`, 120),
        content: evidence.notes || evidence.quote || `${evidence.evidenceType} evidence`,
        structured: { kind: 'failed_attempt', evidenceId: evidence.id, version: evidence.version },
        epistemicStatus: 'supported',
        sources: [this.summarySource(summary), this.entitySource(summary, 'evidence', evidence.id, 'contradicting', evidence.version, evidence.quote)],
        entityType: 'evidence',
        entityId: evidence.id,
        entityVersion: evidence.version,
      }
    }
    const rejected = hypothesis as ResearchHypothesis
    return {
      memoryType: 'failure',
      title: label(`Failed hypothesis: ${rejected.title}`, 120),
      content: rejected.description,
      structured: { kind: 'failed_hypothesis', hypothesisId: rejected.id, version: rejected.currentVersion },
      epistemicStatus: 'supported',
      sources: [this.summarySource(summary), this.entitySource(summary, 'hypothesis', rejected.id, 'direct', rejected.currentVersion)],
      entityType: 'hypothesis',
      entityId: rejected.id,
      entityVersion: rejected.currentVersion,
    }
  }

  private draft(
    summary: ResearchSessionSummary,
    extractionJobId: string,
    memoryType: MemoryType,
    title: string,
    content: string,
    structured: Record<string, unknown>,
    epistemicStatus: MemoryEpistemicStatus,
    entityType: MemoryEntityType,
    entityId: string,
    entityVersion?: number,
  ): CandidateDraft {
    return {
      memoryType,
      title: label(title, 120),
      content,
      structured: { ...structured, extractionJobId },
      epistemicStatus,
      sources: [this.summarySource(summary), this.entitySource(summary, entityType, entityId, 'direct', entityVersion)],
      entityType,
      entityId,
      ...entityVersion === undefined ? {} : { entityVersion },
    }
  }

  private summarySource(summary: ResearchSessionSummary): MemorySourceInput {
    return {
      sessionId: summary.sessionId,
      entityType: 'session_summary',
      entityId: summary.id,
      summaryId: summary.id,
      summaryVersion: summary.generationVersion,
      sourceRole: 'direct',
    }
  }

  private entitySource(
    summary: ResearchSessionSummary,
    entityType: MemoryEntityType,
    entityId: string,
    sourceRole: NonNullable<MemorySourceInput['sourceRole']>,
    entityVersion?: number,
    quote?: string,
  ): MemorySourceInput {
    return {
      sessionId: summary.sessionId,
      entityType,
      entityId,
      sourceRole,
      ...entityVersion === undefined ? {} : { entityVersion },
      ...quote === undefined || quote === '' ? {} : { quote: label(quote) },
    }
  }

  private commitDraft(
    ideaId: IdeaId,
    summary: ResearchSessionSummary,
    extractionJobId: string,
    draft: CandidateDraft,
    existing: ReturnType<ResearchCore['memory']['listMemories']>,
  ): 'created' | 'updated' | 'unchanged' | 'conflict' | 'skipped' {
    const candidates = existing.filter(memory => memory.memoryType === draft.memoryType)
    const sameSource = (source: ReturnType<ResearchCore['memory']['listMemories']>[number]['sources'][number]): boolean =>
      source.entityType === draft.entityType && source.entityId === draft.entityId
    const already = candidates.find(memory => memory.sources.some(sameSource)
      && memory.sources.some(source => source.summaryId === summary.id
        && source.summaryVersion === summary.generationVersion))
    if (already !== undefined) return 'skipped'
    const newer = candidates.find(memory => memory.sources.some(sameSource)
      && memory.sources.some(source => source.summaryVersion !== undefined
        && source.summaryVersion > summary.generationVersion))
    if (newer !== undefined) return 'skipped'
    let best: { memory: (typeof candidates)[number]; score: number } | undefined
    for (const memory of candidates) {
      const score = similarity(`${memory.title} ${memory.content}`, `${draft.title} ${draft.content}`)
      if (best === undefined || score > best.score) best = { memory, score }
    }
    const base = {
      ideaId,
      memoryType: draft.memoryType,
      title: draft.title,
      content: draft.content,
      structured: JSON.parse(JSON.stringify({
        ...draft.structured,
        summaryId: summary.id,
        summaryVersion: summary.generationVersion,
      })) as JsonValue,
      epistemicStatus: draft.epistemicStatus,
      sources: draft.sources.map(source => ({ ...source, extractionJobId })),
      relations: [{
        entityType: draft.entityType,
        entityId: draft.entityId,
        relationType: 'derived_from' as const,
      }],
    }
    if (best !== undefined && best.score >= this.updateThreshold
      && !this.opposite(best.memory.epistemicStatus, draft.epistemicStatus)) {
      this.core.memory.updateMemory(ideaId, best.memory.id, {
        title: base.title,
        content: base.content,
        structured: base.structured,
        epistemicStatus: base.epistemicStatus,
        sources: base.sources,
        relations: base.relations,
      }, {
        changeReason: `extractor: summary ${summary.id} v${summary.generationVersion}`,
        changeSource: 'extractor',
        createdBy: 'extractor',
        sourceSessionId: summary.sessionId,
        sourceEventSeq: summary.eventEndSeq,
      })
      return 'updated'
    }
    const created = this.core.memory.createMemory(base)
    if (best !== undefined) {
      const conflictType = this.opposite(best.memory.epistemicStatus, draft.epistemicStatus)
        ? 'contradiction'
        : best.score >= this.duplicateThreshold ? 'possible_duplicate' : undefined
      if (conflictType !== undefined && best.score >= this.conflictThreshold) {
        this.core.memory.createConflict({
          ideaId,
          memoryAId: best.memory.id,
          memoryBId: created.id,
          conflictType,
          description: `Possible ${conflictType}: ${best.memory.title} / ${created.title}`,
          detectedBy: 'extractor',
        })
        return 'conflict'
      }
    }
    return 'created'
  }

  private opposite(left: MemoryEpistemicStatus, right: MemoryEpistemicStatus): boolean {
    const positive = (value: MemoryEpistemicStatus): boolean => value === 'supported' || value === 'verified'
    const negative = (value: MemoryEpistemicStatus): boolean => value === 'refuted' || value === 'disputed'
    return (positive(left) && negative(right)) || (negative(left) && positive(right))
  }
}
