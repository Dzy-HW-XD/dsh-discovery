/**
 * Deterministic Session Summary engine. It reads Research DB entities and
 * committed Session events, never chat-only guesses, and references canonical
 * entities instead of copying them.
 * @module @deepseek-ai/dsh-research-memory/summary-engine
 */

import { createHash } from 'node:crypto'
import type ResearchCore from '@deepseek-ai/dsh-research-core'
import type {
  StructuredSessionSummary,
  SummaryReference,
  IdeaId,
} from '@deepseek-ai/dsh-research-core'

/** Minimal persisted Session event used by the engine. */
export interface SummarySessionEvent {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data?: unknown
}

/** Minimal Session log read surface. */
export interface SummarySessionLog {
  readonly inheritedEventCount: number
  readonly events: readonly SummarySessionEvent[]
}

/** Input accepted by `generate`. */
export interface GenerateSummaryInput {
  readonly sessionId: string
  readonly ideaId: IdeaId
  readonly startSeq: number
  readonly endSeq: number
  readonly events: readonly SummarySessionEvent[]
}

/** Deterministic summary output plus narrative. */
export interface GeneratedSessionSummary extends StructuredSessionSummary {
  readonly summary: string
  readonly inputHash: string
}

function textOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  return content
    .filter((block: unknown): block is { type: 'text'; text: string } => {
      if (typeof block !== 'object' || block === null) return false
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string'
    })
    .map(block => block.text.trim())
    .filter(text => text.length > 0)
    .join(' ')
}

function userText(event: SummarySessionEvent): string | undefined {
  if (event.type !== 'user/message') return undefined
  const source = typeof event.data === 'object' && event.data !== null
    ? (event.data as { source?: { kind?: unknown } }).source
    : undefined
  if (source?.kind !== 'user') return undefined
  const text = textOf(event.data)
  return text === undefined || text.trim() === '' ? undefined : text
}

function label(value: string, limit: number = 160): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

function ref(entityType: string, entityId: string, title: string, version?: number): SummaryReference {
  return { entityType, entityId, label: label(title), ...version === undefined ? {} : { version } }
}

/**
 * Build a deterministic summary from one Session range and the Idea's
 * canonical research entities.
 */
export class SummaryEngine {
  /**
   * @param core - research core service owning the database and entities.
   */
  constructor(private readonly core: ResearchCore) {}

