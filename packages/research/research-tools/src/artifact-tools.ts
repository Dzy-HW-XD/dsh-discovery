/**
 * Model-facing Phase 3 tools. Each tool is scoped to a bound Research Session
 * and records the calling Session and tool-call id as provenance.
 * @module @deepseek-ai/dsh-research-tools/artifact-tools
 */

import { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import ResearchCore, {
  ARTIFACT_TYPES,
  DISCOVERY_TYPES,
  ENTITY_TYPES,
  EPISTEMIC_STATUSES,
  GAP_TYPES,
  KNOWLEDGE_RELATION_TYPES,
  LOCATOR_TYPES,
  ResearchError,
  SOURCE_TYPES,
  ArtifactId,
  BranchId,
  ClaimId,
  ConceptId,
  EvidenceId,
  GapId,
  HypothesisId,
  IdeaId,
  QuestionId,
  SourceId,
  SourceLocationId,
  type Provenance,
} from '@deepseek-ai/dsh-research-core'

type ToolResult = JsonValue

function jsonValue(value: unknown): ToolResult {
  return JSON.parse(JSON.stringify(value)) as ToolResult
}

function admitted<T extends string>(value: string, values: readonly T[], field: string): T {
  if (!(values as readonly string[]).includes(value)) {
    throw new ResearchError('research/invalid-input', `unknown ${field} "${value}"`, { field })
  }
  return value as T
}

function provenanceOf(exec: { agent?: { id: string }; callId: string }, sessionId: SessionId): Provenance {
  return {
    originSessionId: exec.agent?.id ?? sessionId,
    originToolCallId: exec.callId,
  }
}

function textOutput(value: ToolResult) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/**
 * Build every Phase 3 artifact tool for one Research Session.
 * @param core - research core service.
 * @param sessionId - Session that owns the scoped tools.
 * @returns tool definitions ready for `ctx.tools.register`.
 */
export function researchArtifactTools(core: ResearchCore, sessionId: SessionId) {
  const store = core.artifacts
  const identity = (args: { ideaId: string }) => IdeaId(args.ideaId)

  return [
    defineTool({
      name: 'research_source',
      description:
        'Import or list research Sources and their locators. Sources are shared across Ideas; import links one to the current Idea. '
        + 'A reported claim must cite a Source id returned here.',
      parameters: {
        action: { type: 'string', required: true, enum: ['import', 'list', 'locate', 'locations'] },
        ideaId: { type: 'string', required: true, description: 'Owning Idea id.' },
        title: { type: 'string', description: 'Source title for import.' },
        sourceType: { type: 'string', description: `One of: ${SOURCE_TYPES.join(', ')}.` },
        authors: { type: 'array', items: { type: 'string' }, description: 'Author names.' },
        year: { type: 'integer', description: 'Publication year.' },
        venue: { type: 'string', description: 'Venue or publisher.' },
        doi: { type: 'string', description: 'DOI; reused when the same DOI is imported again.' },
        arxivId: { type: 'string', description: 'arXiv id.' },
        url: { type: 'string', description: 'Source URL.' },
        abstract: { type: 'string', description: 'Abstract or summary.' },
        relevance: { type: 'string', description: 'primary, cited, context, or rejected.' },
        sourceId: { type: 'string', description: 'Source id for locate/locations.' },
        locatorType: { type: 'string', description: `One of: ${LOCATOR_TYPES.join(', ')}.` },
        locator: { type: 'string', description: 'Page, section, or other stable locator.' },
        quote: { type: 'string', description: 'Quoted text at the locator.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textOutput(value) },
      async execute(args, exec) {
        await Promise.resolve()
        exec.signal.throwIfAborted()
        switch (args.action) {
          case 'import': {
            if (args.title === undefined || args.sourceType === undefined) {
              throw new ResearchError('research/invalid-input', 'import requires title and sourceType', {})
            }
            return jsonValue(store.createSource(identity(args), {
              title: args.title,
              sourceType: admitted(args.sourceType, SOURCE_TYPES, 'sourceType'),
              ...args.authors === undefined ? {} : { authors: args.authors },
              ...args.year === undefined ? {} : { year: args.year },
              ...args.venue === undefined ? {} : { venue: args.venue },
              ...args.doi === undefined ? {} : { doi: args.doi },
              ...args.arxivId === undefined ? {} : { arxivId: args.arxivId },
              ...args.url === undefined ? {} : { url: args.url },
              ...args.abstract === undefined ? {} : { abstract: args.abstract },
              ...args.relevance === undefined ? {} : { relevance: args.relevance as 'primary' | 'cited' | 'context' | 'rejected' },
            }, provenanceOf(exec, sessionId)))
          }
          case 'list': return jsonValue({ sources: store.listSources(identity(args)) })
          case 'locate': {
            if (args.sourceId === undefined || args.locatorType === undefined || args.locator === undefined) {
              throw new ResearchError('research/invalid-input', 'locate requires sourceId, locatorType, and locator', {})
            }
            return jsonValue(store.createSourceLocation(SourceId(args.sourceId), {
              locatorType: admitted(args.locatorType, LOCATOR_TYPES, 'locatorType'),
              locator: args.locator,
              ...args.quote === undefined ? {} : { quote: args.quote },
            }))
          }
          case 'locations': {
            if (args.sourceId === undefined) {
              throw new ResearchError('research/invalid-input', 'locations requires sourceId', {})
            }
            return jsonValue({ locations: store.listSourceLocations(SourceId(args.sourceId)) })
          }
          default:
            throw new ResearchError('research/invalid-input', 'unknown research_source action', { action: String(args.action) })
        }
      },
    }),

    defineTool({
      name: 'research_concept',
      description: 'Create or list Concepts for an Idea. Concepts are Idea-scoped vocabulary; aliases and a parent Concept are optional.',
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'list'] },
        ideaId: { type: 'string', required: true, description: 'Owning Idea id.' },
        name: { type: 'string', description: 'Concept name.' },
        definition: { type: 'string', description: 'Concept definition.' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'Alternative names.' },
        parentConceptId: { type: 'string', description: 'Optional parent Concept id.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textOutput(value) },
      async execute(args, exec) {
        await Promise.resolve()
        exec.signal.throwIfAborted()
        if (args.action === 'list') return jsonValue({ concepts: store.listConcepts(identity(args)) })
        if (args.name === undefined) throw new ResearchError('research/invalid-input', 'create requires name', {})
        return jsonValue(store.createConcept(identity(args), {
          name: args.name,
          ...args.definition === undefined ? {} : { definition: args.definition },
          ...args.aliases === undefined ? {} : { aliases: args.aliases },
          ...args.parentConceptId === undefined ? {} : { parentConceptId: ConceptId(args.parentConceptId) },
        }))
      },
    }),

    defineTool({
      name: 'research_claim',
      description:
        'Create, update, inspect, or list Claims. Every Claim carries provenance and a content hash; updates append an immutable version. '
        + 'Use epistemicStatus=reported only with a real Source citation.',
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'update', 'get', 'list', 'versions'] },
        ideaId: { type: 'string', required: true, description: 'Owning Idea id.' },
        claimId: { type: 'string', description: 'Claim id for update/get/versions.' },
        statement: { type: 'string', description: 'Claim statement.' },
        epistemicStatus: { type: 'string', description: `One of: ${EPISTEMIC_STATUSES.join(', ')}.` },
        confidence: { type: 'number', description: 'Confidence from 0 to 1.' },
        sourceIds: { type: 'array', items: { type: 'string' }, description: 'Supporting Source ids.' },
        status: { type: 'string', description: 'active, disputed, rejected, superseded, or archived.' },
        reason: { type: 'string', description: 'Required change reason for update.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textOutput(value) },
      async execute(args, exec) {
        await Promise.resolve()
        exec.signal.throwIfAborted()
        const ideaId = identity(args)
        switch (args.action) {
          case 'create': {
            if (args.statement === undefined) {
              throw new ResearchError('research/invalid-input', 'create requires statement', {})
            }
            return jsonValue(store.createClaim(ideaId, {
              statement: args.statement,
              ...args.epistemicStatus === undefined ? {} : { epistemicStatus: admitted(args.epistemicStatus, EPISTEMIC_STATUSES, 'epistemicStatus') },
              ...args.confidence === undefined ? {} : { confidence: args.confidence },
              ...args.sourceIds === undefined ? {} : { sourceIds: args.sourceIds.map(SourceId) },
            }, provenanceOf(exec, sessionId)))
          }
          case 'update': {
            if (args.claimId === undefined || args.reason === undefined) {
              throw new ResearchError('research/invalid-input', 'update requires claimId and reason', {})
            }
            return jsonValue(store.updateClaim(ClaimId(args.claimId), {
              ...args.statement === undefined ? {} : { statement: args.statement },
              ...args.epistemicStatus === undefined ? {} : { epistemicStatus: admitted(args.epistemicStatus, EPISTEMIC_STATUSES, 'epistemicStatus') },
              ...args.confidence === undefined ? {} : { confidence: args.confidence },
              ...args.status === undefined ? {} : { status: args.status as 'active' | 'disputed' | 'rejected' | 'superseded' | 'archived' },
            }, args.reason))
          }
          case 'get': {
            if (args.claimId === undefined) throw new ResearchError('research/invalid-input', 'get requires claimId', {})
            return jsonValue({ claim: store.getClaim(ClaimId(args.claimId)) ?? null })
          }
          case 'list': return jsonValue({ claims: store.listClaims(ideaId) })
          case 'versions': {
            if (args.claimId === undefined) throw new ResearchError('research/invalid-input', 'versions requires claimId', {})
            return jsonValue({ versions: store.listClaimVersions(ClaimId(args.claimId)) })
          }
          default: throw new ResearchError('research/invalid-input', 'unknown research_claim action', { action: String(args.action) })
        }
      },
    }),

    defineTool({
      name: 'research_evidence',
      description:
        'Create or list Evidence tied to a Source and optional Claim. Reported evidence must quote the Source. '
        + 'Evidence direction is supports, refutes, context, or contradicts.',
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'list'] },
        ideaId: { type: 'string', required: true, description: 'Owning Idea id.' },
        sourceId: { type: 'string', description: 'Source id for create.' },
        claimId: { type: 'string', description: 'Optional Claim id.' },
        locationId: { type: 'string', description: 'Optional Source locator id.' },
        evidenceType: { type: 'string', description: 'supports, refutes, context, or contradicts.' },
        strength: { type: 'number', description: 'Strength from 0 to 1.' },
        quote: { type: 'string', description: 'Quoted Source text.' },
        notes: { type: 'string', description: 'Analyst notes.' },
        epistemicStatus: { type: 'string', description: `One of: ${EPISTEMIC_STATUSES.join(', ')}.` },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textOutput(value) },
      async execute(args, exec) {
        await Promise.resolve()
        exec.signal.throwIfAborted()
        if (args.action === 'list') {
          return jsonValue({ evidence: store.listEvidence(identity(args), args.claimId === undefined ? undefined : ClaimId(args.claimId)) })
        }
        if (args.sourceId === undefined || args.evidenceType === undefined) {
          throw new ResearchError('research/invalid-input', 'create requires sourceId and evidenceType', {})
        }
        return jsonValue(store.createEvidence(identity(args), {
          sourceId: SourceId(args.sourceId),
          evidenceType: args.evidenceType as 'supports' | 'refutes' | 'context' | 'contradicts',
          ...args.claimId === undefined ? {} : { claimId: ClaimId(args.claimId) },
          ...args.locationId === undefined ? {} : { locationId: SourceLocationId(args.locationId) },
          ...args.strength === undefined ? {} : { strength: args.strength },
          ...args.quote === undefined ? {} : { quote: args.quote },
          ...args.notes === undefined ? {} : { notes: args.notes },
          ...args.epistemicStatus === undefined ? {} : { epistemicStatus: admitted(args.epistemicStatus, EPISTEMIC_STATUSES, 'epistemicStatus') },
        }, provenanceOf(exec, sessionId)))
      },
    }),

    defineTool({
      name: 'research_graph',
      description:
        'Query Phase 3 entities and knowledge relations for one Idea, or create a relation between two existing entities. '
        + 'Entity types: ' + ENTITY_TYPES.join(', ') + '.',
      parameters: {
        action: { type: 'string', required: true, enum: ['entities', 'relations', 'relate'] },
        ideaId: { type: 'string', required: true, description: 'Owning Idea id.' },
        entityType: { type: 'string', description: 'Optional entity kind filter.' },
        entityId: { type: 'string', description: 'Optional entity id filter.' },
        fromEntityType: { type: 'string', description: 'Relation source kind.' },
        fromEntityId: { type: 'string', description: 'Relation source id.' },
        toEntityType: { type: 'string', description: 'Relation target kind.' },
        toEntityId: { type: 'string', description: 'Relation target id.' },
        relationType: { type: 'string', description: `One of: ${KNOWLEDGE_RELATION_TYPES.join(', ')}.` },
        confidence: { type: 'number', description: 'Confidence from 0 to 1.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textOutput(value) },
      async execute(args, exec) {
        await Promise.resolve()
        exec.signal.throwIfAborted()
        const ideaId = identity(args)
        switch (args.action) {
          case 'entities': {
            const lists = {
              concepts: store.listConcepts(ideaId).map(item => ({ id: item.id, name: item.name })),
              claims: store.listClaims(ideaId).map(item => ({ id: item.id, statement: item.statement })),
              evidence: store.listEvidence(ideaId).map(item => ({ id: item.id, evidenceType: item.evidenceType })),
              questions: store.listQuestions(ideaId).map(item => ({ id: item.id, question: item.question })),
              gaps: store.listGaps(ideaId).map(item => ({ id: item.id, gapDescription: item.gapDescription })),
              hypotheses: store.listHypotheses(ideaId).map(item => ({ id: item.id, title: item.title })),
              discoveries: store.listDiscoveries(ideaId).map(item => ({ id: item.id, description: item.description })),
              artifacts: store.listArtifacts(ideaId).map(item => ({ id: item.id, title: item.title, status: item.status })),
            }
            return jsonValue({ counts: store.countEntities(ideaId), entities: lists })
          }
          case 'relations':
            return jsonValue({
              relations: store.listKnowledgeRelations(
                ideaId,
                args.entityType === undefined ? undefined : admitted(args.entityType, ENTITY_TYPES, 'entityType'),
                args.entityId,
              ),
            })
          case 'relate': {
            if (args.fromEntityType === undefined || args.fromEntityId === undefined
              || args.toEntityType === undefined || args.toEntityId === undefined || args.relationType === undefined) {
              throw new ResearchError('research/invalid-input', 'relate requires both endpoints and relationType', {})
            }
            return jsonValue(store.createKnowledgeRelation(ideaId, {
              fromEntityType: admitted(args.fromEntityType, ENTITY_TYPES, 'fromEntityType'),
              fromEntityId: args.fromEntityId,
              toEntityType: admitted(args.toEntityType, ENTITY_TYPES, 'toEntityType'),
              toEntityId: args.toEntityId,
              relationType: admitted(args.relationType, KNOWLEDGE_RELATION_TYPES, 'relationType'),
              ...args.confidence === undefined ? {} : { confidence: args.confidence },
            }, provenanceOf(exec, sessionId)))
          }
          default: throw new ResearchError('research/invalid-input', 'unknown research_graph action', { action: String(args.action) })
        }
      },
    }),

    defineTool({
      name: 'research_question',
      description: 'Create, update, or list Research Questions for an Idea.',
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'update', 'list'] },
        ideaId: { type: 'string', required: true, description: 'Owning Idea id.' },
        questionId: { type: 'string', description: 'Question id for update.' },
        question: { type: 'string', description: 'Question text.' },
        motivation: { type: 'string', description: 'Why the question matters.' },
        priority: { type: 'integer', description: 'Priority 1 to 5.' },
        status: { type: 'string', description: 'open, investigating, answered, deferred, or rejected.' },
        answerSummary: { type: 'string', description: 'Current answer summary.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textOutput(value) },
      async execute(args, exec) {
        await Promise.resolve()
        exec.signal.throwIfAborted()
        const ideaId = identity(args)
        switch (args.action) {
          case 'create': {
            if (args.question === undefined) throw new ResearchError('research/invalid-input', 'create requires question', {})
            return jsonValue(store.createQuestion(ideaId, {
              question: args.question,
              ...args.motivation === undefined ? {} : { motivation: args.motivation },
              ...args.priority === undefined ? {} : { priority: args.priority },
            }, provenanceOf(exec, sessionId)))
          }
          case 'update': {
            if (args.questionId === undefined) throw new ResearchError('research/invalid-input', 'update requires questionId', {})
            return jsonValue(store.updateQuestion(QuestionId(args.questionId), {
              ...args.question === undefined ? {} : { question: args.question },
              ...args.motivation === undefined ? {} : { motivation: args.motivation },
              ...args.priority === undefined ? {} : { priority: args.priority },
              ...args.status === undefined ? {} : { status: args.status as 'open' | 'investigating' | 'answered' | 'deferred' | 'rejected' },
              ...args.answerSummary === undefined ? {} : { answerSummary: args.answerSummary },
            }))
          }
          case 'list': return jsonValue({ questions: store.listQuestions(ideaId) })
          default: throw new ResearchError('research/invalid-input', 'unknown research_question action', { action: String(args.action) })
        }
      },
    }),

    defineTool({
      name: 'research_gap',
      description: 'Create, update, or list Research Gaps. Gaps start as candidates and require review before acceptance.',
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'update', 'list'] },
        ideaId: { type: 'string', required: true, description: 'Owning Idea id.' },
        gapId: { type: 'string', description: 'Gap id for update.' },
        gapType: { type: 'string', description: `One of: ${GAP_TYPES.join(', ')}.` },
        gapDescription: { type: 'string', description: 'What is missing.' },
        relatedWork: { type: 'string', description: 'Related work.' },
        missingConnection: { type: 'string', description: 'Missing connection.' },
        evidence: { type: 'string', description: 'Supporting evidence summary.' },
        noveltyAssessment: { type: 'string', description: 'Novelty assessment.' },
        uncertainty: { type: 'number', description: 'Uncertainty from 0 to 1.' },
        status: { type: 'string', description: 'candidate, reviewed, accepted, rejected, or superseded.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textOutput(value) },
      async execute(args, exec) {
        await Promise.resolve()
        exec.signal.throwIfAborted()
        const ideaId = identity(args)
        switch (args.action) {
          case 'create': {
            if (args.gapType === undefined || args.gapDescription === undefined) {
              throw new ResearchError('research/invalid-input', 'create requires gapType and gapDescription', {})
            }
            return jsonValue(store.createGap(ideaId, {
              gapType: admitted(args.gapType, GAP_TYPES, 'gapType'),
              gapDescription: args.gapDescription,
              ...args.relatedWork === undefined ? {} : { relatedWork: args.relatedWork },
              ...args.missingConnection === undefined ? {} : { missingConnection: args.missingConnection },
              ...args.evidence === undefined ? {} : { evidence: args.evidence },
              ...args.noveltyAssessment === undefined ? {} : { noveltyAssessment: args.noveltyAssessment },
              ...args.uncertainty === undefined ? {} : { uncertainty: args.uncertainty },
            }, provenanceOf(exec, sessionId)))
          }
          case 'update': {
            if (args.gapId === undefined) throw new ResearchError('research/invalid-input', 'update requires gapId', {})
            return jsonValue(store.updateGap(GapId(args.gapId), {
              ...args.gapDescription === undefined ? {} : { gapDescription: args.gapDescription },
              ...args.relatedWork === undefined ? {} : { relatedWork: args.relatedWork },
              ...args.missingConnection === undefined ? {} : { missingConnection: args.missingConnection },
              ...args.evidence === undefined ? {} : { evidence: args.evidence },
              ...args.noveltyAssessment === undefined ? {} : { noveltyAssessment: args.noveltyAssessment },
              ...args.uncertainty === undefined ? {} : { uncertainty: args.uncertainty },
              ...args.status === undefined ? {} : { status: args.status as 'candidate' | 'reviewed' | 'accepted' | 'rejected' | 'superseded' },
            }))
          }
          case 'list': return jsonValue({ gaps: store.listGaps(ideaId) })
          default: throw new ResearchError('research/invalid-input', 'unknown research_gap action', { action: String(args.action) })
        }
      },
    }),

    defineTool({
      name: 'research_hypothesis',
      description:
        'Create, update, inspect, or list Hypotheses. Every update appends an immutable version. '
        + 'Link Evidence to record supports/refutes/context.',
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'update', 'get', 'list', 'versions', 'link_evidence'] },
        ideaId: { type: 'string', required: true, description: 'Owning Idea id.' },
        hypothesisId: { type: 'string', description: 'Hypothesis id.' },
        title: { type: 'string', description: 'Hypothesis title.' },
        description: { type: 'string', description: 'Hypothesis description.' },
        theoreticalReasoning: { type: 'string', description: 'Theoretical reasoning.' },
        assumptions: { type: 'array', items: { type: 'string' }, description: 'Assumptions.' },
        boundaryConditions: { type: 'array', items: { type: 'string' }, description: 'Boundary conditions.' },
        alternativeExplanations: { type: 'array', items: { type: 'string' }, description: 'Alternative explanations.' },
        falsificationConditions: { type: 'array', items: { type: 'string' }, description: 'Falsification conditions.' },
        status: { type: 'string', description: 'candidate, under_review, supported, disputed, rejected, or superseded.' },
        reason: { type: 'string', description: 'Required change reason for update.' },
        evidenceId: { type: 'string', description: 'Evidence id for link_evidence.' },
        relation: { type: 'string', description: 'supports, refutes, or context.' },
        note: { type: 'string', description: 'Link note.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textOutput(value) },
      async execute(args, exec) {
        await Promise.resolve()
        exec.signal.throwIfAborted()
        const ideaId = identity(args)
        switch (args.action) {
          case 'create': {
            if (args.title === undefined || args.description === undefined) {
              throw new ResearchError('research/invalid-input', 'create requires title and description', {})
            }
            return jsonValue(store.createHypothesis(ideaId, {
              title: args.title,
              description: args.description,
              ...args.theoreticalReasoning === undefined ? {} : { theoreticalReasoning: args.theoreticalReasoning },
              ...args.assumptions === undefined ? {} : { assumptions: args.assumptions },
              ...args.boundaryConditions === undefined ? {} : { boundaryConditions: args.boundaryConditions },
              ...args.alternativeExplanations === undefined ? {} : { alternativeExplanations: args.alternativeExplanations },
              ...args.falsificationConditions === undefined ? {} : { falsificationConditions: args.falsificationConditions },
            }, provenanceOf(exec, sessionId)))
          }
          case 'update': {
            if (args.hypothesisId === undefined || args.reason === undefined) {
              throw new ResearchError('research/invalid-input', 'update requires hypothesisId and reason', {})
            }
            return jsonValue(store.updateHypothesis(HypothesisId(args.hypothesisId), {
              ...args.title === undefined ? {} : { title: args.title },
              ...args.description === undefined ? {} : { description: args.description },
              ...args.theoreticalReasoning === undefined ? {} : { theoreticalReasoning: args.theoreticalReasoning },
              ...args.assumptions === undefined ? {} : { assumptions: args.assumptions },
              ...args.boundaryConditions === undefined ? {} : { boundaryConditions: args.boundaryConditions },
              ...args.alternativeExplanations === undefined ? {} : { alternativeExplanations: args.alternativeExplanations },
              ...args.falsificationConditions === undefined ? {} : { falsificationConditions: args.falsificationConditions },
              ...args.status === undefined ? {} : { status: args.status as 'candidate' | 'under_review' | 'supported' | 'disputed' | 'rejected' | 'superseded' },
            }, args.reason))
          }
          case 'get': {
            if (args.hypothesisId === undefined) throw new ResearchError('research/invalid-input', 'get requires hypothesisId', {})
            return jsonValue({
              hypothesis: store.listHypotheses(ideaId).find(item => item.id === args.hypothesisId) ?? null,
              evidence: store.listHypothesisEvidence(HypothesisId(args.hypothesisId)),
            })
          }
          case 'list': return jsonValue({ hypotheses: store.listHypotheses(ideaId) })
          case 'versions': {
            if (args.hypothesisId === undefined) throw new ResearchError('research/invalid-input', 'versions requires hypothesisId', {})
            return jsonValue({ versions: store.listHypothesisVersions(HypothesisId(args.hypothesisId)) })
          }
          case 'link_evidence': {
            if (args.hypothesisId === undefined || args.evidenceId === undefined || args.relation === undefined) {
              throw new ResearchError('research/invalid-input', 'link_evidence requires hypothesisId, evidenceId, and relation', {})
            }
            store.linkHypothesisEvidence(HypothesisId(args.hypothesisId), EvidenceId(args.evidenceId),
              args.relation as 'supports' | 'refutes' | 'context', args.note ?? '')
            return jsonValue({ linked: true })
          }
          default: throw new ResearchError('research/invalid-input', 'unknown research_hypothesis action', { action: String(args.action) })
        }
      },
    }),

    defineTool({
      name: 'research_discovery',
      description: 'Create or list Discoveries. A Discovery is a candidate until reviewed; scores are optional.',
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'list'] },
        ideaId: { type: 'string', required: true, description: 'Owning Idea id.' },
        discoveryType: { type: 'string', description: `One of: ${DISCOVERY_TYPES.join(', ')}.` },
        description: { type: 'string', description: 'Discovery description.' },
        reasoningChain: { type: 'string', description: 'Reasoning chain.' },
        supportingEntityIds: { type: 'array', items: { type: 'string' }, description: 'Supporting entity ids.' },
        contradictingEntityIds: { type: 'array', items: { type: 'string' }, description: 'Contradicting entity ids.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textOutput(value) },
      async execute(args, exec) {
        await Promise.resolve()
        exec.signal.throwIfAborted()
        if (args.action === 'list') return jsonValue({ discoveries: store.listDiscoveries(identity(args)) })
        if (args.discoveryType === undefined || args.description === undefined) {
          throw new ResearchError('research/invalid-input', 'create requires discoveryType and description', {})
        }
        return jsonValue(store.createDiscovery(identity(args), {
          discoveryType: admitted(args.discoveryType, DISCOVERY_TYPES, 'discoveryType'),
          description: args.description,
          ...args.reasoningChain === undefined ? {} : { reasoningChain: args.reasoningChain },
          ...args.supportingEntityIds === undefined ? {} : { supportingEntityIds: args.supportingEntityIds },
          ...args.contradictingEntityIds === undefined ? {} : { contradictingEntityIds: args.contradictingEntityIds },
        }, provenanceOf(exec, sessionId)))
      },
    }),

    defineTool({
      name: 'research_artifact',
      description:
        'Create, inspect, verify, or list stored Artifacts. Content is written atomically and hashed; the database row is authoritative.',
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'get', 'verify', 'list'] },
        ideaId: { type: 'string', required: true, description: 'Owning Idea id.' },
        artifactId: { type: 'string', description: 'Artifact id for get/verify.' },
        artifactType: { type: 'string', description: `One of: ${ARTIFACT_TYPES.join(', ')}.` },
        title: { type: 'string', description: 'Artifact title.' },
        content: { type: 'string', description: 'Text content to persist.' },
        mimeType: { type: 'string', description: 'MIME type, e.g. text/markdown.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textOutput(value) },
      async execute(args, exec) {
        await Promise.resolve()
        exec.signal.throwIfAborted()
        const ideaId = identity(args)
        switch (args.action) {
          case 'create': {
            if (args.artifactType === undefined || args.title === undefined) {
              throw new ResearchError('research/invalid-input', 'create requires artifactType and title', {})
            }
            return jsonValue(store.createArtifact(ideaId, {
              artifactType: admitted(args.artifactType, ARTIFACT_TYPES, 'artifactType'),
              title: args.title,
              ...args.content === undefined ? {} : { content: args.content },
              ...args.mimeType === undefined ? {} : { mimeType: args.mimeType },
            }, provenanceOf(exec, sessionId)))
          }
          case 'get': {
            if (args.artifactId === undefined) throw new ResearchError('research/invalid-input', 'get requires artifactId', {})
            return jsonValue({ artifact: store.getArtifact(ArtifactId(args.artifactId)) ?? null })
          }
          case 'verify': {
            if (args.artifactId === undefined) throw new ResearchError('research/invalid-input', 'verify requires artifactId', {})
            return jsonValue(store.verifyArtifact(ArtifactId(args.artifactId)))
          }
          case 'list': return jsonValue({ artifacts: store.listArtifacts(ideaId) })
          default: throw new ResearchError('research/invalid-input', 'unknown research_artifact action', { action: String(args.action) })
        }
      },
    }),

    defineTool({
      name: 'research_branch',
      description: 'Create, update, or list research branches inside one Idea.',
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'update', 'list'] },
        ideaId: { type: 'string', required: true, description: 'Owning Idea id.' },
        branchId: { type: 'string', description: 'Branch id for update.' },
        title: { type: 'string', description: 'Branch title.' },
        description: { type: 'string', description: 'Branch description.' },
        parentBranchId: { type: 'string', description: 'Optional parent branch.' },
        status: { type: 'string', description: 'active, paused, merged, split, rejected, or promoted_to_idea.' },
        mergedIntoId: { type: 'string', description: 'Target branch when merging.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textOutput(value) },
      async execute(args, exec) {
        await Promise.resolve()
        exec.signal.throwIfAborted()
        const ideaId = identity(args)
        switch (args.action) {
          case 'create': {
            if (args.title === undefined) throw new ResearchError('research/invalid-input', 'create requires title', {})
            return jsonValue(store.createBranch(ideaId, {
              title: args.title,
              ...args.description === undefined ? {} : { description: args.description },
              ...args.parentBranchId === undefined ? {} : { parentBranchId: BranchId(args.parentBranchId) },
            }))
          }
          case 'update': {
            if (args.branchId === undefined) throw new ResearchError('research/invalid-input', 'update requires branchId', {})
            return jsonValue(store.updateBranch(BranchId(args.branchId), {
              ...args.title === undefined ? {} : { title: args.title },
              ...args.description === undefined ? {} : { description: args.description },
              ...args.status === undefined ? {} : { status: args.status as 'active' | 'paused' | 'merged' | 'split' | 'rejected' | 'promoted_to_idea' },
              ...args.mergedIntoId === undefined ? {} : { mergedIntoId: BranchId(args.mergedIntoId) },
            }))
          }
          case 'list': return jsonValue({ branches: store.listBranches(ideaId) })
          default: throw new ResearchError('research/invalid-input', 'unknown research_branch action', { action: String(args.action) })
        }
      },
    }),

    defineTool({
      name: 'research_decision',
      description: 'Record or list research Decisions with rationale, alternatives, and consequences.',
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'list'] },
        ideaId: { type: 'string', required: true, description: 'Owning Idea id.' },
        title: { type: 'string', description: 'Decision title.' },
        decision: { type: 'string', description: 'What was decided.' },
        rationale: { type: 'string', description: 'Why.' },
        alternatives: { type: 'array', items: { type: 'string' }, description: 'Rejected alternatives.' },
        consequences: { type: 'string', description: 'Expected consequences.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textOutput(value) },
      async execute(args, exec) {
        await Promise.resolve()
        exec.signal.throwIfAborted()
        if (args.action === 'list') return jsonValue({ decisions: store.listDecisions(identity(args)) })
        if (args.title === undefined || args.decision === undefined) {
          throw new ResearchError('research/invalid-input', 'create requires title and decision', {})
        }
        return jsonValue(store.createDecision(identity(args), {
          title: args.title,
          decision: args.decision,
          ...args.rationale === undefined ? {} : { rationale: args.rationale },
          ...args.alternatives === undefined ? {} : { alternatives: args.alternatives },
          ...args.consequences === undefined ? {} : { consequences: args.consequences },
        }, provenanceOf(exec, sessionId)))
      },
    }),
  ]
}
