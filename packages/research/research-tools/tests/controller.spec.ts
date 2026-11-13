import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ResearchCore from '@deepseek-ai/dsh-research-core'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import ResearchController from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

async function bench(): Promise<Context> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-research-controller-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ResearchCore, { root })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ResearchController)
  return ctx
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('research Remote controller', () => {
  it('returns wire views for Idea CRUD and timeline', async () => {
    const ctx = await bench()
    const created = ctx.researchController.createIdea({ title: 'Wire Idea', researchQuestion: 'Q?' })
    expect(created).toMatchObject({ title: 'Wire Idea', researchQuestion: 'Q?', version: 1 })
    expect(ctx.researchController.getIdea({ ideaId: created.id })).toMatchObject({ id: created.id })
    expect(ctx.researchController.listIdeas({})).toHaveLength(1)
    const updated = ctx.researchController.updateIdea({
      ideaId: created.id,
      expectedVersion: created.version,
      status: 'exploring',
      currentSummary: 'wire summary',
    })
    expect(updated.status).toBe('exploring')
    const archived = ctx.researchController.archiveIdea({
      ideaId: created.id,
      expectedVersion: updated.version,
      reason: 'done',
    })
    expect(archived.status).toBe('archived')
    expect(ctx.researchController.listIdeas({})).toEqual([])
    expect(ctx.researchController.listTimeline({ ideaId: created.id })).not.toHaveLength(0)
  })

  it('maps domain failures to the declared Remote failure vocabulary', async () => {
    const ctx = await bench()
    const created = ctx.researchController.createIdea({ title: 'Conflict' })
    const failure = (() => {
      try {
        ctx.researchController.updateIdea({ ideaId: created.id, expectedVersion: 99, title: 'stale' })
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'research/version-conflict',
      details: { ideaId: created.id, actualVersion: 1 },
    })
  })

  it('returns directed relation views and preserves supersession history', async () => {
    const ctx = await bench()
    const a = ctx.researchController.createIdea({ title: 'A' })
    const b = ctx.researchController.createIdea({ title: 'B' })
    const relation = ctx.researchController.addIdeaRelation({
      fromIdeaId: b.id,
      toIdeaId: a.id,
      relationType: 'related_to',
    })
    expect(relation.fromIdeaId < relation.toIdeaId).toBe(true)
    expect(ctx.researchController.listIdeaRelations({ ideaId: a.id })).toHaveLength(1)
    const removed = ctx.researchController.removeIdeaRelation({ relationId: relation.id })
    expect(removed.status).toBe('superseded')
    expect(ctx.researchController.listIdeaRelations({ ideaId: a.id })[0]?.status).toBe('superseded')
  })
})