  /**
   * Generate one structured summary.
   * @param input - Session, Idea, range, and committed events.
   * @returns deterministic summary fields and narrative.
   */
  generate(input: GenerateSummaryInput): GeneratedSessionSummary {
    const events = input.events.filter(event => event.seq >= input.startSeq && event.seq <= input.endSeq)
    const idea = this.core.ideas.getIdea(input.ideaId)
    if (idea === undefined) throw new Error(`Idea "${input.ideaId}" not found`)
    const session = input.sessionId
    const allClaims = this.core.artifacts.listClaims(input.ideaId)
    const claims = allClaims.filter(claim => claim.origin.originSessionId === session)
    const evidence = this.core.artifacts.listEvidence(input.ideaId)
      .filter(item => item.origin.originSessionId === session)
    const referencedClaimIds = new Set(claims.map(claim => claim.id))
    for (const item of evidence) {
      if (item.claimId !== undefined) referencedClaimIds.add(item.claimId)
    }
    const referencedClaims = allClaims.filter(claim => referencedClaimIds.has(claim.id))
    const hypotheses = this.core.artifacts.listHypotheses(input.ideaId)
      .filter(item => item.provenance.originSessionId === session)
    const questions = this.core.artifacts.listQuestions(input.ideaId)
      .filter(item => item.provenance.originSessionId === session)
    const gaps = this.core.artifacts.listGaps(input.ideaId)
      .filter(item => item.provenance.originSessionId === session)
    const decisions = this.core.artifacts.listDecisions(input.ideaId)
      .filter(item => item.provenance.originSessionId === session)
    const discoveries = this.core.artifacts.listDiscoveries(input.ideaId)
      .filter(item => item.provenance.originSessionId === session)
    const artifacts = this.core.artifacts.listArtifacts(input.ideaId)
      .filter(item => item.provenance.originSessionId === session)
    const sources = this.core.artifacts.listSources(input.ideaId)

    const firstUser = events.find(event => userText(event) !== undefined)
    const objective = firstUser === undefined
      ? idea.researchQuestion.trim() || idea.title
      : label(userText(firstUser) as string, 300)

    const keyFindings: SummaryReference[] = []
    for (const claim of referencedClaims) {
      if (claim.epistemicStatus === 'observed' || claim.epistemicStatus === 'reported') {
        keyFindings.push(ref('claim', claim.id, claim.statement, claim.version))
      }
    }
    for (const discovery of discoveries) {
      keyFindings.push(ref('discovery', discovery.id, discovery.description, discovery.version))
    }

    const failedAttempts: SummaryReference[] = []
    for (const item of evidence) {
      if (item.evidenceType === 'refutes' || item.evidenceType === 'contradicts') {
        failedAttempts.push(ref('evidence', item.id, item.quote || item.notes || item.evidenceType, item.version))
      }
    }
    for (const hypothesis of hypotheses) {
      if (hypothesis.status === 'rejected') {
        failedAttempts.push(ref('hypothesis', hypothesis.id, hypothesis.title, hypothesis.currentVersion))
      }
    }

    const unresolvedQuestions = [
      ...questions.filter(question => question.status === 'open' || question.status === 'investigating')
        .map(question => ref('question', question.id, question.question, question.version)),
      ...gaps.filter(gap => gap.status === 'candidate' || gap.status === 'reviewed')
        .map(gap => ref('gap', gap.id, gap.gapDescription, gap.version)),
    ]

    const nextSteps: string[] = []
    for (const question of unresolvedQuestions.slice(0, 3)) nextSteps.push(`Investigate: ${question.label}`)
    for (const hypothesis of hypotheses.filter(item => item.status === 'candidate').slice(0, 2)) {
      nextSteps.push(`Validate hypothesis: ${label(hypothesis.title)}`)
    }
    if (nextSteps.length === 0) nextSteps.push('Continue the current research plan.')

    const sourceReferences: SummaryReference[] = []
    const seen = new Set<string>()
    const add = (reference: SummaryReference): void => {
      const key = `${reference.entityType}:${reference.entityId}`
      if (seen.has(key)) return
      seen.add(key)
      sourceReferences.push(reference)
    }
    for (const claim of referencedClaims) add(ref('claim', claim.id, claim.statement, claim.version))
    for (const item of evidence) add(ref('evidence', item.id, item.quote || item.evidenceType, item.version))
    for (const hypothesis of hypotheses) add(ref('hypothesis', hypothesis.id, hypothesis.title, hypothesis.currentVersion))
    for (const question of questions) add(ref('question', question.id, question.question, question.version))
    for (const gap of gaps) add(ref('gap', gap.id, gap.gapDescription, gap.version))
    for (const decision of decisions) add(ref('decision', decision.id, decision.title))
    for (const discovery of discoveries) add(ref('discovery', discovery.id, discovery.description, discovery.version))
    for (const artifact of artifacts) add(ref('artifact', artifact.id, artifact.title, artifact.version))
    const referencedSourceIds = new Set<string>()
    for (const claim of claims) for (const sourceId of claim.sourceIds) referencedSourceIds.add(sourceId)
    for (const item of evidence) referencedSourceIds.add(item.sourceId)
    for (const source of sources) {
      if (referencedSourceIds.has(source.id)) add(ref('source', source.id, source.title))
    }

    const hypothesesCreated = hypotheses.map(hypothesis =>
      ref('hypothesis', hypothesis.id, hypothesis.title, hypothesis.currentVersion))
    const hypothesesValidated = hypotheses.filter(hypothesis => hypothesis.status === 'supported')
      .map(hypothesis => ref('hypothesis', hypothesis.id, hypothesis.title, hypothesis.currentVersion))
    const hypothesesRejected = hypotheses.filter(hypothesis => hypothesis.status === 'rejected')
      .map(hypothesis => ref('hypothesis', hypothesis.id, hypothesis.title, hypothesis.currentVersion))
    const decisionRefs = decisions.map(decision => ref('decision', decision.id, decision.title))
    const artifactRefs = artifacts.map(artifact => ref('artifact', artifact.id, artifact.title, artifact.version))

    const summary = this.narrative({
      objective,
      keyFindings,
      hypothesesValidated,
      hypothesesRejected,
      failedAttempts,
      unresolvedQuestions,
      generatedArtifacts: artifactRefs,
    })
    const inputHash = createHash('sha256').update(JSON.stringify({
      session,
      range: [input.startSeq, input.endSeq],
      eventSeqs: events.map(event => `${event.seq}:${event.type}:${event.time}`),
      objective,
      claims: referencedClaims.map(claim => `${claim.id}:${claim.version}`),
      evidence: evidence.map(item => `${item.id}:${item.version}`),
      hypotheses: hypotheses.map(item => `${item.id}:${item.currentVersion}:${item.status}`),
      questions: questions.map(item => `${item.id}:${item.version}:${item.status}`),
      gaps: gaps.map(item => `${item.id}:${item.version}:${item.status}`),
      decisions: decisions.map(item => item.id),
      discoveries: discoveries.map(item => `${item.id}:${item.version}`),
      artifacts: artifacts.map(item => `${item.id}:${item.version}`),
    })).digest('hex')

    return {
      objective,
      keyFindings,
      hypothesesCreated,
      hypothesesValidated,
      hypothesesRejected,
      decisions: decisionRefs,
      failedAttempts,
      unresolvedQuestions,
      generatedArtifacts: artifactRefs,
      nextSteps,
      sourceReferences,
      summary,
      inputHash,
    }
  }

  private narrative(input: {
    objective: string
    keyFindings: readonly SummaryReference[]
    hypothesesValidated: readonly SummaryReference[]
    hypothesesRejected: readonly SummaryReference[]
    failedAttempts: readonly SummaryReference[]
    unresolvedQuestions: readonly SummaryReference[]
    generatedArtifacts: readonly SummaryReference[]
  }): string {
    const lines = [`Objective: ${input.objective}`]
    if (input.keyFindings.length > 0) lines.push(`Findings: ${input.keyFindings.map(item => item.label).join('; ')}`)
    if (input.hypothesesValidated.length > 0) lines.push(`Validated: ${input.hypothesesValidated.map(item => item.label).join('; ')}`)
    if (input.hypothesesRejected.length > 0) lines.push(`Rejected: ${input.hypothesesRejected.map(item => item.label).join('; ')}`)
    if (input.failedAttempts.length > 0) lines.push(`Failed attempts: ${input.failedAttempts.map(item => item.label).join('; ')}`)
    if (input.unresolvedQuestions.length > 0) lines.push(`Open questions: ${input.unresolvedQuestions.map(item => item.label).join('; ')}`)
    if (input.generatedArtifacts.length > 0) lines.push(`Artifacts: ${input.generatedArtifacts.map(item => item.label).join('; ')}`)
    if (lines.length === 1) lines.push('No research entities were produced in this Session.')
    return lines.join('\n')
  }
}
