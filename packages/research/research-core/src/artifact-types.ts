/**
 * Phase 3 research artifact vocabulary: sources, knowledge entities, research
 * questions, hypotheses, discoveries, decisions, artifacts, and branches.
 * Persistence and validation live in `artifacts.ts`.
 * @module @deepseek-ai/dsh-research-core/artifact-types
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { IdeaId } from './types.ts'

/** Stable identity of one shared Source. */
export type SourceId = Branded<'SourceId'>

/**
 * Admit a raw string as a Source identity.
 * @param value - raw persisted or parsed id.
 * @returns the same string with the Source brand.
 */
export function SourceId(value: string): SourceId {
  return brandString<SourceId>(value)
}

/** Stable identity of one Source locator. */
export type SourceLocationId = Branded<'SourceLocationId'>

/**
 * Admit a raw string as a Source locator identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded locator id.
 */
export function SourceLocationId(value: string): SourceLocationId {
  return brandString<SourceLocationId>(value)
}

/** Stable identity of one Concept. */
export type ConceptId = Branded<'ConceptId'>

/**
 * Admit a raw string as a Concept identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded Concept id.
 */
export function ConceptId(value: string): ConceptId {
  return brandString<ConceptId>(value)
}

/** Stable identity of one Claim. */
export type ClaimId = Branded<'ClaimId'>

/**
 * Admit a raw string as a Claim identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded Claim id.
 */
export function ClaimId(value: string): ClaimId {
  return brandString<ClaimId>(value)
}

/** Stable identity of one Evidence record. */
export type EvidenceId = Branded<'EvidenceId'>

/**
 * Admit a raw string as an Evidence identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded Evidence id.
 */
export function EvidenceId(value: string): EvidenceId {
  return brandString<EvidenceId>(value)
}

/** Stable identity of one knowledge relation. */
export type KnowledgeRelationId = Branded<'KnowledgeRelationId'>

/**
 * Admit a raw string as a knowledge relation identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded relation id.
 */
export function KnowledgeRelationId(value: string): KnowledgeRelationId {
  return brandString<KnowledgeRelationId>(value)
}

/** Stable identity of one Research Question. */
export type QuestionId = Branded<'QuestionId'>

/**
 * Admit a raw string as a Research Question identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded Question id.
 */
export function QuestionId(value: string): QuestionId {
  return brandString<QuestionId>(value)
}

/** Stable identity of one Research Gap. */
export type GapId = Branded<'GapId'>

/**
 * Admit a raw string as a Research Gap identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded Gap id.
 */
export function GapId(value: string): GapId {
  return brandString<GapId>(value)
}

/** Stable identity of one Hypothesis. */
export type HypothesisId = Branded<'HypothesisId'>

/**
 * Admit a raw string as a Hypothesis identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded Hypothesis id.
 */
export function HypothesisId(value: string): HypothesisId {
  return brandString<HypothesisId>(value)
}

/** Stable identity of one Discovery. */
export type DiscoveryId = Branded<'DiscoveryId'>

/**
 * Admit a raw string as a Discovery identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded Discovery id.
 */
export function DiscoveryId(value: string): DiscoveryId {
  return brandString<DiscoveryId>(value)
}

/** Stable identity of one research Decision. */
export type DecisionId = Branded<'DecisionId'>

/**
 * Admit a raw string as a Decision identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded Decision id.
 */
export function DecisionId(value: string): DecisionId {
  return brandString<DecisionId>(value)
}

/** Stable identity of one stored Artifact. */
export type ArtifactId = Branded<'ArtifactId'>

/**
 * Admit a raw string as an Artifact identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded Artifact id.
 */
export function ArtifactId(value: string): ArtifactId {
  return brandString<ArtifactId>(value)
}

/** Stable identity of one research branch. */
export type BranchId = Branded<'BranchId'>

/**
 * Admit a raw string as a Branch identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded Branch id.
 */
export function BranchId(value: string): BranchId {
  return brandString<BranchId>(value)
}

/** Stable identity of one Session Summary snapshot. */
export type SessionSummaryId = Branded<'SessionSummaryId'>

