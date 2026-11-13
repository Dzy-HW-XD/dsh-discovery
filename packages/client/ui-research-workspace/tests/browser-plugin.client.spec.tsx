// @vitest-environment jsdom
/**
 * The browser half on a real Cordis Context and SlotRegistry: the plugin
 * registers the `main` keyed panel and its sidebar entry, resolves localized
 * copy through the real LocaleRuntime, and removes both registrations when
 * the plugin fiber disposes.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject, PANEL_ID } from '../src/client/index.ts'

const contexts: Context[] = []

class FakeRemote extends Service {
  constructor(ctx: Context) {
    super(ctx, 'remote')
  }

  $on(): () => void {
    return () => {}
  }
}

async function bench(): Promise<{ ctx: Context; fiber: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  contexts.push(ctx)
  new FakeRemote(ctx)
  ctx.provide('remote.research', {
    listIdeas: async () => ({ ok: true, value: [] }),
    getIdea: async () => ({ ok: true, value: null }),
    createIdea: async () => ({ ok: false, error: { code: 'test/not-called', message: 'not called', details: {} } }),
  } as never)
  ctx.provide('layout', {} as never)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
})

describe('ui-research-workspace browser plugin', () => {
  it('registers one keyed main panel and one sidebar entry with localized copy', async () => {
    const { ctx } = await bench()
    const main = ctx.slots.entries('main')
    expect(main).toHaveLength(1)
    expect(main[0]?.options).toMatchObject({ key: PANEL_ID })
    expect(main[0]?.locale).toBe('researchWorkspace')

    const sidebar = ctx.slots.entries('sidebar.panellist')
    expect(sidebar).toHaveLength(1)
    expect(sidebar[0]?.options).toMatchObject({ id: PANEL_ID, order: -100 })
    expect(sidebar[0]?.locale).toBe('researchWorkspace')
  })

  it('removes both slot registrations when the plugin fiber disposes', async () => {
    const { ctx, fiber } = await bench()
    expect(ctx.slots.entries('main')).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.slots.entries('main')).toHaveLength(0)
    expect(ctx.slots.entries('sidebar.panellist')).toHaveLength(0)
  })
})
