import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import ResearchCore from '../src/index.ts'
import type { ResearchChangedEvent } from '../src/types.ts'

const roots: string[] = []
const contexts: Context[] = []

async function bench(): Promise<{ ctx: Context; core: ResearchCore; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-research-service-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ResearchCore, { root })
  return { ctx, core: ctx.researchCore, root }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('research core plugin', () => {
  it('emits a versioned research/changed envelope after each committed mutation', async () => {
    const { ctx, core } = await bench()
    const events: ResearchChangedEvent[] = []
    ctx.on('research/changed', (event) => { events.push(event) })

    const a = core.createIdea({ title: 'A' })
    const b = core.createIdea({ title: 'B', parentIdeaId: a.id })
    const updated = core.updateIdea(b.id, { status: 'exploring' }, b.version)
    const relation = core.addIdeaRelation({ fromIdeaId: a.id, toIdeaId: b.id, relationType: 'related_to' })
    core.removeIdeaRelation(relation.id)
    core.archiveIdea(updated.id, updated.version, 'closed')

    expect(events.map(event => event.kind)).toEqual([
      'idea.created',
      'idea.created',
      'idea.updated',
      'idea.relation-added',
      'idea.relation-added',
      'idea.relation-removed',
      'idea.relation-removed',
      'idea.archived',
    ])
    expect(events.every(event => event.schemaVersion === 1)).toBe(true)
    expect(events[0]).toMatchObject({ kind: 'idea.created', ideaId: a.id })
  })

  it('contains a throwing listener without rolling back the committed mutation', async () => {
    const { ctx, core } = await bench()
    ctx.on('research/changed', () => { throw new Error('observer failed') })
    const idea = core.createIdea({ title: 'Survives' })
    expect(core.getIdea(idea.id)).toMatchObject({ title: 'Survives' })
    expect(core.listTimeline(idea.id).map(event => event.eventType)).toContain('idea.created')
  })
})