/**
 * Admit a raw string as a Session Summary identity.
 * @param value - raw persisted or parsed id.
 * @returns the branded summary id.
 */
export function SessionSummaryId(value: string): SessionSummaryId {
  return brandString<SessionSummaryId>(value)
}

/** Kinds a Source may describe. */
export const SOURCE_TYPES = ['paper', 'preprint', 'web', 'documentation', 'repository', 'book', 'dataset', 'other'] as const
/** One Source kind. */
export type SourceType = typeof SOURCE_TYPES[number]

/** Source lifecycle. */
export type SourceStatus = 'active' | 'archived' | 'retracted' | 'unavailable'

/** How an Idea uses a Source. */
export type SourceRelevance = 'primary' | 'cited' | 'context' | 'rejected'

/** Locator kinds accepted for a quotation or position. */
export const LOCATOR_TYPES = ['page', 'section', 'paragraph', 'line', 'url_fragment', 'char_range', 'figure', 'table'] as const
/** One locator kind. */
export type LocatorType = typeof LOCATOR_TYPES[number]

/** Epistemic standing shared by claims, evidence, relations, and memory. */
export const EPISTEMIC_STATUSES = ['observed', 'reported', 'inferred', 'speculative', 'disputed', 'rejected'] as const
/** One epistemic standing. */
export type EpistemicStatus = typeof EPISTEMIC_STATUSES[number]

/** Claim lifecycle. */
export type ClaimStatus = 'active' | 'disputed' | 'rejected' | 'superseded' | 'archived'

/** Evidence direction. */
export type EvidenceType = 'supports' | 'refutes' | 'context' | 'contradicts'

/** Knowledge relation kinds. */
export const KNOWLEDGE_RELATION_TYPES = [
  'supports', 'refutes', 'contradicts', 'extends', 'depends_on', 'equivalent_to',
  'specializes', 'causes', 'correlates_with', 'derived_from', 'analogous_to',
  'potentially_related_to',
] as const
/** One knowledge relation kind. */
export type KnowledgeRelationType = typeof KNOWLEDGE_RELATION_TYPES[number]

/** Entity kinds accepted by knowledge relations. */
export const ENTITY_TYPES = [
  'source', 'concept', 'claim', 'evidence', 'question', 'gap', 'hypothesis',
  'discovery', 'decision', 'artifact',
] as const
/** One entity kind. */
export type EntityType = typeof ENTITY_TYPES[number]

/** Research Question lifecycle. */
export type QuestionStatus = 'open' | 'investigating' | 'answered' | 'deferred' | 'rejected'

/** Research Gap kinds. */
export const GAP_TYPES = [
  'literature_gap', 'knowledge_gap', 'methodological_gap', 'contradiction_gap', 'cross_domain_gap',
] as const
/** One Research Gap kind. */
export type GapType = typeof GAP_TYPES[number]

/** Research Gap lifecycle. */
export type GapStatus = 'candidate' | 'reviewed' | 'accepted' | 'rejected' | 'superseded'

/** Hypothesis lifecycle. */
export type HypothesisStatus = 'candidate' | 'under_review' | 'supported' | 'disputed' | 'rejected' | 'superseded'

/** How Evidence bears on a Hypothesis. */
export type HypothesisEvidenceRelation = 'supports' | 'refutes' | 'context'

/** Discovery kinds. */
export const DISCOVERY_TYPES = ['research_gap', 'knowledge_bridge', 'contradiction', 'counterfactual', 'novelty', 'other'] as const
/** One Discovery kind. */
export type DiscoveryType = typeof DISCOVERY_TYPES[number]

/** Discovery lifecycle. */
export type DiscoveryStatus = 'candidate' | 'reviewed' | 'accepted' | 'rejected' | 'superseded'

/** Reviewer verdict shared by discoveries and later hypothesis reviews. */
export type ReviewerVerdict = 'pass' | 'revise' | 'reject' | 'insufficient_evidence'

