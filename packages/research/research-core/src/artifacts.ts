/**
 * Durable Phase 3 artifact repository. Sources are shared across Ideas; every
 * other entity belongs to one Idea and carries Session/tool provenance.
 * @module @deepseek-ai/dsh-research-core/artifacts
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ResearchDatabase } from './database.ts'
import { ResearchError } from './errors.ts'
import { integer, json, optionalInteger, optionalReal, optionalText, real, text, type SqlRow } from './rows.ts'
import {
  ArtifactId,
  BranchId,
  ClaimId,
  ConceptId,
  DecisionId,
  DiscoveryId,
  EvidenceId,
  GapId,
  HypothesisId,
  KnowledgeRelationId,
  QuestionId,
  SessionSummaryId,
  SourceId,
  SourceLocationId,
  type ArtifactStatus,
  type BranchStatus,
  type ClaimStatus,
  type ClaimVersion,
  type CreateArtifactInput,
  type CreateBranchInput,
  type CreateClaimInput,
  type CreateConceptInput,
  type CreateDecisionInput,
  type CreateDiscoveryInput,
  type CreateEvidenceInput,
  type CreateGapInput,
  type CreateHypothesisInput,
  type CreateKnowledgeRelationInput,
  type CreateQuestionInput,
  type CreateSourceInput,
  type CreateSourceLocationInput,
  type DiscoveryStatus,
  type EntityType,
  type EpistemicStatus,
  type EvidenceType,
  type GapStatus,
  type HypothesisEvidence,
  type HypothesisEvidenceRelation,
  type HypothesisStatus,
  type HypothesisVersion,
  type KnowledgeRelation,
  type LocatorType,
  type Provenance,
  type QuestionStatus,
  type RecordSessionSummaryInput,
  type ReviewerVerdict,
  type ResearchArtifact,
  type ResearchBranch,
  type ResearchClaim,
  type ResearchConcept,
  type ResearchDecision,
  type ResearchDiscovery,
  type ResearchEvidence,
  type ResearchGap,
  type ResearchHypothesis,
  type ResearchQuestion,
  type ResearchSource,
  type SessionSummary,
  type SessionSummaryStatus,
  type SourceLocation,
  type SourceRelevance,
  type SourceStatus,
  type SourceType,
  type UpdateBranchInput,
  type UpdateClaimInput,
  type UpdateGapInput,
  type UpdateHypothesisInput,
  type UpdateQuestionInput,
} from './artifact-types.ts'
import { IdeaId, TimelineEventId, type IdeaId as IdeaIdType } from './types.ts'

/** Entity table names used for relation endpoint validation. */
const ENTITY_TABLES: Readonly<Record<EntityType, string>> = {
  source: 'research_sources',
  concept: 'research_concepts',
  claim: 'research_claims',
  evidence: 'research_evidence',
  question: 'research_questions',
  gap: 'research_gaps',
  hypothesis: 'research_hypotheses',
  discovery: 'research_discoveries',
  decision: 'research_decisions',
  artifact: 'research_artifacts',
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ResearchError('research/invalid-input', `${field} must be non-empty text`, { field })
  }
  return value
}

function unit(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ResearchError('research/invalid-input', `${field} must be between 0 and 1`, { field, value })
  }
  return value
}

function priority(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5) {
    throw new ResearchError('research/invalid-input', 'priority must be an integer between 1 and 5', { value })
  }
  return value
}

function jsonText(value: unknown): string {
  return JSON.stringify(value)
}

function provenanceOf(row: SqlRow): Provenance {
  const originSessionId = optionalText(row, 'origin_session_id')
  const originEventSeq = optionalInteger(row, 'origin_event_seq')
  const originToolCallId = optionalText(row, 'origin_tool_call_id')
  return {
    ...originSessionId === undefined ? {} : { originSessionId },
    ...originEventSeq === undefined ? {} : { originEventSeq },
    ...originToolCallId === undefined ? {} : { originToolCallId },
  }
}

function mapSource(row: SqlRow): ResearchSource {
  const originIdeaId = optionalText(row, 'origin_idea_id')
  const year = optionalInteger(row, 'year')
  const venue = optionalText(row, 'venue')
  const doi = optionalText(row, 'doi')
  const arxivId = optionalText(row, 'arxiv_id')
  const url = optionalText(row, 'url')
  const canonicalUrl = optionalText(row, 'canonical_url')
  const abstract = optionalText(row, 'abstract')
  const contentHash = optionalText(row, 'content_hash')
  const retrievedAt = optionalInteger(row, 'retrieved_at')
  return {
    id: SourceId(text(row, 'id')),
    ...originIdeaId === undefined ? {} : { originIdeaId: IdeaId(originIdeaId) },
    sourceType: text(row, 'source_type') as SourceType,
    title: text(row, 'title'),
    authors: json(row, 'authors_json') as string[],
    ...year === undefined ? {} : { year },
    ...venue === undefined ? {} : { venue },
    ...doi === undefined ? {} : { doi },
    ...arxivId === undefined ? {} : { arxivId },
    ...url === undefined ? {} : { url },
    ...canonicalUrl === undefined ? {} : { canonicalUrl },
    ...abstract === undefined ? {} : { abstract },
    metadata: json(row, 'metadata_json'),
    ...contentHash === undefined ? {} : { contentHash },
    ...retrievedAt === undefined ? {} : { retrievedAt },
    status: text(row, 'status') as SourceStatus,
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    version: integer(row, 'version'),
  }
}

function mapLocation(row: SqlRow): SourceLocation {
  const page = optionalInteger(row, 'page')
  const charStart = optionalInteger(row, 'char_start')
  const charEnd = optionalInteger(row, 'char_end')
  return {
    id: SourceLocationId(text(row, 'id')),
    sourceId: SourceId(text(row, 'source_id')),
    locatorType: text(row, 'locator_type') as LocatorType,
    locator: text(row, 'locator'),
    ...page === undefined ? {} : { page },
    ...charStart === undefined ? {} : { charStart },
    ...charEnd === undefined ? {} : { charEnd },
    quote: text(row, 'quote'),
    createdAt: integer(row, 'created_at'),
  }
}

function mapConcept(row: SqlRow): ResearchConcept {
  const parent = optionalText(row, 'parent_concept_id')
  return {
    id: ConceptId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    name: text(row, 'name'),
    definition: text(row, 'definition'),
    aliases: json(row, 'aliases_json') as string[],
    ...parent === undefined ? {} : { parentConceptId: ConceptId(parent) },
    status: text(row, 'status') as ResearchConcept['status'],
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    version: integer(row, 'version'),
  }
}

function mapClaim(row: SqlRow): ResearchClaim {
  const supersedes = optionalText(row, 'supersedes_id')
  return {
    id: ClaimId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    statement: text(row, 'statement'),
    normalizedStatement: text(row, 'normalized_statement'),
    epistemicStatus: text(row, 'epistemic_status') as EpistemicStatus,
    confidence: real(row, 'confidence'),
    status: text(row, 'status') as ClaimStatus,
    sourceIds: (json(row, 'source_ids_json') as string[]).map(SourceId),
    origin: provenanceOf(row),
    contentHash: text(row, 'content_hash'),
    ...supersedes === undefined ? {} : { supersedesId: ClaimId(supersedes) },
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    version: integer(row, 'version'),
  }
}

function mapEvidence(row: SqlRow): ResearchEvidence {
  const claimId = optionalText(row, 'claim_id')
  const locationId = optionalText(row, 'location_id')
  const supersedes = optionalText(row, 'supersedes_id')
  return {
    id: EvidenceId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    ...claimId === undefined ? {} : { claimId: ClaimId(claimId) },
    sourceId: SourceId(text(row, 'source_id')),
    ...locationId === undefined ? {} : { locationId: SourceLocationId(locationId) },
    evidenceType: text(row, 'evidence_type') as EvidenceType,
    strength: real(row, 'strength'),
    quote: text(row, 'quote'),
    notes: text(row, 'notes'),
    epistemicStatus: text(row, 'epistemic_status') as EpistemicStatus,
    origin: provenanceOf(row),
    contentHash: text(row, 'content_hash'),
    ...supersedes === undefined ? {} : { supersedesId: EvidenceId(supersedes) },
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    version: integer(row, 'version'),
  }
}

function mapRelation(row: SqlRow): KnowledgeRelation {
  return {
    id: KnowledgeRelationId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    fromEntityType: text(row, 'from_entity_type') as EntityType,
    fromEntityId: text(row, 'from_entity_id'),
    toEntityType: text(row, 'to_entity_type') as EntityType,
    toEntityId: text(row, 'to_entity_id'),
    relationType: text(row, 'relation_type') as KnowledgeRelation['relationType'],
    confidence: real(row, 'confidence'),
    epistemicStatus: text(row, 'epistemic_status') as EpistemicStatus,
    sourceIds: (json(row, 'source_ids_json') as string[]).map(SourceId),
    origin: provenanceOf(row),
    status: text(row, 'status') as KnowledgeRelation['status'],
    createdAt: integer(row, 'created_at'),
  }
}

