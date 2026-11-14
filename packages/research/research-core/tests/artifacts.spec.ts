import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it } from 'vitest'
import ResearchCore, {
  IdeaId,
  SourceId,
  type CreateClaimInput,
} from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

async function bench(): Promise<{ root: string; core: ResearchCore; ideaId: IdeaId; sessionId: SessionId }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-research-artifacts-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ResearchCore, { root })
  const core = ctx.researchCore
  const idea = core.createIdea({ title: 'Artifact Idea' })
  const sessionId = SessionId('session-artifacts')
  core.sessionBindings.createPendingSession({ sessionId, ideaId: idea.id })
  core.sessionBindings.markSessionActive(sessionId)
  return { root, core, ideaId: idea.id, sessionId }
}

const provenance = { originSessionId: 'session-artifacts', originToolCallId: 'call-1' }

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('research artifact store', () => {
  it('creates shared sources with locators and links them to Ideas', async () => {
    const { core, ideaId } = await bench()
    const source = core.artifacts.createSource(ideaId, {
      sourceType: 'paper',
      title: 'Bounded Activation',
      authors: ['Ada Lovelace'],
      year: 2026,
      doi: '10.1000/example',
      url: 'https://example.com/paper',
    }, provenance)
    expect(source).toMatchObject({ title: 'Bounded Activation', year: 2026, status: 'active' })
    const again = core.artifacts.createSource(ideaId, {
      sourceType: 'paper', title: 'Duplicate import', doi: '10.1000/example',
    })
    expect(again.id).toBe(source.id)
    expect(core.artifacts.listSources(ideaId)).toHaveLength(1)

    const location = core.artifacts.createSourceLocation(source.id, {
      locatorType: 'page', locator: 'p. 4', page: 4, quote: 'bounded activation reduces propagation',
    })
    expect(core.artifacts.listSourceLocations(source.id)).toEqual([location])
    expect(core.artifacts.listClaims(ideaId)).toEqual([])
  })

  it('requires sources for reported claims and keeps claim versions immutable', async () => {
    const { core, ideaId } = await bench()
    const source = core.artifacts.createSource(ideaId, { sourceType: 'paper', title: 'Source' })
    expect(() => core.artifacts.createClaim(ideaId, { statement: 'Uncited claim' })).toThrow(/requires at least one source/)
    const claim = core.artifacts.createClaim(ideaId, {
      statement: 'Clamping reduces propagation.',
      epistemicStatus: 'reported',
      confidence: 0.7,
      sourceIds: [source.id],
    }, provenance)
    expect(claim).toMatchObject({ epistemicStatus: 'reported', confidence: 0.7, version: 1 })
    expect(claim.origin).toEqual(provenance)
    expect(claim.sourceIds).toEqual([source.id])
    expect(core.artifacts.listClaimVersions(claim.id)).toHaveLength(1)

    const updated = core.artifacts.updateClaim(claim.id, {
      confidence: 0.8,
      status: 'disputed',
    }, 'review response', 'user')
    expect(updated).toMatchObject({ confidence: 0.8, status: 'disputed', version: 2 })
    const versions = core.artifacts.listClaimVersions(claim.id)
    expect(versions.map(version => version.version)).toEqual([2, 1])
    expect(versions[1]?.changeReason).toBe('created')
    expect(() => core.artifacts.updateClaim(claim.id, { confidence: 2 }, 'bad')).toThrow(/between 0 and 1/)
  })

  it('records evidence and validates both endpoints of knowledge relations', async () => {
    const { core, ideaId } = await bench()
    const source = core.artifacts.createSource(ideaId, { sourceType: 'paper', title: 'Source' })
    const location = core.artifacts.createSourceLocation(source.id, { locatorType: 'page', locator: 'p.1' })
    const claim = core.artifacts.createClaim(ideaId, {
      statement: 'Supported claim', sourceIds: [source.id],
    })
    expect(() => core.artifacts.createEvidence(ideaId, {
      sourceId: source.id, evidenceType: 'supports',
    })).toThrow(/requires a quote/)
    const evidence = core.artifacts.createEvidence(ideaId, {
      claimId: claim.id,
      sourceId: source.id,
      locationId: location.id,
      evidenceType: 'supports',
      quote: 'exact quoted text',
      strength: 0.9,
    }, provenance)
    expect(evidence).toMatchObject({ evidenceType: 'supports', strength: 0.9, claimId: claim.id })
    expect(core.artifacts.listEvidence(ideaId, claim.id)).toHaveLength(1)

    const relation = core.artifacts.createKnowledgeRelation(ideaId, {
      fromEntityType: 'evidence',
      fromEntityId: evidence.id,
      toEntityType: 'claim',
      toEntityId: claim.id,
      relationType: 'supports',
      confidence: 0.9,
    }, provenance)
    expect(core.artifacts.listKnowledgeRelations(ideaId, 'claim', claim.id)).toEqual([relation])
    const duplicate = core.artifacts.createKnowledgeRelation(ideaId, {
      fromEntityType: 'evidence', fromEntityId: evidence.id,
      toEntityType: 'claim', toEntityId: claim.id, relationType: 'supports',
    })
    expect(duplicate.id).toBe(relation.id)
    expect(() => core.artifacts.createKnowledgeRelation(ideaId, {
      fromEntityType: 'claim', fromEntityId: claim.id,
      toEntityType: 'claim', toEntityId: 'missing', relationType: 'extends',
    })).toThrow(/not found/)

    const otherIdea = core.createIdea({ title: 'Other' })
    expect(() => core.artifacts.createKnowledgeRelation(otherIdea.id, {
      fromEntityType: 'claim', fromEntityId: claim.id,
      toEntityType: 'evidence', toEntityId: evidence.id, relationType: 'extends',
    })).toThrow(/another Idea/)
  })

  it('creates questions, gaps, hypotheses, discoveries, decisions, and branches with versions', async () => {
    const { core, ideaId } = await bench()
    const branch = core.artifacts.createBranch(ideaId, { title: 'Main line' })
    const question = core.artifacts.createQuestion(ideaId, {
      question: 'Does clamping generalize?', priority: 2, branchId: branch.id,
    }, provenance)
    expect(question).toMatchObject({ priority: 2, status: 'open', version: 1 })
    expect(core.artifacts.updateQuestion(question.id, {
      status: 'investigating', answerSummary: 'Early results',
    })).toMatchObject({ status: 'investigating', version: 2 })

    const gap = core.artifacts.createGap(ideaId, {
      gapType: 'literature_gap', gapDescription: 'No cross-domain benchmark', uncertainty: 0.6,
    }, provenance)
    expect(gap).toMatchObject({ gapType: 'literature_gap', uncertainty: 0.6 })
    expect(core.artifacts.updateGap(gap.id, { status: 'reviewed' })).toMatchObject({ status: 'reviewed', version: 2 })

    const hypothesis = core.artifacts.createHypothesis(ideaId, {
      title: 'Clamping generalizes',
      description: 'Bounded activation remains stable across domains.',
      falsificationConditions: ['A domain shows unbounded propagation'],
    }, provenance)
    expect(hypothesis).toMatchObject({ status: 'candidate', currentVersion: 1 })
    const updated = core.artifacts.updateHypothesis(hypothesis.id, {
      status: 'under_review', assumptions: ['Linear regime'],
    }, 'review opened')
    expect(updated).toMatchObject({ status: 'under_review', currentVersion: 2 })
    expect(core.artifacts.listHypothesisVersions(hypothesis.id).map(version => version.version)).toEqual([2, 1])

    const source = core.artifacts.createSource(ideaId, { sourceType: 'paper', title: 'Evidence source' })
    const claim = core.artifacts.createClaim(ideaId, { statement: 'Observed', sourceIds: [source.id] })
    const evidence = core.artifacts.createEvidence(ideaId, {
      claimId: claim.id, sourceId: source.id, evidenceType: 'supports', quote: 'observed',
    })
    core.artifacts.linkHypothesisEvidence(hypothesis.id, evidence.id, 'supports', 'replicated')
    expect(core.artifacts.listHypothesisEvidence(hypothesis.id)).toHaveLength(1)

    const discovery = core.artifacts.createDiscovery(ideaId, {
      discoveryType: 'knowledge_bridge',
      description: 'Bridge two literatures',
      supportingEntityIds: [claim.id],
      scores: { novelty: 0.7, total: 0.7 },
    }, provenance)
    expect(discovery.scores).toMatchObject({ novelty: 0.7, total: 0.7 })
    expect(discovery.status).toBe('candidate')

    const decision = core.artifacts.createDecision(ideaId, {
      title: 'Adopt benchmark', decision: 'Use benchmark A', rationale: 'Comparable',
    }, provenance)
    expect(decision).toMatchObject({ title: 'Adopt benchmark', createdBy: 'tool' })
    expect(core.artifacts.listBranches(ideaId)).toHaveLength(1)
    expect(core.artifacts.countEntities(ideaId)).toMatchObject({
      concepts: 0, claims: 1, evidence: 1, questions: 1, gaps: 1, hypotheses: 1, discoveries: 1, decisions: 1, branches: 1,
    })
  })

  it('writes artifacts atomically, verifies their hash, and reports tampering', async () => {
    const { core, ideaId, root } = await bench()
    const artifact = core.artifacts.createArtifact(ideaId, {
      artifactType: 'markdown',
      title: 'Report',
      content: '# Findings\n\nBounded activation works.',
      mimeType: 'text/markdown',
    }, provenance)
    expect(artifact.status).toBe('ready')
    expect(artifact.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(artifact.path).toContain('artifacts/')
    const absolute = join(root, artifact.path as string)
    expect(readFileSync(absolute, 'utf8')).toContain('Bounded activation works.')
    expect(core.artifacts.verifyArtifact(artifact.id).valid).toBe(true)

    writeFileSync(absolute, 'tampered', 'utf8')
    const tampered = core.artifacts.verifyArtifact(artifact.id)
    expect(tampered.valid).toBe(false)
    expect(tampered.artifact.status).toBe('failed')
    expect(core.artifacts.listArtifacts(ideaId)).toHaveLength(1)

    const pending = core.artifacts.createArtifact(ideaId, {
      artifactType: 'markdown', title: 'Pending',
    })
    expect(pending.status).toBe('pending')
    expect(core.artifacts.verifyArtifact(pending.id).valid).toBe(false)
  })

  it('snapshots session summaries by event range and supersedes older versions', async () => {
    const { core, ideaId, sessionId } = await bench()
    const first = core.artifacts.recordSessionSummary({
      sessionId,
      ideaId,
      summary: 'First summary',
      eventStartSeq: 0,
      eventEndSeq: 4,
      inputHash: 'hash-1',
      promptVersion: 'v1',
    })
    expect(first).toMatchObject({ version: 1, status: 'candidate', ideaId })
    const second = core.artifacts.recordSessionSummary({
      sessionId,
      ideaId,
      summary: 'Revised summary',
      eventStartSeq: 0,
      eventEndSeq: 4,
      inputHash: 'hash-2',
      promptVersion: 'v1',
    })
    expect(second).toMatchObject({ version: 2, supersedesId: first.id })
    expect(core.artifacts.listSessionSummaries(sessionId).map(summary => summary.status).sort())
      .toEqual(['candidate', 'superseded'])
    expect(() => core.artifacts.recordSessionSummary({
      sessionId,
      summary: 'bad range',
      eventStartSeq: 5,
      eventEndSeq: 1,
      inputHash: 'hash-3',
      promptVersion: 'v1',
    })).toThrow(/inverted/)
  })

  it('validates provenance and Idea ownership at the service boundary', async () => {
    const { core, ideaId } = await bench()
    const other = core.createIdea({ title: 'Other' })
    expect(() => core.artifacts.createConcept(ideaId, { name: 'Concept' })).not.toThrow()
    expect(() => core.artifacts.createConcept(ideaId, { name: 'Concept' })).toThrow(/already exists/)
    expect(() => core.artifacts.listSources(IdeaId('missing'))).toThrow(/not found/)
    const source = core.artifacts.createSource(other.id, { sourceType: 'web', title: 'Other source' })
    expect(() => core.artifacts.createEvidence(ideaId, {
      sourceId: source.id, evidenceType: 'context', quote: 'context',
    })).not.toThrow()
    const claim = core.artifacts.createClaim(other.id, { statement: 'Other claim', sourceIds: [source.id] })
    expect(() => core.artifacts.createEvidence(ideaId, {
      claimId: claim.id, sourceId: source.id, evidenceType: 'supports', quote: 'q',
    })).toThrow(/another Idea/)
    const input: CreateClaimInput = { statement: 'Invalid', confidence: 1.5, sourceIds: [source.id] }
    expect(() => core.artifacts.createClaim(ideaId, input)).toThrow(/between 0 and 1/)
    expect(SourceId(source.id)).toBe(source.id)
  })
})