/** Stored Artifact kinds. */
export const ARTIFACT_TYPES = [
  'research_report', 'literature_review', 'technical_analysis', 'markdown', 'html',
  'graph_export', 'diagram', 'dataset', 'other',
] as const
/** One Artifact kind. */
export type ArtifactType = typeof ARTIFACT_TYPES[number]

/** Artifact lifecycle. */
export type ArtifactStatus = 'pending' | 'ready' | 'missing' | 'failed' | 'archived'

/** Branch lifecycle. */
export type BranchStatus = 'active' | 'paused' | 'merged' | 'split' | 'rejected' | 'promoted_to_idea'

/** Summary lifecycle. */
export type SessionSummaryStatus = 'candidate' | 'reviewed' | 'superseded' | 'rejected'

/** Provenance accepted by every Phase 3 entity. */
export interface Provenance {
  /** Session whose work produced the entity. */
  readonly originSessionId?: string
  /** Committed Session event sequence that produced the entity. */
  readonly originEventSeq?: number
  /** Tool call identity when the entity was created by a tool. */
  readonly originToolCallId?: string
}

/** One shared Source row. */
export interface ResearchSource {
  readonly id: SourceId
  readonly originIdeaId?: IdeaId
  readonly sourceType: SourceType
  readonly title: string
  readonly authors: readonly string[]
  readonly year?: number
  readonly venue?: string
  readonly doi?: string
  readonly arxivId?: string
  readonly url?: string
  readonly canonicalUrl?: string
  readonly abstract?: string
  readonly metadata: JsonValue
  readonly contentHash?: string
  readonly retrievedAt?: number
  readonly status: SourceStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly version: number
}

/** One locator inside a Source. */
export interface SourceLocation {
  readonly id: SourceLocationId
  readonly sourceId: SourceId
  readonly locatorType: LocatorType
  readonly locator: string
  readonly page?: number
  readonly charStart?: number
  readonly charEnd?: number
  readonly quote: string
  readonly createdAt: number
}

/** One Source as an Idea uses it. */
export interface IdeaSource {
  readonly ideaId: IdeaId
  readonly sourceId: SourceId
  readonly relevance: SourceRelevance
  readonly note: string
  readonly addedAt: number
}

/** One Concept. */
export interface ResearchConcept {
  readonly id: ConceptId
  readonly ideaId: IdeaId
  readonly name: string
  readonly definition: string
  readonly aliases: readonly string[]
  readonly parentConceptId?: ConceptId
  readonly status: 'active' | 'merged' | 'deprecated'
  readonly createdAt: number
  readonly updatedAt: number
  readonly version: number
}

/** One Claim. */
export interface ResearchClaim {
  readonly id: ClaimId
  readonly ideaId: IdeaId
  readonly statement: string
  readonly normalizedStatement: string
  readonly epistemicStatus: EpistemicStatus
  readonly confidence: number
  readonly status: ClaimStatus
  readonly sourceIds: readonly SourceId[]
  readonly origin: Provenance
  readonly contentHash: string
  readonly supersedesId?: ClaimId
  readonly createdAt: number
  readonly updatedAt: number
  readonly version: number
}

/** One immutable Claim snapshot. */
export interface ClaimVersion {
  readonly id: string
  readonly claimId: ClaimId
  readonly version: number
  readonly snapshot: JsonValue
  readonly changeReason: string
  readonly createdBy: string
  readonly createdAt: number
}

/** One Evidence record. */
export interface ResearchEvidence {
  readonly id: EvidenceId
  readonly ideaId: IdeaId
  readonly claimId?: ClaimId
  readonly sourceId: SourceId
  readonly locationId?: SourceLocationId
  readonly evidenceType: EvidenceType
  readonly strength: number
  readonly quote: string
  readonly notes: string
  readonly epistemicStatus: EpistemicStatus
  readonly origin: Provenance
  readonly contentHash: string
  readonly supersedesId?: EvidenceId
  readonly createdAt: number
  readonly updatedAt: number
  readonly version: number
}