function mapQuestion(row: SqlRow): ResearchQuestion {
  const branchId = optionalText(row, 'branch_id')
  return {
    id: QuestionId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    ...branchId === undefined ? {} : { branchId: BranchId(branchId) },
    question: text(row, 'question'),
    motivation: text(row, 'motivation'),
    origin: text(row, 'origin') as ResearchQuestion['origin'],
    priority: integer(row, 'priority'),
    status: text(row, 'status') as QuestionStatus,
    relatedClaimIds: (json(row, 'related_claim_ids_json') as string[]).map(ClaimId),
    relatedHypothesisIds: (json(row, 'related_hypothesis_ids_json') as string[]).map(HypothesisId),
    answerSummary: text(row, 'answer_summary'),
    provenance: provenanceOf(row),
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    version: integer(row, 'version'),
  }
}

function mapGap(row: SqlRow): ResearchGap {
  const branchId = optionalText(row, 'branch_id')
  return {
    id: GapId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    ...branchId === undefined ? {} : { branchId: BranchId(branchId) },
    gapType: text(row, 'gap_type') as ResearchGap['gapType'],
    gapDescription: text(row, 'gap_description'),
    relatedWork: text(row, 'related_work'),
    missingConnection: text(row, 'missing_connection'),
    evidence: text(row, 'evidence'),
    noveltyAssessment: text(row, 'novelty_assessment'),
    uncertainty: real(row, 'uncertainty'),
    status: text(row, 'status') as GapStatus,
    provenance: provenanceOf(row),
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    version: integer(row, 'version'),
  }
}

function mapHypothesis(row: SqlRow): ResearchHypothesis {
  const branchId = optionalText(row, 'branch_id')
  return {
    id: HypothesisId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    ...branchId === undefined ? {} : { branchId: BranchId(branchId) },
    title: text(row, 'title'),
    description: text(row, 'description'),
    theoreticalReasoning: text(row, 'theoretical_reasoning'),
    assumptions: json(row, 'assumptions_json') as string[],
    boundaryConditions: json(row, 'boundary_conditions_json') as string[],
    alternativeExplanations: json(row, 'alternative_explanations_json') as string[],
    falsificationConditions: json(row, 'falsification_conditions_json') as string[],
    relatedWork: json(row, 'related_work_json') as string[],
    status: text(row, 'status') as HypothesisStatus,
    currentVersion: integer(row, 'current_version'),
    provenance: provenanceOf(row),
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
  }
}

function mapDiscovery(row: SqlRow): ResearchDiscovery {
  const branchId = optionalText(row, 'branch_id')
  const verdict = optionalText(row, 'reviewer_verdict')
  const scores: Record<string, number> = {}
  const fields = {
    novelty: 'novelty_score',
    gapQuality: 'gap_quality_score',
    evidenceQuality: 'evidence_quality_score',
    logicalConsistency: 'logical_consistency_score',
    falsifiability: 'falsifiability_score',
    potentialImpact: 'potential_impact_score',
    total: 'total_score',
  } as const
  for (const [key, column] of Object.entries(fields)) {
    const value = optionalReal(row, column)
    if (value !== undefined) scores[key] = value
  }
  return {
    id: DiscoveryId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    ...branchId === undefined ? {} : { branchId: BranchId(branchId) },
    discoveryType: text(row, 'discovery_type') as ResearchDiscovery['discoveryType'],
    description: text(row, 'description'),
    reasoningChain: text(row, 'reasoning_chain'),
    supportingEntityIds: json(row, 'supporting_entity_ids_json') as string[],
    contradictingEntityIds: json(row, 'contradicting_entity_ids_json') as string[],
    scores,
    scoreExplanation: json(row, 'score_explanation_json'),
    ...verdict === undefined ? {} : { reviewerVerdict: verdict as ReviewerVerdict },
    status: text(row, 'status') as DiscoveryStatus,
    provenance: provenanceOf(row),
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    version: integer(row, 'version'),
  }
}

function mapDecision(row: SqlRow): ResearchDecision {
  const branchId = optionalText(row, 'branch_id')
  return {
    id: DecisionId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    ...branchId === undefined ? {} : { branchId: BranchId(branchId) },
    title: text(row, 'title'),
    decision: text(row, 'decision'),
    rationale: text(row, 'rationale'),
    alternatives: json(row, 'alternatives_json') as string[],
    consequences: text(row, 'consequences'),
    provenance: provenanceOf(row),
    createdAt: integer(row, 'created_at'),
    createdBy: text(row, 'created_by'),
  }
}

function mapArtifact(row: SqlRow): ResearchArtifact {
  const branchId = optionalText(row, 'branch_id')
  const path = optionalText(row, 'path')
  const mimeType = optionalText(row, 'mime_type')
  const contentHash = optionalText(row, 'content_hash')
  const sizeBytes = optionalInteger(row, 'size_bytes')
  const markdown = optionalText(row, 'markdown')
  return {
    id: ArtifactId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    ...branchId === undefined ? {} : { branchId: BranchId(branchId) },
    artifactType: text(row, 'artifact_type') as ResearchArtifact['artifactType'],
    title: text(row, 'title'),
    ...path === undefined ? {} : { path },
    ...mimeType === undefined ? {} : { mimeType },
    ...contentHash === undefined ? {} : { contentHash },
    ...sizeBytes === undefined ? {} : { sizeBytes },
    ...markdown === undefined ? {} : { markdown },
    metadata: json(row, 'metadata_json'),
    status: text(row, 'status') as ArtifactStatus,
    provenance: provenanceOf(row),
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    version: integer(row, 'version'),
  }
}

function mapBranch(row: SqlRow): ResearchBranch {
  const parent = optionalText(row, 'parent_branch_id')
  const merged = optionalText(row, 'merged_into_id')
  return {
    id: BranchId(text(row, 'id')),
    ideaId: IdeaId(text(row, 'idea_id')),
    ...parent === undefined ? {} : { parentBranchId: BranchId(parent) },
    title: text(row, 'title'),
    description: text(row, 'description'),
    status: text(row, 'status') as BranchStatus,
    ...merged === undefined ? {} : { mergedIntoId: BranchId(merged) },
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    version: integer(row, 'version'),
  }
}

function mapSummary(row: SqlRow): SessionSummary {
  const ideaId = optionalText(row, 'idea_id')
  const supersedes = optionalText(row, 'supersedes_id')
  const provider = optionalText(row, 'model_provider')
  const model = optionalText(row, 'model_id')
  return {
    id: SessionSummaryId(text(row, 'id')),
    sessionId: text(row, 'session_id'),
    ...ideaId === undefined ? {} : { ideaId: IdeaId(ideaId) },
    summary: text(row, 'summary'),
    openQuestions: json(row, 'open_questions_json') as string[],
    hypotheses: json(row, 'hypotheses_json') as string[],
    artifacts: json(row, 'artifacts_json') as string[],
    eventStartSeq: integer(row, 'event_start_seq'),
    eventEndSeq: integer(row, 'event_end_seq'),
    inputHash: text(row, 'input_hash'),
    version: integer(row, 'version'),
    status: text(row, 'status') as SessionSummaryStatus,
    ...supersedes === undefined ? {} : { supersedesId: SessionSummaryId(supersedes) },
    ...provider === undefined ? {} : { modelProvider: provider },
    ...model === undefined ? {} : { modelId: model },
    promptVersion: text(row, 'prompt_version'),
    createdAt: integer(row, 'created_at'),
  }
}

/** Durable source, knowledge, and research-artifact repository. */
export class ResearchArtifactStore {
  private readonly artifactRoot: string

  /**
   * @param database - open research database.
   */
  constructor(private readonly database: ResearchDatabase) {
    this.artifactRoot = join(database.root, 'artifacts')
  }

  // ---- sources ----

