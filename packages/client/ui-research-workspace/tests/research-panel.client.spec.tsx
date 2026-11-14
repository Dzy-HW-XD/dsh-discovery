// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { IdeaRelationView, IdeaView, ResearchSessionView, TimelineEventView } from '@deepseek-ai/dsh-research-tools/types'
import { ResearchPanelView, type ResearchPanelViewProps } from '../src/client/ResearchPanel.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const idea = (overrides: Partial<IdeaView> = {}): IdeaView => ({
  id: 'idea_1',
  title: 'Bounded Activation',
  description: 'Study SDC',
  researchQuestion: 'Does clamping reduce propagation?',
  objectives: [],
  status: 'seed',
  currentSummary: '',
  createdAt: 1,
  updatedAt: 2,
  version: 1,
  createdBy: 'user',
  ...overrides,
})

function session(sessionId: string, ideaId: string | undefined, status = 'active'): ResearchSessionView {
  return {
    sessionId,
    ...ideaId === undefined ? {} : { ideaId },
    role: ideaId === undefined ? 'inbox' : 'primary',
    status,
    bindingSource: ideaId === undefined ? 'inbox' : 'research',
    origin: 'ui',
    createdAt: 1,
    version: 1,
  }
}

function props(overrides: Partial<ResearchPanelViewProps> = {}): ResearchPanelViewProps {
  return {
    t: makeTranslate(en),
    listIdeas: vi.fn(async () => []),
    getIdea: vi.fn(async () => null),
    createIdea: vi.fn(async (request: { title: string }) => idea({ title: request.title })),
    updateIdea: vi.fn(async (request: { ideaId: string; expectedVersion: number }) =>
      idea({ id: request.ideaId, version: request.expectedVersion + 1 })),
    archiveIdea: vi.fn(async (request: { ideaId: string; expectedVersion: number }) =>
      idea({ id: request.ideaId, status: 'archived', version: request.expectedVersion + 1 })),
    addIdeaRelation: vi.fn(async () => ({
      id: 'rel_1', fromIdeaId: 'idea_1', toIdeaId: 'idea_2', relationType: 'related_to',
      status: 'active', note: '', createdBy: 'user', createdAt: 3,
    } satisfies IdeaRelationView)),
    listIdeaRelations: vi.fn(async () => [] as IdeaRelationView[]),
    listTimeline: vi.fn(async () => [] as TimelineEventView[]),
    listSessions: vi.fn(async () => [] as ResearchSessionView[]),
    listInboxSessions: vi.fn(async () => [] as ResearchSessionView[]),
    createSession: vi.fn(async () => session('session-1', 'idea_1')),
    linkSession: vi.fn(async () => session('session-inbox', 'idea_1')),
    unlinkSession: vi.fn(async () => session('session-1', undefined)),
    finalizeSession: vi.fn(async () => session('session-1', 'idea_1', 'finalized')),
    openSession: vi.fn(),
    ...overrides,
  }
}