/** One knowledge relation between two existing entities. */
export interface KnowledgeRelation {
  readonly id: KnowledgeRelationId
  readonly ideaId: IdeaId
  readonly fromEntityType: EntityType
  readonly fromEntityId: string
  readonly toEntityType: EntityType
  readonly toEntityId: string
  readonly relationType: KnowledgeRelationType
  readonly confidence: number
  readonly epistemicStatus: EpistemicStatus
  readonly sourceIds: readonly SourceId[]
  readonly origin: Provenance
  readonly status: 'active' | 'disputed' | 'rejected' | 'superseded'
  readonly createdAt: number
}

/** One Research Question. */
export interface ResearchQuestion {
  readonly id: QuestionId
  readonly ideaId: IdeaId
  readonly branchId?: BranchId
  readonly question: string
  readonly motivation: string
  readonly origin: 'seed' | 'session' | 'gap' | 'discovery' | 'user' | 'critic'
  readonly priority: number
  readonly status: QuestionStatus
  readonly relatedClaimIds: readonly ClaimId[]
  readonly relatedHypothesisIds: readonly HypothesisId[]
  readonly answerSummary: string
  readonly provenance: Provenance
  readonly createdAt: number
  readonly updatedAt: number
  readonly version: number
}

/** One Research Gap. */
export interface ResearchGap {
  readonly id: GapId
  readonly ideaId: IdeaId
  readonly branchId?: BranchId
  readonly gapType: GapType
  readonly gapDescription: string
  readonly relatedWork: string
  readonly missingConnection: string
  readonly evidence: string
  readonly noveltyAssessment: string
  readonly uncertainty: number
  readonly status: GapStatus
  readonly provenance: Provenance
  readonly createdAt: number
  readonly updatedAt: number
  readonly version: number
}

/** One Hypothesis. */
export interface ResearchHypothesis {
  readonly id: HypothesisId
  readonly ideaId: IdeaId
  readonly branchId?: BranchId
  readonly title: string
  readonly description: string
  readonly theoreticalReasoning: string
  readonly assumptions: readonly string[]
  readonly boundaryConditions: readonly string[]
  readonly alternativeExplanations: readonly string[]
  readonly falsificationConditions: readonly string[]
  readonly relatedWork: readonly string[]
  readonly status: HypothesisStatus
  readonly currentVersion: number
  readonly provenance: Provenance
  readonly createdAt: number
  readonly updatedAt: number
}

/** One immutable Hypothesis snapshot. */
export interface HypothesisVersion {
  readonly id: string
  readonly hypothesisId: HypothesisId
  readonly version: number
  readonly snapshot: JsonValue
  readonly changeReason: string
  readonly createdBy: string
  readonly createdAt: number
}

/** One Hypothesis-to-Evidence link. */
export interface HypothesisEvidence {
  readonly hypothesisId: HypothesisId
  readonly evidenceId: EvidenceId
  readonly relation: HypothesisEvidenceRelation
  readonly weight: number
  readonly note: string
  readonly createdAt: number
}

/** One Discovery. */
export interface ResearchDiscovery {
  readonly id: DiscoveryId
  readonly ideaId: IdeaId
  readonly branchId?: BranchId
  readonly discoveryType: DiscoveryType
  readonly description: string
  readonly reasoningChain: string
  readonly supportingEntityIds: readonly string[]
  readonly contradictingEntityIds: readonly string[]
  readonly scores: Readonly<Partial<Record<
    'novelty' | 'gapQuality' | 'evidenceQuality' | 'logicalConsistency' | 'falsifiability' | 'potentialImpact' | 'total',
    number
  >>>
  readonly scoreExplanation: JsonValue
  readonly reviewerVerdict?: ReviewerVerdict
  readonly status: DiscoveryStatus
  readonly provenance: Provenance
  readonly createdAt: number
  readonly updatedAt: number
  readonly version: number
}

/** One research Decision. */
export interface ResearchDecision {
  readonly id: DecisionId
  readonly ideaId: IdeaId
  readonly branchId?: BranchId
  readonly title: string
  readonly decision: string
  readonly rationale: string
  readonly alternatives: readonly string[]
  readonly consequences: string
  readonly provenance: Provenance
  readonly createdAt: number
  readonly createdBy: string
}