  /**
   * Create or reuse a Source by DOI/arXiv/exact URL identity.
   * @param ideaId - Idea that first imports the Source.
   * @param input - bibliographic fields and Idea relevance.
   * @param provenance - Session/tool origin.
   * @returns the Source and Idea link.
   */
  createSource(ideaId: IdeaIdType, input: CreateSourceInput, provenance: Provenance = {}): ResearchSource {
    this.assertIdea(ideaId)
    const title = requireText(input.title, 'title')
    const existing = input.doi !== undefined
      ? this.findSource('doi', input.doi)
      : input.arxivId !== undefined
        ? this.findSource('arxiv_id', input.arxivId)
        : input.canonicalUrl !== undefined ? this.findSource('canonical_url', input.canonicalUrl) : undefined
    if (existing !== undefined) {
      this.linkSource(ideaId, existing.id, input.relevance ?? 'primary', input.note ?? '')
      return existing
    }
    const id = SourceId(newId('src'))
    const now = Date.now()
    this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT INTO research_sources (
          id, origin_idea_id, source_type, title, authors_json, year, venue, doi, arxiv_id,
          url, canonical_url, abstract, metadata_json, content_hash, retrieved_at, status,
          created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)
      `).run(
        id, ideaId, input.sourceType, title, jsonText(input.authors ?? []), input.year ?? null,
        input.venue ?? null, input.doi ?? null, input.arxivId ?? null, input.url ?? null,
        input.canonicalUrl ?? null, input.abstract ?? null, jsonText(input.metadata ?? {}),
        input.contentHash ?? null, input.retrievedAt ?? null, now, now,
      )
      this.linkSource(ideaId, id, input.relevance ?? 'primary', input.note ?? '')
      this.timeline(ideaId, 'source', id, 'source.created', `Imported source: ${title}`, provenance, { sourceType: input.sourceType }, now)
    })
    return this.requireSource(id)
  }

  /**
   * Link an existing Source to an Idea.
   * @param ideaId - target Idea.
   * @param sourceId - shared Source.
   * @param relevance - usage kind.
   * @param note - optional note.
   */
  linkSource(ideaId: IdeaIdType, sourceId: SourceId, relevance: SourceRelevance = 'cited', note: string = ''): void {
    this.assertIdea(ideaId)
    this.requireSource(sourceId)
    const now = Date.now()
    this.database.connection.prepare(`
      INSERT INTO research_idea_sources (idea_id, source_id, relevance, note, added_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (idea_id, source_id) DO UPDATE SET relevance = excluded.relevance, note = excluded.note
    `).run(ideaId, sourceId, relevance, note, now)
  }

  /**
   * Read one Source.
   * @param sourceId - shared Source identity.
   * @returns the Source.
   */
  getSource(sourceId: SourceId): ResearchSource | undefined {
    const row = this.database.connection.prepare('SELECT * FROM research_sources WHERE id = ?').get(sourceId)
    return row === undefined ? undefined : mapSource(row)
  }

  /**
   * List Sources used by an Idea.
   * @param ideaId - owning Idea.
   * @returns linked Sources in import order.
   */
  listSources(ideaId: IdeaIdType): ResearchSource[] {
    this.assertIdea(ideaId)
    return this.database.connection.prepare(`
      SELECT source.* FROM research_sources source
      JOIN research_idea_sources link ON link.source_id = source.id
      WHERE link.idea_id = ? ORDER BY link.added_at ASC
    `).all(ideaId).map(mapSource)
  }

  /**
   * Add a locator inside a Source.
   * @param sourceId - shared Source.
   * @param input - locator type/value and optional coordinates.
   * @returns the persisted locator.
   */
  createSourceLocation(sourceId: SourceId, input: CreateSourceLocationInput): SourceLocation {
    this.requireSource(sourceId)
    const locator = requireText(input.locator, 'locator')
    const id = SourceLocationId(newId('loc'))
    this.database.connection.prepare(`
      INSERT INTO research_source_locations (
        id, source_id, locator_type, locator, page, char_start, char_end, quote, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, sourceId, input.locatorType, locator, input.page ?? null,
      input.charStart ?? null, input.charEnd ?? null, input.quote ?? '', Date.now())
    return this.requireLocation(id)
  }

  /**
   * List locators for a Source.
   * @param sourceId - shared Source.
   * @returns locators in creation order.
   */
  listSourceLocations(sourceId: SourceId): SourceLocation[] {
    this.requireSource(sourceId)
    return this.database.connection.prepare(`
      SELECT * FROM research_source_locations WHERE source_id = ? ORDER BY created_at ASC
    `).all(sourceId).map(mapLocation)
  }

  // ---- concepts, claims, evidence, relations ----

  /**
   * Create a Concept under an Idea.
   * @param ideaId - owning Idea.
   * @param input - name, definition, aliases, and optional parent.
   * @returns the persisted Concept.
   */
  createConcept(ideaId: IdeaIdType, input: CreateConceptInput): ResearchConcept {
    this.assertIdea(ideaId)
    const name = requireText(input.name, 'name')
    if (input.parentConceptId !== undefined) this.requireConcept(input.parentConceptId)
    const id = ConceptId(newId('con'))
    const now = Date.now()
    try {
      this.database.connection.prepare(`
        INSERT INTO research_concepts (
          id, idea_id, name, definition, aliases_json, parent_concept_id, status, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)
      `).run(id, ideaId, name, input.definition ?? '', jsonText(input.aliases ?? []), input.parentConceptId ?? null, now, now)
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        throw new ResearchError('research/duplicate', `Concept "${name}" already exists`, { name })
      }
      throw error
    }
    this.timeline(ideaId, 'concept', id, 'concept.created', `Created concept: ${name}`, {}, { name }, now)
    return this.requireConcept(id)
  }

  /**
   * List Concepts for an Idea.
   * @param ideaId - owning Idea.
   * @returns concepts in creation order.
   */
  listConcepts(ideaId: IdeaIdType): ResearchConcept[] {
    this.assertIdea(ideaId)
    return this.database.connection.prepare(`
      SELECT * FROM research_concepts WHERE idea_id = ? ORDER BY created_at ASC
    `).all(ideaId).map(mapConcept)
  }