describe('ResearchPanelView', () => {
  it('renders the empty state from the real list operation', async () => {
    render(<ResearchPanelView {...props()} />)
    expect(await screen.findByText(en.empty)).toBeTruthy()
    expect(screen.getByText(en.title)).toBeTruthy()
  })

  it('lists Ideas and loads the selected detail, relations, and timeline', async () => {
    const selected = idea({ currentSummary: 'Initial summary' })
    const relation: IdeaRelationView = {
      id: 'rel_1', fromIdeaId: 'idea_1', toIdeaId: 'idea_2', relationType: 'related_to',
      status: 'active', note: 'same mechanism', createdBy: 'user', createdAt: 3,
    }
    const event: TimelineEventView = {
      id: 'tl_1', ideaId: 'idea_1', eventType: 'idea.created', summary: 'Idea created',
      payload: {}, createdAt: 4,
    }
    render(<ResearchPanelView {...props({
      listIdeas: vi.fn(async () => [selected]),
      getIdea: vi.fn(async () => selected),
      listIdeaRelations: vi.fn(async () => [relation]),
      listTimeline: vi.fn(async () => [event]),
    })} />)
    fireEvent.click(await screen.findByText('Bounded Activation'))
    expect(await screen.findByText('Initial summary')).toBeTruthy()
    expect(screen.getByText(/same mechanism/)).toBeTruthy()
    expect(screen.getByText('Idea created')).toBeTruthy()
  })

  it('creates an Idea and selects the committed Host row', async () => {
    let rows: IdeaView[] = []
    const createIdea = vi.fn(async (request: { title: string }) => {
      const created = idea({ id: 'idea_new', title: request.title, version: 1 })
      rows = [created]
      return created
    })
    render(<ResearchPanelView {...props({
      listIdeas: vi.fn(async () => rows),
      createIdea,
      getIdea: vi.fn(async (ideaId: string) => rows.find(row => row.id === ideaId) ?? null),
    })} />)
    fireEvent.change(screen.getByPlaceholderText(en.titlePlaceholder), { target: { value: 'New research direction' } })
    const createButton = screen.getByText(en.create) as HTMLButtonElement
    await waitFor(() => { expect(createButton.disabled).toBe(false) })
    fireEvent.click(createButton)
    await waitFor(() => { expect(createIdea).toHaveBeenCalledWith(expect.objectContaining({ title: 'New research direction' })) })
    expect(await screen.findAllByText('New research direction')).not.toHaveLength(0)
  })

  it('shows a Host failure instead of fabricating a row', async () => {
    render(<ResearchPanelView {...props({
      listIdeas: vi.fn(async () => { throw new Error('database unavailable') }),
    })} />)
    expect((await screen.findByRole('alert')).textContent).toContain('database unavailable')
  })
  it('sets the authoritative parent edge through the real update operation', async () => {
    const parent = idea({ id: 'idea_parent', title: 'Parent direction' })
    const child = idea({ id: 'idea_child', title: 'Child direction' })
    const updateIdea = vi.fn(async (request: { ideaId: string; expectedVersion: number; parentIdeaId?: string | null }) =>
      idea({
        id: request.ideaId,
        version: request.expectedVersion + 1,
        ...request.parentIdeaId === undefined || request.parentIdeaId === null ? {} : { parentIdeaId: request.parentIdeaId },
      }))
    render(<ResearchPanelView {...props({
      listIdeas: vi.fn(async () => [parent, child]),
      getIdea: vi.fn(async ideaId => ideaId === child.id ? child : parent),
      updateIdea,
    })} />)
    fireEvent.click(await screen.findByText('Child direction'))
    fireEvent.change(await screen.findByLabelText(en.parent), { target: { value: parent.id } })
    await waitFor(() => {
      expect(updateIdea).toHaveBeenCalledWith(expect.objectContaining({
        ideaId: child.id,
        expectedVersion: child.version,
        parentIdeaId: parent.id,
      }))
    })
  })

  it('changes status and archives through the Host operations', async () => {
    const selected = idea({ status: 'seed' })
    const updateIdea = vi.fn(async (request: { ideaId: string; expectedVersion: number; status?: string }) =>
      idea({ id: request.ideaId, status: request.status ?? 'seed', version: request.expectedVersion + 1 }))
    const archiveIdea = vi.fn(async (request: { ideaId: string; expectedVersion: number }) =>
      idea({ id: request.ideaId, status: 'archived', version: request.expectedVersion + 1 }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const propsValue = props({
      listIdeas: vi.fn(async () => [selected]),
      getIdea: vi.fn(async () => selected),
      updateIdea,
      archiveIdea,
    })
    render(<ResearchPanelView {...propsValue} />)
    fireEvent.click(await screen.findByText('Bounded Activation'))
    fireEvent.change(await screen.findByLabelText(en.status), { target: { value: 'exploring' } })
    await waitFor(() => {
      expect(updateIdea).toHaveBeenCalledWith(expect.objectContaining({
        ideaId: selected.id,
        expectedVersion: selected.version,
        status: 'exploring',
      }))
    })
    fireEvent.click(await screen.findByText(en.archive))
    await waitFor(() => { expect(archiveIdea).toHaveBeenCalledWith(expect.objectContaining({ ideaId: selected.id })) })
    confirm.mockRestore()
  })

  it('hides archived Ideas by default and loads them on explicit request', async () => {
    const listIdeas = vi.fn(async () => [] as IdeaView[])
    render(<ResearchPanelView {...props({ listIdeas })} />)
    await waitFor(() => { expect(listIdeas).toHaveBeenCalledWith({ includeArchived: false }) })
    fireEvent.click(screen.getByLabelText(en.showArchived))
    await waitFor(() => { expect(listIdeas).toHaveBeenCalledWith({ includeArchived: true }) })
  })

  it('creates a research Session and opens the native Conversation', async () => {
    const selected = idea()
    const openSession = vi.fn()
    const createSession = vi.fn(async () => session('session-new', selected.id))
    render(<ResearchPanelView {...props({
      listIdeas: vi.fn(async () => [selected]),
      getIdea: vi.fn(async () => selected),
      listSessions: vi.fn(async () => []),
      createSession,
      openSession,
    })} />)
    fireEvent.click(await screen.findByText('Bounded Activation'))
    fireEvent.click(await screen.findByText(en.newSession))
    await waitFor(() => { expect(createSession).toHaveBeenCalledWith(selected.id) })
    await waitFor(() => { expect(openSession).toHaveBeenCalledWith('session-new') })
  })

  it('links an Inbox Session and finalizes a research Session through Host operations', async () => {
    const selected = idea()
    const inbox = session('session-inbox', undefined)
    const linked = session('session-inbox', selected.id)
    const listSessions = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([linked])
    const linkSession = vi.fn(async () => linked)
    const finalizeSession = vi.fn(async () => linked)
    render(<ResearchPanelView {...props({
      listIdeas: vi.fn(async () => [selected]),
      getIdea: vi.fn(async () => selected),
      listSessions,
      listInboxSessions: vi.fn(async () => [inbox]),
      linkSession,
      finalizeSession,
    })} />)
    fireEvent.click(await screen.findByText('Bounded Activation'))
    fireEvent.click(await screen.findByText(en.linkSession))
    await waitFor(() => { expect(linkSession).toHaveBeenCalledWith('session-inbox', selected.id) })
    fireEvent.click(await screen.findByText(en.finalizeSession))
    await waitFor(() => { expect(finalizeSession).toHaveBeenCalledWith('session-inbox') })
  })

})