/** One stored Artifact. */
export interface ResearchArtifact {
  readonly id: ArtifactId
  readonly ideaId: IdeaId
  readonly branchId?: BranchId
  readonly artifactType: ArtifactType
  readonly title: string
  readonly path?: string
  readonly mimeType?: string
  readonly contentHash?: string
  readonly sizeBytes?: number
  readonly markdown?: string
  readonly metadata: JsonValue
  readonly status: ArtifactStatus
  readonly provenance: Provenance
  readonly createdAt: number
  readonly updatedAt: number
  readonly version: number
}

/** One research branch. */
export interface ResearchBranch {
  readonly id: BranchId
  readonly ideaId: IdeaId
  readonly parentBranchId?: BranchId
  readonly title: string
  readonly description: string
  readonly status: BranchStatus
  readonly mergedIntoId?: BranchId
  readonly createdAt: number
  readonly updatedAt: number
  readonly version: number
}

/** One immutable Session Summary snapshot. */
export interface SessionSummary {
  readonly id: SessionSummaryId
  readonly sessionId: string
  readonly ideaId?: IdeaId
  readonly summary: string
  readonly openQuestions: readonly string[]
  readonly hypotheses: readonly string[]
  readonly artifacts: readonly string[]
  readonly eventStartSeq: number
  readonly eventEndSeq: number
  readonly inputHash: string
  readonly version: number
  readonly status: SessionSummaryStatus
  readonly supersedesId?: SessionSummaryId
  readonly modelProvider?: string
  readonly modelId?: string
  readonly promptVersion: string
  readonly createdAt: number
}

/** Input accepted by `createSource`. */
export interface CreateSourceInput {
  readonly sourceType: SourceType
  readonly title: string
  readonly authors?: readonly string[]
  readonly year?: number
  readonly venue?: string
  readonly doi?: string
  readonly arxivId?: string
  readonly url?: string
  readonly canonicalUrl?: string
  readonly abstract?: string
  readonly metadata?: JsonValue
  readonly contentHash?: string
  readonly retrievedAt?: number
  readonly relevance?: SourceRelevance
  readonly note?: string
}

/** Input accepted by `createSourceLocation`. */
export interface CreateSourceLocationInput {
  readonly locatorType: LocatorType
  readonly locator: string
  readonly page?: number
  readonly charStart?: number
  readonly charEnd?: number
  readonly quote?: string
}

/** Input accepted by `createConcept`. */
export interface CreateConceptInput {
  readonly name: string
  readonly definition?: string
  readonly aliases?: readonly string[]
  readonly parentConceptId?: ConceptId
}

/** Input accepted by `createClaim`. */
export interface CreateClaimInput {
  readonly statement: string
  readonly normalizedStatement?: string
  readonly epistemicStatus?: EpistemicStatus
  readonly confidence?: number
  readonly sourceIds?: readonly SourceId[]
  readonly supersedesId?: ClaimId
}

/** Input accepted by `updateClaim`. */
export interface UpdateClaimInput {
  readonly statement?: string
  readonly normalizedStatement?: string
  readonly epistemicStatus?: EpistemicStatus
  readonly confidence?: number
  readonly status?: ClaimStatus
  readonly sourceIds?: readonly SourceId[]
}

/** Input accepted by `createEvidence`. */
export interface CreateEvidenceInput {
  readonly claimId?: ClaimId
  readonly sourceId: SourceId
  readonly locationId?: SourceLocationId
  readonly evidenceType: EvidenceType
  readonly strength?: number
  readonly quote?: string
  readonly notes?: string
  readonly epistemicStatus?: EpistemicStatus
  readonly supersedesId?: EvidenceId
}

/** Input accepted by `createKnowledgeRelation`. */
export interface CreateKnowledgeRelationInput {
  readonly fromEntityType: EntityType
  readonly fromEntityId: string
  readonly toEntityType: EntityType
  readonly toEntityId: string
  readonly relationType: KnowledgeRelationType
  readonly confidence?: number
  readonly epistemicStatus?: EpistemicStatus
  readonly sourceIds?: readonly SourceId[]
}