  /**
   * Create a Claim with provenance and an immutable first version.
   * @param ideaId - owning Idea.
   * @param input - statement, epistemic status, confidence, and sources.
   * @param provenance - Session/tool origin.
   * @returns the persisted Claim.
   */
  createClaim(ideaId: IdeaIdType, input: CreateClaimInput, provenance: Provenance = {}): ResearchClaim {
    this.assertIdea(ideaId)
    const statement = requireText(input.statement, 'statement')
    const existing = provenance.originToolCallId === undefined
      ? undefined
      : this.claimByToolCall(provenance.originToolCallId)
    if (existing !== undefined) return existing
    for (const sourceId of input.sourceIds ?? []) this.requireSource(sourceId)
    if ((input.epistemicStatus ?? 'reported') === 'reported' && (input.sourceIds === undefined || input.sourceIds.length === 0)) {
      throw new ResearchError('research/invalid-input', 'a reported claim requires at least one source', { statement })
    }
    const id = ClaimId(newId('clm'))
    const now = Date.now()
    const normalized = input.normalizedStatement ?? statement
    const contentHash = digest(normalized)
    this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT INTO research_claims (
          id, idea_id, statement, normalized_statement, epistemic_status, confidence, status,
          source_ids_json, origin_session_id, origin_event_seq, origin_tool_call_id, content_hash,
          supersedes_id, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(id, ideaId, statement, normalized, input.epistemicStatus ?? 'reported',
        unit(input.confidence ?? 0.5, 'confidence'), jsonText(input.sourceIds ?? []),
        provenance.originSessionId ?? null, provenance.originEventSeq ?? null,
        provenance.originToolCallId ?? null, contentHash, input.supersedesId ?? null, now, now)
      this.snapshotClaim(id, 1, 'created', 'tool', now)
      this.timeline(ideaId, 'claim', id, 'claim.created', `Created claim: ${statement.slice(0, 120)}`, provenance,
        { epistemicStatus: input.epistemicStatus ?? 'reported' }, now)
    })
    return this.requireClaim(id)
  }

  /**
   * Update a Claim and retain the previous snapshot in its version history.
   * @param claimId - Claim identity.
   * @param patch - admitted field changes.
   * @param changeReason - why the Claim changed.
   * @param actor - user, tool, or system author.
   * @returns the updated Claim.
   */
  updateClaim(claimId: ClaimId, patch: UpdateClaimInput, changeReason: string, actor: string = 'tool'): ResearchClaim {
    const current = this.requireClaim(claimId)
    if (changeReason.trim() === '') {
      throw new ResearchError('research/invalid-input', 'claim change requires a reason', { claimId })
    }
    const statement = patch.statement ?? current.statement
    const confidence = unit(patch.confidence ?? current.confidence, 'confidence')
    const sourceIds = patch.sourceIds ?? current.sourceIds
    for (const sourceId of sourceIds) this.requireSource(sourceId)
    const normalized = patch.normalizedStatement ?? patch.statement ?? current.normalizedStatement
    const now = Date.now()
    this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE research_claims
        SET statement = ?, normalized_statement = ?, epistemic_status = ?, confidence = ?, status = ?,
            source_ids_json = ?, content_hash = ?, updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(statement, normalized, patch.epistemicStatus ?? current.epistemicStatus, confidence,
        patch.status ?? current.status, jsonText(sourceIds), digest(normalized), now, claimId)
      const next = this.requireClaim(claimId)
      this.snapshotClaim(claimId, next.version, changeReason, actor, now)
      this.timeline(current.ideaId, 'claim', claimId, 'claim.updated', `Updated claim: ${statement.slice(0, 120)}`,
        current.origin, { changeReason, version: next.version }, now)
    })
    return this.requireClaim(claimId)
  }

  /**
   * Read one Claim.
   * @param claimId - Claim identity.
   * @returns the Claim.
   */
  getClaim(claimId: ClaimId): ResearchClaim | undefined {
    const row = this.database.connection.prepare('SELECT * FROM research_claims WHERE id = ?').get(claimId)
    return row === undefined ? undefined : mapClaim(row)
  }

  /**
   * List Claims for an Idea.
   * @param ideaId - owning Idea.
   * @param status - optional lifecycle filter.
   * @returns claims newest-first.
   */
  listClaims(ideaId: IdeaIdType, status?: ClaimStatus): ResearchClaim[] {
    this.assertIdea(ideaId)
    const rows = status === undefined
      ? this.database.connection.prepare('SELECT * FROM research_claims WHERE idea_id = ? ORDER BY updated_at DESC').all(ideaId)
      : this.database.connection.prepare('SELECT * FROM research_claims WHERE idea_id = ? AND status = ? ORDER BY updated_at DESC').all(ideaId, status)
    return rows.map(mapClaim)
  }

  /**
   * List the immutable version history of a Claim.
   * @param claimId - Claim identity.
   * @returns versions newest-first.
   */
  listClaimVersions(claimId: ClaimId): ClaimVersion[] {
    this.requireClaim(claimId)
    return this.database.connection.prepare(`
      SELECT * FROM research_claim_versions WHERE claim_id = ? ORDER BY version DESC
    `).all(claimId).map(row => ({
      id: text(row, 'id'),
      claimId: ClaimId(text(row, 'claim_id')),
      version: integer(row, 'version'),
      snapshot: json(row, 'snapshot_json'),
      changeReason: text(row, 'change_reason'),
      createdBy: text(row, 'created_by'),
      createdAt: integer(row, 'created_at'),
    }))
  }

  /**
   * Create Evidence for a Source and optional Claim.
   * @param ideaId - owning Idea.
   * @param input - source, optional locator/claim, direction, and quote.
   * @param provenance - Session/tool origin.
   * @returns the persisted Evidence.
   */
  createEvidence(ideaId: IdeaIdType, input: CreateEvidenceInput, provenance: Provenance = {}): ResearchEvidence {
    this.assertIdea(ideaId)
    this.requireSource(input.sourceId)
    if (input.claimId !== undefined) {
      const claim = this.requireClaim(input.claimId)
      if (claim.ideaId !== ideaId) {
        throw new ResearchError('research/invalid-input', 'evidence claim belongs to another Idea', { claimId: input.claimId })
      }
    }
    if (input.locationId !== undefined) {
      const location = this.requireLocation(input.locationId)
      if (location.sourceId !== input.sourceId) {
        throw new ResearchError('research/invalid-input', 'evidence location belongs to another Source', { locationId: input.locationId })
      }
    }
    if ((input.epistemicStatus ?? 'reported') === 'reported' && (input.quote ?? '').trim() === '') {
      throw new ResearchError('research/invalid-input', 'reported evidence requires a quote', { sourceId: input.sourceId })
    }
    const id = EvidenceId(newId('evd'))
    const now = Date.now()
    const contentHash = digest(`${input.sourceId}\n${input.claimId ?? ''}\n${input.quote ?? ''}`)
    this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT INTO research_evidence (
          id, idea_id, claim_id, source_id, location_id, evidence_type, strength, quote, notes,
          epistemic_status, origin_session_id, origin_event_seq, origin_tool_call_id, content_hash,
          supersedes_id, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(id, ideaId, input.claimId ?? null, input.sourceId, input.locationId ?? null,
        input.evidenceType, unit(input.strength ?? 0.5, 'strength'), input.quote ?? '', input.notes ?? '',
        input.epistemicStatus ?? 'reported', provenance.originSessionId ?? null,
        provenance.originEventSeq ?? null, provenance.originToolCallId ?? null, contentHash,
        input.supersedesId ?? null, now, now)
      this.timeline(ideaId, 'evidence', id, 'evidence.created', `Added ${input.evidenceType} evidence`, provenance,
        { claimId: input.claimId ?? null, sourceId: input.sourceId }, now)
    })
    return this.requireEvidence(id)
  }

  /**
   * List Evidence for an Idea, optionally restricted to one Claim.
   * @param ideaId - owning Idea.
   * @param claimId - optional Claim filter.
   * @returns evidence newest-first.
   */
  listEvidence(ideaId: IdeaIdType, claimId?: ClaimId): ResearchEvidence[] {
    this.assertIdea(ideaId)
    const rows = claimId === undefined
      ? this.database.connection.prepare('SELECT * FROM research_evidence WHERE idea_id = ? ORDER BY created_at DESC').all(ideaId)
      : this.database.connection.prepare('SELECT * FROM research_evidence WHERE idea_id = ? AND claim_id = ? ORDER BY created_at DESC').all(ideaId, claimId)
    return rows.map(mapEvidence)
  }

  /**
   * Create a relation only when both endpoints exist in the Idea.
   * @param ideaId - owning Idea.
   * @param input - endpoints, relation kind, and confidence.
   * @param provenance - Session/tool origin.
   * @returns the existing or new relation.
   */
  createKnowledgeRelation(ideaId: IdeaIdType, input: CreateKnowledgeRelationInput, provenance: Provenance = {}): KnowledgeRelation {
    this.assertIdea(ideaId)
    if (input.fromEntityType === input.toEntityType && input.fromEntityId === input.toEntityId) {
      throw new ResearchError('research/relation-invalid', 'a relation needs two distinct entities', {})
    }
    this.assertEntity(ideaId, input.fromEntityType, input.fromEntityId)
    this.assertEntity(ideaId, input.toEntityType, input.toEntityId)
    for (const sourceId of input.sourceIds ?? []) this.requireSource(sourceId)
    const existing = this.database.connection.prepare(`
      SELECT * FROM research_relations
      WHERE idea_id = ? AND from_entity_type = ? AND from_entity_id = ?
        AND to_entity_type = ? AND to_entity_id = ? AND relation_type = ?
    `).get(ideaId, input.fromEntityType, input.fromEntityId, input.toEntityType, input.toEntityId, input.relationType)
    if (existing !== undefined) return mapRelation(existing)
    const id = KnowledgeRelationId(newId('rel'))
    const now = Date.now()
    this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT INTO research_relations (
          id, idea_id, from_entity_type, from_entity_id, to_entity_type, to_entity_id,
          relation_type, confidence, epistemic_status, source_ids_json, origin_session_id,
          origin_event_seq, created_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
      `).run(id, ideaId, input.fromEntityType, input.fromEntityId, input.toEntityType, input.toEntityId,
        input.relationType, unit(input.confidence ?? 0.5, 'confidence'), input.epistemicStatus ?? 'inferred',
        jsonText(input.sourceIds ?? []), provenance.originSessionId ?? null, provenance.originEventSeq ?? null, now)
      this.timeline(ideaId, input.fromEntityType, input.fromEntityId, 'relation.created',
        `Created relation: ${input.relationType}`, provenance, {
          from: input.fromEntityId, to: input.toEntityId, relationType: input.relationType,
        }, now)
    })
    const row = this.database.connection.prepare('SELECT * FROM research_relations WHERE id = ?').get(id)
    if (row === undefined) throw new ResearchError('research/database-unavailable', 'relation disappeared after insert', { id })
    return mapRelation(row)
  }

  /**
   * List relations for an Idea or one endpoint.
   * @param ideaId - owning Idea.
   * @param entityType - optional endpoint kind.
   * @param entityId - optional endpoint identity.
   * @returns relations newest-first.
   */
  listKnowledgeRelations(ideaId: IdeaIdType, entityType?: EntityType, entityId?: string): KnowledgeRelation[] {
    this.assertIdea(ideaId)
    if (entityType === undefined || entityId === undefined) {
      return this.database.connection.prepare(`
        SELECT * FROM research_relations WHERE idea_id = ? ORDER BY created_at DESC
      `).all(ideaId).map(mapRelation)
    }
    return this.database.connection.prepare(`
      SELECT * FROM research_relations WHERE idea_id = ?
        AND ((from_entity_type = ? AND from_entity_id = ?) OR (to_entity_type = ? AND to_entity_id = ?))
      ORDER BY created_at DESC
    `).all(ideaId, entityType, entityId, entityType, entityId).map(mapRelation)
  }

  // ---- branches, questions, gaps, hypotheses ----

  /**
   * Create a branch under an Idea.
   * @param ideaId - owning Idea.
   * @param input - title, description, and optional parent.
   * @returns the persisted branch.
   */
  createBranch(ideaId: IdeaIdType, input: CreateBranchInput): ResearchBranch {
    this.assertIdea(ideaId)
    const title = requireText(input.title, 'title')
    if (input.parentBranchId !== undefined) this.assertBranch(ideaId, input.parentBranchId)
    const id = BranchId(newId('brn'))
    const now = Date.now()
    this.database.connection.prepare(`
      INSERT INTO research_branches (
        id, idea_id, parent_branch_id, title, description, status, merged_into_id, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, 1)
    `).run(id, ideaId, input.parentBranchId ?? null, title, input.description ?? '', now, now)
    this.timeline(ideaId, 'branch', id, 'branch.created', `Created branch: ${title}`, {}, { title }, now)
    return this.requireBranch(id)
  }

  /**
   * Update a branch.
   * @param branchId - branch identity.
   * @param patch - admitted field changes.
   * @returns the updated branch.
   */
  updateBranch(branchId: BranchId, patch: UpdateBranchInput): ResearchBranch {
    const current = this.requireBranch(branchId)
    if (patch.mergedIntoId !== undefined) {
      if (patch.mergedIntoId === branchId) {
        throw new ResearchError('research/invalid-input', 'a branch cannot merge into itself', { branchId })
      }
      this.assertBranch(current.ideaId, patch.mergedIntoId)
    }
    const now = Date.now()
    this.database.connection.prepare(`
      UPDATE research_branches
      SET title = ?, description = ?, status = ?, merged_into_id = ?, updated_at = ?, version = version + 1
      WHERE id = ?
    `).run(patch.title ?? current.title, patch.description ?? current.description,
      patch.status ?? current.status, patch.mergedIntoId ?? current.mergedIntoId ?? null, now, branchId)
    return this.requireBranch(branchId)
  }

  /**
   * List branches for an Idea.
   * @param ideaId - owning Idea.
   * @returns branches newest-first.
   */
  listBranches(ideaId: IdeaIdType): ResearchBranch[] {
    this.assertIdea(ideaId)
    return this.database.connection.prepare(`
      SELECT * FROM research_branches WHERE idea_id = ? ORDER BY updated_at DESC
    `).all(ideaId).map(mapBranch)
  }

  /**
   * Create a Research Question.
   * @param ideaId - owning Idea.
   * @param input - question text and optional links.
   * @param provenance - Session/tool origin.
   * @returns the persisted Question.
   */
  createQuestion(ideaId: IdeaIdType, input: CreateQuestionInput, provenance: Provenance = {}): ResearchQuestion {
    this.assertIdea(ideaId)
    const question = requireText(input.question, 'question')
    if (input.branchId !== undefined) this.assertBranch(ideaId, input.branchId)
    for (const claimId of input.relatedClaimIds ?? []) this.requireClaim(claimId)
    for (const hypothesisId of input.relatedHypothesisIds ?? []) this.requireHypothesis(hypothesisId)
    const id = QuestionId(newId('qst'))
    const now = Date.now()
    this.database.connection.prepare(`
      INSERT INTO research_questions (
        id, idea_id, branch_id, question, motivation, origin, priority, status,
        related_claim_ids_json, related_hypothesis_ids_json, answer_summary,
        origin_session_id, origin_event_seq, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, '', ?, ?, ?, ?, 1)
    `).run(id, ideaId, input.branchId ?? null, question, input.motivation ?? '',
      input.origin ?? 'session', priority(input.priority ?? 3), jsonText(input.relatedClaimIds ?? []),
      jsonText(input.relatedHypothesisIds ?? []), provenance.originSessionId ?? null,
      provenance.originEventSeq ?? null, now, now)
    this.timeline(ideaId, 'question', id, 'question.created', `Created question: ${question.slice(0, 120)}`, provenance,
      { priority: input.priority ?? 3 }, now)
    return this.requireQuestion(id)
  }

  /**
   * Update a Research Question.
   * @param questionId - Question identity.
   * @param patch - admitted field changes.
   * @returns the updated Question.
   */
  updateQuestion(questionId: QuestionId, patch: UpdateQuestionInput): ResearchQuestion {
    const current = this.requireQuestion(questionId)
    const now = Date.now()
    this.database.connection.prepare(`
      UPDATE research_questions
      SET question = ?, motivation = ?, priority = ?, status = ?, answer_summary = ?,
          updated_at = ?, version = version + 1
      WHERE id = ?
    `).run(patch.question ?? current.question, patch.motivation ?? current.motivation,
      patch.priority === undefined ? current.priority : priority(patch.priority),
      patch.status ?? current.status, patch.answerSummary ?? current.answerSummary, now, questionId)
    return this.requireQuestion(questionId)
  }

  /**
   * List Research Questions for an Idea.
   * @param ideaId - owning Idea.
   * @returns questions by priority and update time.
   */
  listQuestions(ideaId: IdeaIdType): ResearchQuestion[] {
    this.assertIdea(ideaId)
    return this.database.connection.prepare(`
      SELECT * FROM research_questions WHERE idea_id = ? ORDER BY priority ASC, updated_at DESC
    `).all(ideaId).map(mapQuestion)
  }

  /**
   * Create a Research Gap.
   * @param ideaId - owning Idea.
   * @param input - gap kind, description, and assessment.
   * @param provenance - Session/tool origin.
   * @returns the persisted Gap.
   */
  createGap(ideaId: IdeaIdType, input: CreateGapInput, provenance: Provenance = {}): ResearchGap {
    this.assertIdea(ideaId)
    const description = requireText(input.gapDescription, 'gapDescription')
    if (input.branchId !== undefined) this.assertBranch(ideaId, input.branchId)
    const id = GapId(newId('gap'))
    const now = Date.now()
    this.database.connection.prepare(`
      INSERT INTO research_gaps (
        id, idea_id, branch_id, gap_type, gap_description, related_work, missing_connection,
        evidence, novelty_assessment, uncertainty, status, origin_session_id, origin_event_seq,
        created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, 1)
    `).run(id, ideaId, input.branchId ?? null, input.gapType, description, input.relatedWork ?? '',
      input.missingConnection ?? '', input.evidence ?? '', input.noveltyAssessment ?? '',
      unit(input.uncertainty ?? 0.5, 'uncertainty'), provenance.originSessionId ?? null,
      provenance.originEventSeq ?? null, now, now)
    this.timeline(ideaId, 'gap', id, 'gap.created', `Created gap: ${description.slice(0, 120)}`, provenance,
      { gapType: input.gapType }, now)
    return this.requireGap(id)
  }

  /**
   * Update a Research Gap.
   * @param gapId - Gap identity.
   * @param patch - admitted field changes.
   * @returns the updated Gap.
   */
  updateGap(gapId: GapId, patch: UpdateGapInput): ResearchGap {
    const current = this.requireGap(gapId)
    const now = Date.now()
    this.database.connection.prepare(`
      UPDATE research_gaps
      SET gap_description = ?, related_work = ?, missing_connection = ?, evidence = ?,
          novelty_assessment = ?, uncertainty = ?, status = ?, updated_at = ?, version = version + 1
      WHERE id = ?
    `).run(patch.gapDescription ?? current.gapDescription, patch.relatedWork ?? current.relatedWork,
      patch.missingConnection ?? current.missingConnection, patch.evidence ?? current.evidence,
      patch.noveltyAssessment ?? current.noveltyAssessment,
      patch.uncertainty === undefined ? current.uncertainty : unit(patch.uncertainty, 'uncertainty'),
      patch.status ?? current.status, now, gapId)
    return this.requireGap(gapId)
  }

  /**
   * List Research Gaps for an Idea.
   * @param ideaId - owning Idea.
   * @returns gaps newest-first.
   */
  listGaps(ideaId: IdeaIdType): ResearchGap[] {
    this.assertIdea(ideaId)
    return this.database.connection.prepare(`
      SELECT * FROM research_gaps WHERE idea_id = ? ORDER BY updated_at DESC
    `).all(ideaId).map(mapGap)
  }

  /**
   * Create a Hypothesis and its first immutable version snapshot.
   * @param ideaId - owning Idea.
   * @param input - hypothesis text and structured conditions.
   * @param provenance - Session/tool origin.
   * @returns the persisted Hypothesis.
   */
  createHypothesis(ideaId: IdeaIdType, input: CreateHypothesisInput, provenance: Provenance = {}): ResearchHypothesis {
    this.assertIdea(ideaId)
    const title = requireText(input.title, 'title')
    const description = requireText(input.description, 'description')
    if (input.branchId !== undefined) this.assertBranch(ideaId, input.branchId)
    const id = HypothesisId(newId('hyp'))
    const now = Date.now()
    this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT INTO research_hypotheses (
          id, idea_id, branch_id, title, description, theoretical_reasoning,
          assumptions_json, boundary_conditions_json, alternative_explanations_json,
          falsification_conditions_json, related_work_json, status, current_version,
          origin_session_id, origin_event_seq, origin_tool_call_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 1, ?, ?, ?, ?, ?)
      `).run(id, ideaId, input.branchId ?? null, title, description, input.theoreticalReasoning ?? '',
        jsonText(input.assumptions ?? []), jsonText(input.boundaryConditions ?? []),
        jsonText(input.alternativeExplanations ?? []), jsonText(input.falsificationConditions ?? []),
        jsonText(input.relatedWork ?? []), provenance.originSessionId ?? null,
        provenance.originEventSeq ?? null, provenance.originToolCallId ?? null, now, now)
      this.snapshotHypothesis(id, 1, 'created', 'tool', now)
      this.timeline(ideaId, 'hypothesis', id, 'hypothesis.created', `Created hypothesis: ${title}`, provenance,
        { status: 'candidate' }, now)
    })
    return this.requireHypothesis(id)
  }

  /**
   * Update a Hypothesis, snapshotting the new version.
   * @param hypothesisId - Hypothesis identity.
   * @param patch - admitted field changes.
   * @param changeReason - why the Hypothesis changed.
   * @param actor - user, tool, or system author.
   * @returns the updated Hypothesis.
   */
  updateHypothesis(
    hypothesisId: HypothesisId,
    patch: UpdateHypothesisInput,
    changeReason: string,
    actor: string = 'tool',
  ): ResearchHypothesis {
    const current = this.requireHypothesis(hypothesisId)
    if (changeReason.trim() === '') {
      throw new ResearchError('research/invalid-input', 'hypothesis change requires a reason', { hypothesisId })
    }
    const now = Date.now()
    this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE research_hypotheses
        SET title = ?, description = ?, theoretical_reasoning = ?, assumptions_json = ?,
            boundary_conditions_json = ?, alternative_explanations_json = ?,
            falsification_conditions_json = ?, related_work_json = ?, status = ?,
            current_version = current_version + 1, updated_at = ?
        WHERE id = ?
      `).run(patch.title ?? current.title, patch.description ?? current.description,
        patch.theoreticalReasoning ?? current.theoreticalReasoning,
        jsonText(patch.assumptions ?? current.assumptions),
        jsonText(patch.boundaryConditions ?? current.boundaryConditions),
        jsonText(patch.alternativeExplanations ?? current.alternativeExplanations),
        jsonText(patch.falsificationConditions ?? current.falsificationConditions),
        jsonText(patch.relatedWork ?? current.relatedWork), patch.status ?? current.status, now, hypothesisId)
      const next = this.requireHypothesis(hypothesisId)
      this.snapshotHypothesis(hypothesisId, next.currentVersion, changeReason, actor, now)
      this.timeline(current.ideaId, 'hypothesis', hypothesisId, 'hypothesis.updated',
        `Updated hypothesis: ${next.title}`, current.provenance,
        { changeReason, version: next.currentVersion }, now)
    })
    return this.requireHypothesis(hypothesisId)
  }

  /**
   * Link Evidence to a Hypothesis.
   * @param hypothesisId - Hypothesis identity.
   * @param evidenceId - Evidence identity.
   * @param relation - supports, refutes, or context.
   * @param note - optional note.
   * @param weight - relative weight.
   */
  linkHypothesisEvidence(
    hypothesisId: HypothesisId,
    evidenceId: EvidenceId,
    relation: HypothesisEvidenceRelation,
    note: string = '',
    weight: number = 1,
  ): void {
    this.requireHypothesis(hypothesisId)
    this.requireEvidence(evidenceId)
    this.database.connection.prepare(`
      INSERT INTO research_hypothesis_evidence (hypothesis_id, evidence_id, relation, weight, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (hypothesis_id, evidence_id, relation) DO UPDATE SET weight = excluded.weight, note = excluded.note
    `).run(hypothesisId, evidenceId, relation, unit(weight, 'weight'), note, Date.now())
  }

  /**
   * List Hypothesis-to-Evidence links.
   * @param hypothesisId - Hypothesis identity.
   * @returns links in creation order.
   */
  listHypothesisEvidence(hypothesisId: HypothesisId): HypothesisEvidence[] {
    this.requireHypothesis(hypothesisId)
    return this.database.connection.prepare(`
      SELECT * FROM research_hypothesis_evidence WHERE hypothesis_id = ? ORDER BY created_at ASC
    `).all(hypothesisId).map(row => ({
      hypothesisId: HypothesisId(text(row, 'hypothesis_id')),
      evidenceId: EvidenceId(text(row, 'evidence_id')),
      relation: text(row, 'relation') as HypothesisEvidenceRelation,
      weight: real(row, 'weight'),
      note: text(row, 'note'),
      createdAt: integer(row, 'created_at'),
    }))
  }

  /**
   * List Hypothesis versions newest-first.
   * @param hypothesisId - Hypothesis identity.
   * @returns immutable version snapshots.
   */
  listHypothesisVersions(hypothesisId: HypothesisId): HypothesisVersion[] {
    this.requireHypothesis(hypothesisId)
    return this.database.connection.prepare(`
      SELECT * FROM research_hypothesis_versions WHERE hypothesis_id = ? ORDER BY version DESC
    `).all(hypothesisId).map(row => ({
      id: text(row, 'id'),
      hypothesisId: HypothesisId(text(row, 'hypothesis_id')),
      version: integer(row, 'version'),
      snapshot: json(row, 'snapshot_json'),
      changeReason: text(row, 'change_reason'),
      createdBy: text(row, 'created_by'),
      createdAt: integer(row, 'created_at'),
    }))
  }

  /**
   * List Hypotheses for an Idea.
   * @param ideaId - owning Idea.
   * @returns hypotheses newest-first.
   */
  listHypotheses(ideaId: IdeaIdType): ResearchHypothesis[] {
    this.assertIdea(ideaId)
    return this.database.connection.prepare(`
      SELECT * FROM research_hypotheses WHERE idea_id = ? ORDER BY updated_at DESC
    `).all(ideaId).map(mapHypothesis)
  }

  // ---- discoveries, decisions, artifacts ----

  /**
   * Create a Discovery candidate.
   * @param ideaId - owning Idea.
   * @param input - discovery kind, description, links, and scores.
   * @param provenance - Session/tool origin.
   * @returns the persisted Discovery.
   */
  createDiscovery(ideaId: IdeaIdType, input: CreateDiscoveryInput, provenance: Provenance = {}): ResearchDiscovery {
    this.assertIdea(ideaId)
    const description = requireText(input.description, 'description')
    if (input.branchId !== undefined) this.assertBranch(ideaId, input.branchId)
    const id = DiscoveryId(newId('dsc'))
    const now = Date.now()
    const scores = input.scores ?? {}
    this.database.connection.prepare(`
      INSERT INTO research_discoveries (
        id, idea_id, branch_id, discovery_type, description, reasoning_chain,
        supporting_entity_ids_json, contradicting_entity_ids_json,
        novelty_score, gap_quality_score, evidence_quality_score, logical_consistency_score,
        falsifiability_score, potential_impact_score, total_score, score_explanation_json,
        reviewer_verdict, status, origin_session_id, origin_event_seq, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, 1)
    `).run(id, ideaId, input.branchId ?? null, input.discoveryType, description, input.reasoningChain ?? '',
      jsonText(input.supportingEntityIds ?? []), jsonText(input.contradictingEntityIds ?? []),
      scores.novelty ?? null, scores.gapQuality ?? null, scores.evidenceQuality ?? null,
      scores.logicalConsistency ?? null, scores.falsifiability ?? null, scores.potentialImpact ?? null,
      scores.total ?? null, jsonText(input.scoreExplanation ?? {}), input.reviewerVerdict ?? null,
      provenance.originSessionId ?? null, provenance.originEventSeq ?? null, now, now)
    this.timeline(ideaId, 'discovery', id, 'discovery.created', `Created discovery: ${description.slice(0, 120)}`, provenance,
      { discoveryType: input.discoveryType }, now)
    return this.requireDiscovery(id)
  }

  /**
   * List Discoveries for an Idea.
   * @param ideaId - owning Idea.
   * @returns discoveries by score and time.
   */
  listDiscoveries(ideaId: IdeaIdType): ResearchDiscovery[] {
    this.assertIdea(ideaId)
    return this.database.connection.prepare(`
      SELECT * FROM research_discoveries WHERE idea_id = ? ORDER BY total_score DESC, updated_at DESC
    `).all(ideaId).map(mapDiscovery)
  }

  /**
   * Create a research Decision.
   * @param ideaId - owning Idea.
   * @param input - decision, rationale, alternatives, and consequences.
   * @param provenance - Session/tool origin.
   * @returns the persisted Decision.
   */
  createDecision(ideaId: IdeaIdType, input: CreateDecisionInput, provenance: Provenance = {}): ResearchDecision {
    this.assertIdea(ideaId)
    const title = requireText(input.title, 'title')
    const decision = requireText(input.decision, 'decision')
    if (input.branchId !== undefined) this.assertBranch(ideaId, input.branchId)
    const id = DecisionId(newId('dec'))
    const now = Date.now()
    this.database.connection.prepare(`
      INSERT INTO research_decisions (
        id, idea_id, branch_id, title, decision, rationale, alternatives_json, consequences,
        origin_session_id, origin_event_seq, created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, ideaId, input.branchId ?? null, title, decision, input.rationale ?? '',
      jsonText(input.alternatives ?? []), input.consequences ?? '', provenance.originSessionId ?? null,
      provenance.originEventSeq ?? null, now, input.createdBy ?? 'tool')
    this.timeline(ideaId, 'decision', id, 'decision.created', `Recorded decision: ${title}`, provenance,
      { decision }, now)
    return this.requireDecision(id)
  }

  /**
   * List Decisions for an Idea.
   * @param ideaId - owning Idea.
   * @returns decisions newest-first.
   */
  listDecisions(ideaId: IdeaIdType): ResearchDecision[] {
    this.assertIdea(ideaId)
    return this.database.connection.prepare(`
      SELECT * FROM research_decisions WHERE idea_id = ? ORDER BY created_at DESC
    `).all(ideaId).map(mapDecision)
  }

  /**
   * Store an Artifact. Content is written to a temporary file, renamed into
   * place, hashed, and only then committed to the database.
   * @param ideaId - owning Idea.
   * @param input - artifact kind, title, and optional text content.
   * @param provenance - Session/tool origin.
   * @returns the persisted Artifact.
   */
  createArtifact(ideaId: IdeaIdType, input: CreateArtifactInput, provenance: Provenance = {}): ResearchArtifact {
    this.assertIdea(ideaId)
    const title = requireText(input.title, 'title')
    if (input.branchId !== undefined) this.assertBranch(ideaId, input.branchId)
    const id = ArtifactId(newId('art'))
    let relative: string | undefined
    let contentHash: string | undefined
    let sizeBytes: number | undefined
    if (input.content !== undefined) {
      mkdirSync(this.artifactRoot, { recursive: true, mode: 0o700 })
      const extension = extname(input.title) || this.extension(input.mimeType)
      relative = join('artifacts', `${id}${extension}`)
      const target = join(this.database.root, relative)
      const temporary = join(this.artifactRoot, `.${id}.tmp`)
      writeFileSync(temporary, input.content, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, target)
      contentHash = digest(input.content)
      sizeBytes = statSync(target).size
    }
    const now = Date.now()
    this.database.connection.prepare(`
      INSERT INTO research_artifacts (
        id, idea_id, branch_id, artifact_type, title, path, mime_type, content_hash,
        size_bytes, markdown, metadata_json, status, origin_session_id, origin_event_seq,
        created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(id, ideaId, input.branchId ?? null, input.artifactType, title, relative ?? null,
      input.mimeType ?? null, contentHash ?? null, sizeBytes ?? null, input.content ?? null,
      jsonText(input.metadata ?? {}), relative === undefined ? 'pending' : 'ready',
      provenance.originSessionId ?? null, provenance.originEventSeq ?? null, now, now)
    this.timeline(ideaId, 'artifact', id, 'artifact.created', `Created artifact: ${title}`, provenance,
      { artifactType: input.artifactType, contentHash: contentHash ?? null }, now)
    return this.requireArtifact(id)
  }

  /**
   * Read one Artifact.
   * @param artifactId - Artifact identity.
   * @returns the Artifact.
   */
  getArtifact(artifactId: ArtifactId): ResearchArtifact | undefined {
    const row = this.database.connection.prepare('SELECT * FROM research_artifacts WHERE id = ?').get(artifactId)
    return row === undefined ? undefined : mapArtifact(row)
  }

  /**
   * Verify an Artifact file against its stored hash.
   * @param artifactId - Artifact identity.
   * @returns the refreshed Artifact and whether the file matches.
   */
  verifyArtifact(artifactId: ArtifactId): { artifact: ResearchArtifact; valid: boolean } {
    const artifact = this.requireArtifact(artifactId)
    if (artifact.path === undefined) {
      return { artifact, valid: false }
    }
    const absolute = join(this.database.root, artifact.path)
    if (!existsSync(absolute)) {
      this.database.connection.prepare(`
        UPDATE research_artifacts SET status = 'missing', updated_at = ? WHERE id = ?
      `).run(Date.now(), artifactId)
      return { artifact: this.requireArtifact(artifactId), valid: false }
    }
    const content = readFileSync(absolute, 'utf8')
    const valid = digest(content) === artifact.contentHash
    this.database.connection.prepare(`
      UPDATE research_artifacts SET status = ?, updated_at = ? WHERE id = ?
    `).run(valid ? 'ready' : 'failed', Date.now(), artifactId)
    return { artifact: this.requireArtifact(artifactId), valid }
  }

  /**
   * List Artifacts for an Idea.
   * @param ideaId - owning Idea.
   * @returns artifacts newest-first.
   */
  listArtifacts(ideaId: IdeaIdType): ResearchArtifact[] {
    this.assertIdea(ideaId)
    return this.database.connection.prepare(`
      SELECT * FROM research_artifacts WHERE idea_id = ? ORDER BY created_at DESC
    `).all(ideaId).map(mapArtifact)
  }

  // ---- session summary snapshots ----

  /**
   * Record one immutable Session Summary snapshot.
   * @param input - summary text, event range, hash, and model attribution.
   * @returns the persisted snapshot.
   */
  recordSessionSummary(input: RecordSessionSummaryInput): SessionSummary {
    const session = this.database.connection.prepare('SELECT * FROM research_sessions WHERE session_id = ?').get(input.sessionId)
    if (session === undefined) {
      throw new ResearchError('research/session-not-found', `Session "${input.sessionId}" not found`, { sessionId: input.sessionId })
    }
    if (input.eventEndSeq < input.eventStartSeq) {
      throw new ResearchError('research/invalid-input', 'summary event range is inverted', {
        start: input.eventStartSeq, end: input.eventEndSeq,
      })
    }
    const prior = this.database.connection.prepare(`
      SELECT MAX(version) AS version FROM research_session_summaries
      WHERE session_id = ? AND event_start_seq = ? AND event_end_seq = ?
    `).get(input.sessionId, input.eventStartSeq, input.eventEndSeq) as SqlRow
    const version = (optionalInteger(prior, 'version') ?? 0) + 1
    const previous = this.database.connection.prepare(`
      SELECT id FROM research_session_summaries
      WHERE session_id = ? AND event_start_seq = ? AND event_end_seq = ? AND status <> 'superseded'
      ORDER BY version DESC LIMIT 1
    `).get(input.sessionId, input.eventStartSeq, input.eventEndSeq)
    const supersedes = previous === undefined ? undefined : text(previous, 'id')
    const id = SessionSummaryId(newId('sum'))
    const now = Date.now()
    this.database.transaction(() => {
      if (supersedes !== undefined) {
        this.database.connection.prepare(`
          UPDATE research_session_summaries SET status = 'superseded' WHERE id = ?
        `).run(supersedes)
      }
      this.database.connection.prepare(`
        INSERT INTO research_session_summaries (
          id, session_id, idea_id, summary, open_questions_json, hypotheses_json, artifacts_json,
          event_start_seq, event_end_seq, input_hash, version, status, supersedes_id,
          model_provider, model_id, prompt_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?)
      `).run(id, input.sessionId, input.ideaId ?? null, input.summary, jsonText(input.openQuestions ?? []),
        jsonText(input.hypotheses ?? []), jsonText(input.artifacts ?? []), input.eventStartSeq,
        input.eventEndSeq, input.inputHash, version, supersedes ?? null, input.modelProvider ?? null,
        input.modelId ?? null, input.promptVersion, now)
    })
    return this.requireSummary(id)
  }

  /**
   * List Session Summaries, optionally for one Session.
   * @param sessionId - optional Session filter.
   * @returns summaries newest-first.
   */
  listSessionSummaries(sessionId?: string): SessionSummary[] {
    const rows = sessionId === undefined
      ? this.database.connection.prepare('SELECT * FROM research_session_summaries ORDER BY created_at DESC').all()
      : this.database.connection.prepare('SELECT * FROM research_session_summaries WHERE session_id = ? ORDER BY created_at DESC').all(sessionId)
    return rows.map(mapSummary)
  }

  // ---- aggregate query ----

  /**
   * Count every Phase 3 entity for one Idea.
   * @param ideaId - owning Idea.
   * @returns entity counts used by graph and workspace queries.
   */
  countEntities(ideaId: IdeaIdType): Record<string, number> {
    this.assertIdea(ideaId)
    const count = (table: string, column: string = 'idea_id'): number => {
      const row = this.database.connection.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(ideaId) as SqlRow
      return integer(row, 'count')
    }
    return {
      sources: count('research_idea_sources'),
      concepts: count('research_concepts'),
      claims: count('research_claims'),
      evidence: count('research_evidence'),
      relations: count('research_relations'),
      questions: count('research_questions'),
      gaps: count('research_gaps'),
      hypotheses: count('research_hypotheses'),
      discoveries: count('research_discoveries'),
      decisions: count('research_decisions'),
      artifacts: count('research_artifacts'),
      branches: count('research_branches'),
      summaries: count('research_session_summaries'),
    }
  }

  // ---- private helpers ----

  private extension(mimeType?: string): string {
    switch (mimeType) {
      case 'text/markdown': return '.md'
      case 'text/html': return '.html'
      case 'application/json': return '.json'
      default: return '.txt'
    }
  }

  private findSource(column: 'doi' | 'arxiv_id' | 'canonical_url', value: string): ResearchSource | undefined {
    const row = this.database.connection.prepare(`SELECT * FROM research_sources WHERE ${column} = ?`).get(value)
    return row === undefined ? undefined : mapSource(row)
  }

  private claimByToolCall(toolCallId: string): ResearchClaim | undefined {
    const row = this.database.connection.prepare('SELECT * FROM research_claims WHERE origin_tool_call_id = ?').get(toolCallId)
    return row === undefined ? undefined : mapClaim(row)
  }

  private snapshotClaim(claimId: ClaimId, version: number, reason: string, actor: string, now: number): void {
    const claim = this.requireClaim(claimId)
    this.database.connection.prepare(`
      INSERT INTO research_claim_versions (id, claim_id, version, snapshot_json, change_reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(newId('clv'), claimId, version, jsonText({ ...claim, sourceIds: claim.sourceIds }), reason, actor, now)
  }

  private snapshotHypothesis(hypothesisId: HypothesisId, version: number, reason: string, actor: string, now: number): void {
    const hypothesis = this.requireHypothesis(hypothesisId)
    this.database.connection.prepare(`
      INSERT INTO research_hypothesis_versions (id, hypothesis_id, version, snapshot_json, change_reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(newId('hyv'), hypothesisId, version, jsonText(hypothesis), reason, actor, now)
  }

  private assertIdea(ideaId: IdeaIdType): void {
    const row = this.database.connection.prepare('SELECT id FROM research_ideas WHERE id = ?').get(ideaId)
    if (row === undefined) {
      throw new ResearchError('research/idea-not-found', `Idea "${ideaId}" not found`, { ideaId })
    }
  }

  private assertEntity(ideaId: IdeaIdType, entityType: EntityType, entityId: string): void {
    const table = ENTITY_TABLES[entityType]
    const row = this.database.connection.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entityId)
    if (row === undefined) {
      throw new ResearchError('research/entity-not-found', `${entityType} "${entityId}" not found`, { entityType, entityId })
    }
    if (entityType !== 'source') {
      const owner = optionalText(row, 'idea_id')
      if (owner !== undefined && owner !== ideaId) {
        throw new ResearchError('research/invalid-input', `${entityType} belongs to another Idea`, { entityType, entityId })
      }
    }
  }

  private assertBranch(ideaId: IdeaIdType, branchId: BranchId): void {
    const branch = this.requireBranch(branchId)
    if (branch.ideaId !== ideaId) {
      throw new ResearchError('research/invalid-input', 'branch belongs to another Idea', { branchId })
    }
  }

  private requireSource(sourceId: SourceId): ResearchSource {
    const source = this.getSource(sourceId)
    if (source === undefined) {
      throw new ResearchError('research/source-not-found', `Source "${sourceId}" not found`, { sourceId })
    }
    return source
  }

  private requireLocation(locationId: SourceLocationId): SourceLocation {
    const row = this.database.connection.prepare('SELECT * FROM research_source_locations WHERE id = ?').get(locationId)
    if (row === undefined) {
      throw new ResearchError('research/source-not-found', `Source location "${locationId}" not found`, { locationId })
    }
    return mapLocation(row)
  }

  private requireConcept(conceptId: ConceptId): ResearchConcept {
    const row = this.database.connection.prepare('SELECT * FROM research_concepts WHERE id = ?').get(conceptId)
    if (row === undefined) {
      throw new ResearchError('research/entity-not-found', `Concept "${conceptId}" not found`, { conceptId })
    }
    return mapConcept(row)
  }

  private requireClaim(claimId: ClaimId): ResearchClaim {
    const claim = this.getClaim(claimId)
    if (claim === undefined) {
      throw new ResearchError('research/claim-not-found', `Claim "${claimId}" not found`, { claimId })
    }
    return claim
  }

  private requireEvidence(evidenceId: EvidenceId): ResearchEvidence {
    const row = this.database.connection.prepare('SELECT * FROM research_evidence WHERE id = ?').get(evidenceId)
    if (row === undefined) {
      throw new ResearchError('research/evidence-not-found', `Evidence "${evidenceId}" not found`, { evidenceId })
    }
    return mapEvidence(row)
  }

  private requireBranch(branchId: BranchId): ResearchBranch {
    const row = this.database.connection.prepare('SELECT * FROM research_branches WHERE id = ?').get(branchId)
    if (row === undefined) {
      throw new ResearchError('research/entity-not-found', `Branch "${branchId}" not found`, { branchId })
    }
    return mapBranch(row)
  }

  private requireQuestion(questionId: QuestionId): ResearchQuestion {
    const row = this.database.connection.prepare('SELECT * FROM research_questions WHERE id = ?').get(questionId)
    if (row === undefined) {
      throw new ResearchError('research/entity-not-found', `Question "${questionId}" not found`, { questionId })
    }
    return mapQuestion(row)
  }

  private requireGap(gapId: GapId): ResearchGap {
    const row = this.database.connection.prepare('SELECT * FROM research_gaps WHERE id = ?').get(gapId)
    if (row === undefined) {
      throw new ResearchError('research/entity-not-found', `Gap "${gapId}" not found`, { gapId })
    }
    return mapGap(row)
  }

  private requireHypothesis(hypothesisId: HypothesisId): ResearchHypothesis {
    const row = this.database.connection.prepare('SELECT * FROM research_hypotheses WHERE id = ?').get(hypothesisId)
    if (row === undefined) {
      throw new ResearchError('research/hypothesis-not-found', `Hypothesis "${hypothesisId}" not found`, { hypothesisId })
    }
    return mapHypothesis(row)
  }

  private requireDiscovery(discoveryId: DiscoveryId): ResearchDiscovery {
    const row = this.database.connection.prepare('SELECT * FROM research_discoveries WHERE id = ?').get(discoveryId)
    if (row === undefined) {
      throw new ResearchError('research/entity-not-found', `Discovery "${discoveryId}" not found`, { discoveryId })
    }
    return mapDiscovery(row)
  }

  private requireDecision(decisionId: DecisionId): ResearchDecision {
    const row = this.database.connection.prepare('SELECT * FROM research_decisions WHERE id = ?').get(decisionId)
    if (row === undefined) {
      throw new ResearchError('research/entity-not-found', `Decision "${decisionId}" not found`, { decisionId })
    }
    return mapDecision(row)
  }

  private requireArtifact(artifactId: ArtifactId): ResearchArtifact {
    const artifact = this.getArtifact(artifactId)
    if (artifact === undefined) {
      throw new ResearchError('research/artifact-not-found', `Artifact "${artifactId}" not found`, { artifactId })
    }
    return artifact
  }

  private requireSummary(summaryId: SessionSummaryId): SessionSummary {
    const row = this.database.connection.prepare('SELECT * FROM research_session_summaries WHERE id = ?').get(summaryId)
    if (row === undefined) {
      throw new ResearchError('research/entity-not-found', `Session summary "${summaryId}" not found`, { summaryId })
    }
    return mapSummary(row)
  }

  private timeline(
    ideaId: IdeaIdType,
    entityType: string,
    entityId: string,
    eventType: string,
    summary: string,
    provenance: Provenance,
    payload: Record<string, JsonValue>,
    now: number,
  ): void {
    this.database.connection.prepare(`
      INSERT INTO research_timeline_events (
        id, idea_id, session_id, event_type, entity_type, entity_id, summary, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(TimelineEventId(`tl_${randomUUID()}`), ideaId, provenance.originSessionId ?? null,
      eventType, entityType, entityId, summary, JSON.stringify(payload), now)
  }
}
