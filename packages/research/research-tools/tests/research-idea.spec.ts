import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ResearchCore from '@deepseek-ai/dsh-research-core'
import { afterEach, describe, expect, it } from 'vitest'
import ResearchController from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

async function bench(): Promise<Context> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-research-tools-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(ResearchCore, { root })
  await ctx.plugin(ResearchController)
  return ctx
}

let calls = 0
function call(ctx: Context, args: unknown) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`research-call-${++calls}`),
    name: 'research_idea',
    arguments: args,
  })
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('research_idea tool', () => {
  it('creates, lists, gets, updates, and archives a persistent Idea', async () => {
    const ctx = await bench()
    const created = await call(ctx, {
      action: 'create',
      title: 'Bounded Activation',
      researchQuestion: 'Does clamping reduce SDC propagation?',
    })
    expect(created.isError).toBe(false)
    if (created.isError) throw new Error('create failed')
    const createdIdea = created.value as { idea: { id: string; version: number; title: string } }
    expect(createdIdea.idea.title).toBe('Bounded Activation')

    const listed = await call(ctx, { action: 'list' })
    if (listed.isError) throw new Error('list failed')
    expect((listed.value as { ideas: unknown[] }).ideas).toHaveLength(1)

    const got = await call(ctx, { action: 'get', ideaId: createdIdea.idea.id })
    if (got.isError) throw new Error('get failed')
    expect((got.value as { idea: { id: string } }).idea.id).toBe(createdIdea.idea.id)

    const updated = await call(ctx, {
      action: 'update',
      ideaId: createdIdea.idea.id,
      expectedVersion: createdIdea.idea.version,
      status: 'exploring',
      currentSummary: 'Initial review',
    })
    if (updated.isError) throw new Error('update failed')
    expect((updated.value as { idea: { status: string; version: number } }).idea).toMatchObject({
      status: 'exploring',
      version: 2,
    })

    const archived = await call(ctx, {
      action: 'archive',
      ideaId: createdIdea.idea.id,
      expectedVersion: 2,
      reason: 'direction closed',
    })
    if (archived.isError) throw new Error('archive failed')
    expect((archived.value as { idea: { status: string } }).idea.status).toBe('archived')

    const visible = await call(ctx, { action: 'list' })
    if (visible.isError) throw new Error('list failed')
    expect((visible.value as { ideas: unknown[] }).ideas).toEqual([])
    const all = await call(ctx, { action: 'list', includeArchived: true })
    if (all.isError) throw new Error('list all failed')
    expect((all.value as { ideas: unknown[] }).ideas).toHaveLength(1)
  })

  it('adds, lists, and supersedes directed relations', async () => {
    const ctx = await bench()
    const a = await call(ctx, { action: 'create', title: 'A' })
    const b = await call(ctx, { action: 'create', title: 'B' })
    if (a.isError || b.isError) throw new Error('setup failed')
    const aId = (a.value as { idea: { id: string } }).idea.id
    const bId = (b.value as { idea: { id: string } }).idea.id

    const relation = await call(ctx, {
      action: 'add_relation',
      fromIdeaId: bId,
      toIdeaId: aId,
      relationType: 'related_to',
      note: 'same mechanism',
    })
    if (relation.isError) throw new Error('relation failed')
    const relationView = (relation.value as { relation: { id: string; fromIdeaId: string; toIdeaId: string } }).relation
    expect(relationView.fromIdeaId < relationView.toIdeaId).toBe(true)

    const listed = await call(ctx, { action: 'list_relations', ideaId: aId })
    if (listed.isError) throw new Error('relation list failed')
    expect((listed.value as { relations: unknown[] }).relations).toHaveLength(1)

    const removed = await call(ctx, { action: 'remove_relation', relationId: relationView.id })
    if (removed.isError) throw new Error('relation removal failed')
    expect((removed.value as { relation: { status: string } }).relation.status).toBe('superseded')
  })

  it('returns a tool error for a stale version and preserves the original row', async () => {
    const ctx = await bench()
    const created = await call(ctx, { action: 'create', title: 'Conflict' })
    if (created.isError) throw new Error('create failed')
    const idea = (created.value as { idea: { id: string } }).idea
    const stale = await call(ctx, {
      action: 'update',
      ideaId: idea.id,
      expectedVersion: 99,
      title: 'must not apply',
    })
    expect(stale.isError).toBe(true)
    const got = await call(ctx, { action: 'get', ideaId: idea.id })
    if (got.isError) throw new Error('get failed')
    expect((got.value as { idea: { title: string; version: number } }).idea).toMatchObject({
      title: 'Conflict',
      version: 1,
    })
  })
})