/** Input accepted by `createQuestion`. */
export interface CreateQuestionInput {
  readonly question: string
  readonly motivation?: string
  readonly origin?: ResearchQuestion['origin']
  readonly priority?: number
  readonly branchId?: BranchId
  readonly relatedClaimIds?: readonly ClaimId[]
  readonly relatedHypothesisIds?: readonly HypothesisId[]
}

/** Input accepted by `updateQuestion`. */
export interface UpdateQuestionInput {
  readonly question?: string
  readonly motivation?: string
  readonly priority?: number
  readonly status?: QuestionStatus
  readonly answerSummary?: string
}

/** Input accepted by `createGap`. */
export interface CreateGapInput {
  readonly gapType: GapType
  readonly gapDescription: string
  readonly relatedWork?: string
  readonly missingConnection?: string
  readonly evidence?: string
  readonly noveltyAssessment?: string
  readonly uncertainty?: number
  readonly branchId?: BranchId
}

/** Input accepted by `updateGap`. */
export interface UpdateGapInput {
  readonly gapDescription?: string
  readonly relatedWork?: string
  readonly missingConnection?: string
  readonly evidence?: string
  readonly noveltyAssessment?: string
  readonly uncertainty?: number
  readonly status?: GapStatus
}

/** Input accepted by `createHypothesis`. */
export interface CreateHypothesisInput {
  readonly title: string
  readonly description: string
  readonly theoreticalReasoning?: string
  readonly assumptions?: readonly string[]
  readonly boundaryConditions?: readonly string[]
  readonly alternativeExplanations?: readonly string[]
  readonly falsificationConditions?: readonly string[]
  readonly relatedWork?: readonly string[]
  readonly branchId?: BranchId
}

/** Input accepted by `updateHypothesis`. */
export interface UpdateHypothesisInput {
  readonly title?: string
  readonly description?: string
  readonly theoreticalReasoning?: string
  readonly assumptions?: readonly string[]
  readonly boundaryConditions?: readonly string[]
  readonly alternativeExplanations?: readonly string[]
  readonly falsificationConditions?: readonly string[]
  readonly relatedWork?: readonly string[]
  readonly status?: HypothesisStatus
}

/** Input accepted by `createDiscovery`. */
export interface CreateDiscoveryInput {
  readonly discoveryType: DiscoveryType
  readonly description: string
  readonly reasoningChain?: string
  readonly supportingEntityIds?: readonly string[]
  readonly contradictingEntityIds?: readonly string[]
  readonly scores?: ResearchDiscovery['scores']
  readonly scoreExplanation?: JsonValue
  readonly reviewerVerdict?: ReviewerVerdict
  readonly branchId?: BranchId
}

/** Input accepted by `createDecision`. */
export interface CreateDecisionInput {
  readonly title: string
  readonly decision: string
  readonly rationale?: string
  readonly alternatives?: readonly string[]
  readonly consequences?: string
  readonly branchId?: BranchId
  readonly createdBy?: string
}

/** Input accepted by `createArtifact`. */
export interface CreateArtifactInput {
  readonly artifactType: ArtifactType
  readonly title: string
  readonly content?: string
  readonly mimeType?: string
  readonly metadata?: JsonValue
  readonly branchId?: BranchId
}

/** Input accepted by `createBranch`. */
export interface CreateBranchInput {
  readonly title: string
  readonly description?: string
  readonly parentBranchId?: BranchId
}

/** Input accepted by `updateBranch`. */
export interface UpdateBranchInput {
  readonly title?: string
  readonly description?: string
  readonly status?: BranchStatus
  readonly mergedIntoId?: BranchId
}

/** Input accepted by `recordSessionSummary`. */
export interface RecordSessionSummaryInput {
  readonly sessionId: string
  readonly ideaId?: IdeaId
  readonly summary: string
  readonly openQuestions?: readonly string[]
  readonly hypotheses?: readonly string[]
  readonly artifacts?: readonly string[]
  readonly eventStartSeq: number
  readonly eventEndSeq: number
  readonly inputHash: string
  readonly promptVersion: string
  readonly modelProvider?: string
  readonly modelId?: string
}
