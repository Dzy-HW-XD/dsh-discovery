/**
 * Minimal Phase 1 Idea dashboard: list, create, inspect, transition status,
 * archive, and inspect directed relations/timeline. The panel consumes only
 * the generated `research` Remote namespace; it holds no duplicate backend
 * state and renders no placeholder research records.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  IdeaRelationView,
  IdeaView,
  TimelineEventView,
} from '@deepseek-ai/dsh-research-tools/types'
import { NS } from './locales.ts'

/** The panel's injected Host operations. */
export interface ResearchPanelInjected {
  readonly listIdeas: (request: { includeArchived: boolean }) => Promise<IdeaView[]>
  readonly getIdea: (ideaId: string) => Promise<IdeaView | null>
  readonly createIdea: (request: { title: string; description?: string; researchQuestion?: string }) => Promise<IdeaView>
  readonly updateIdea: (request: {
    ideaId: string
    expectedVersion: number
    status?: string
    parentIdeaId?: string | null
  }) => Promise<IdeaView>
  readonly archiveIdea: (request: { ideaId: string; expectedVersion: number; reason?: string }) => Promise<IdeaView>
  readonly addIdeaRelation: (request: {
    fromIdeaId: string
    toIdeaId: string
    relationType: string
    note?: string
  }) => Promise<IdeaRelationView>
  readonly listIdeaRelations: (ideaId: string) => Promise<IdeaRelationView[]>
  readonly listTimeline: (ideaId: string) => Promise<TimelineEventView[]>
}

type PanelProps =
  PropsRuntime<'main'>
  & PropsLocale<typeof NS>
  & InjectFace<ResearchPanelInjected>

/** Props the pure dashboard needs, independent of slot-standard hooks. */
export type ResearchPanelViewProps = PropsLocale<typeof NS> & ResearchPanelInjected

const STATUSES = ['seed', 'exploring', 'developing', 'reviewing', 'mature', 'archived'] as const
const RELATION_TYPES = ['related_to', 'derived_from', 'merged_from', 'references'] as const

const styles: Record<string, CSSProperties> = {
  page: { height: '100%', overflow: 'auto', padding: '48px 32px 48px', boxSizing: 'border-box' },
  header: { maxWidth: 1200, margin: '0 auto 24px' },
  title: { margin: 0, fontSize: 24, lineHeight: 1.2 },
  subtitle: { margin: '8px 0 0', color: 'var(--dsh-text-secondary, #667085)' },
  columns: { display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) minmax(0, 1fr)', gap: 24, maxWidth: 1200, margin: '0 auto' },
  card: { border: '1px solid var(--dsh-border, #d0d5dd)', borderRadius: 12, padding: 16, background: 'var(--dsh-surface, #fff)' },
  list: { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 },
  row: { width: '100%', textAlign: 'left', border: '1px solid transparent', borderRadius: 8, padding: '10px 12px', background: 'transparent', cursor: 'pointer' },
  rowActive: { borderColor: 'var(--dsh-accent, #2563eb)', background: 'color-mix(in srgb, var(--dsh-accent, #2563eb) 8%, transparent)' },
  field: { display: 'grid', gap: 4, marginBottom: 12 },
  label: { fontSize: 12, fontWeight: 600, color: 'var(--dsh-text-secondary, #667085)' },
  input: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsh-border, #d0d5dd)', font: 'inherit' },
  button: { padding: '8px 12px', borderRadius: 8, border: '1px solid var(--dsh-border, #d0d5dd)', background: 'var(--dsh-surface, #fff)', cursor: 'pointer' },
  primary: { background: 'var(--dsh-accent, #2563eb)', borderColor: 'var(--dsh-accent, #2563eb)', color: '#fff' },
  meta: { color: 'var(--dsh-text-secondary, #667085)', fontSize: 12 },
  error: { color: '#b42318', background: '#fef3f2', borderRadius: 8, padding: '8px 10px', marginBottom: 12 },
  section: { marginTop: 20 },
  relation: { padding: '8px 0', borderBottom: '1px solid var(--dsh-border, #eaecf0)' },
  empty: { color: 'var(--dsh-text-secondary, #667085)', padding: '12px 0' },
}

/**
 * Phase 1 Idea dashboard.
 * @param props - locale copy and injected Host operations.
 * @returns the research dashboard.
 */
export function ResearchPanelView(props: ResearchPanelViewProps) {
  const {
    t, listIdeas, getIdea, createIdea, updateIdea, archiveIdea, addIdeaRelation, listIdeaRelations, listTimeline,
  } = props
  const [ideas, setIdeas] = useState<readonly IdeaView[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<IdeaView | null>(null)
  const [relations, setRelations] = useState<readonly IdeaRelationView[]>([])
  const [timeline, setTimeline] = useState<readonly TimelineEventView[]>([])
  const [title, setTitle] = useState('')
  const [question, setQuestion] = useState('')
  const [description, setDescription] = useState('')
  const [targetId, setTargetId] = useState('')
  const [relationType, setRelationType] = useState<string>('related_to')
  const [note, setNote] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const loadSelected = useCallback(async (ideaId: string): Promise<void> => {
    const [idea, nextRelations, nextTimeline] = await Promise.all([
      getIdea(ideaId),
      listIdeaRelations(ideaId),
      listTimeline(ideaId),
    ])
    setSelected(idea)
    setRelations(nextRelations)
    setTimeline(nextTimeline)
  }, [getIdea, listIdeaRelations, listTimeline])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const next = await listIdeas({ includeArchived: showArchived })
      setIdeas(next)
      if (selectedId !== undefined && next.some(idea => idea.id === selectedId)) {
        await loadSelected(selectedId)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }, [listIdeas, loadSelected, selectedId, showArchived])

  useEffect(() => { void refresh() }, [refresh])

  const select = async (ideaId: string): Promise<void> => {
    setSelectedId(ideaId)
    setBusy(true)
    setError(undefined)
    try {
      await loadSelected(ideaId)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    if (title.trim().length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      const created = await createIdea({
        title,
        ...question.trim().length === 0 ? {} : { researchQuestion: question },
        ...description.trim().length === 0 ? {} : { description },
      })
      setTitle('')
      setQuestion('')
      setDescription('')
      setIdeas(await listIdeas({ includeArchived: showArchived }))
      await select(created.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const changeStatus = async (status: string): Promise<void> => {
    if (selected === null) return
    setBusy(true)
    setError(undefined)
    try {
      const updated = await updateIdea({ ideaId: selected.id, expectedVersion: selected.version, status })
      setIdeas(await listIdeas({ includeArchived: showArchived }))
      if (updated.status === 'archived' && !showArchived) {
        setSelectedId(undefined)
        setSelected(null)
        setRelations([])
        setTimeline([])
      } else {
        setSelected(updated)
        await loadSelected(updated.id)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const changeParent = async (parentId: string): Promise<void> => {
    if (selected === null) return
    setBusy(true)
    setError(undefined)
    try {
      const updated = await updateIdea({
        ideaId: selected.id,
        expectedVersion: selected.version,
        parentIdeaId: parentId.length === 0 ? null : parentId,
      })
      setSelected(updated)
      setIdeas(await listIdeas({ includeArchived: showArchived }))
      await loadSelected(updated.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const archive = async (): Promise<void> => {
    if (selected === null || !window.confirm(t('archiveConfirm'))) return
    setBusy(true)
    setError(undefined)
    try {
      const archived = await archiveIdea({ ideaId: selected.id, expectedVersion: selected.version })
      if (!showArchived) {
        setSelectedId(undefined)
        setSelected(null)
        setRelations([])
        setTimeline([])
      } else {
        setSelected(archived)
      }
      await refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const addRelation = async (): Promise<void> => {
    if (selected === null || targetId.length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      await addIdeaRelation({
        fromIdeaId: selected.id,
        toIdeaId: targetId,
        relationType,
        ...note.trim().length === 0 ? {} : { note },
      })
      setTargetId('')
      setNote('')
      await loadSelected(selected.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const relationLabel = (relation: IdeaRelationView): string => {
    if (selected === null) return relation.relationType
    const otherId = relation.fromIdeaId === selected.id ? relation.toIdeaId : relation.fromIdeaId
    const other = ideas.find(idea => idea.id === otherId)?.title ?? otherId
    const prefix = relation.relationType === 'related_to' ? t('relationRelated')
      : relation.relationType === 'derived_from' ? t('relationDerived')
        : relation.relationType === 'merged_from' ? t('relationMerged')
          : t('relationReferences')
    return `${prefix}: ${other}`
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.title}>{t('title')}</h1>
        <p style={styles.subtitle}>{t('subtitle')}</p>
      </header>
      {error !== undefined && <div style={styles.error} role="alert">{t('error')}: {error}</div>}
      <div style={styles.columns}>
        <section style={styles.card} aria-label={t('panel')}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="research-title">{t('newIdea')}</label>
            <input id="research-title" style={styles.input} value={title} placeholder={t('titlePlaceholder')} onChange={(event) => { setTitle(event.target.value) }} />
            <input style={styles.input} value={question} placeholder={t('questionPlaceholder')} onChange={(event) => { setQuestion(event.target.value) }} />
            <input style={styles.input} value={description} placeholder={t('descriptionPlaceholder')} onChange={(event) => { setDescription(event.target.value) }} />
            <button style={{ ...styles.button, ...styles.primary }} disabled={busy || title.trim().length === 0} onClick={() => { void create() }}>{t('create')}</button>
          </div>
          <label style={styles.meta}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => { setShowArchived(event.target.checked) }}
            />
            {' '}{t('showArchived')}
          </label>
          <div style={styles.meta}>{busy ? t('loading') : `${ideas.length}`}</div>
          {ideas.length === 0
            ? <p style={styles.empty}>{t('empty')}</p>
            : (
              <ul style={styles.list}>
                {ideas.map(idea => (
                  <li key={idea.id}>
                    <button
                      style={{ ...styles.row, ...(idea.id === selectedId ? styles.rowActive : {}) }}
                      onClick={() => { void select(idea.id) }}
                    >
                      <strong>{idea.title}</strong>
                      <div style={styles.meta}>{idea.status} · v{idea.version}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </section>
        <section style={styles.card} aria-label={t('selectIdea')}>
          {selected === null
            ? <p style={styles.empty}>{t('selectIdea')}</p>
            : (
              <>
                <h2 style={{ marginTop: 0 }}>{selected.title}</h2>
                <div style={styles.meta}>{t('updated')} {new Date(selected.updatedAt).toLocaleString()} · {t('version')} {selected.version}</div>
                <div style={styles.field}>
                  <span style={styles.label}>{t('status')}</span>
                  <select
                    aria-label={t('status')}
                    style={styles.input}
                    value={selected.status}
                    onChange={(event) => { void changeStatus(event.target.value) }}
                    disabled={busy}
                  >
                    {STATUSES.map(status => <option key={status} value={status}>{status}</option>)}
                  </select>
                </div>
                <p><strong>{t('researchQuestion')}:</strong> {selected.researchQuestion || t('none')}</p>
                <p><strong>{t('summary')}:</strong> {selected.currentSummary || t('none')}</p>
                <div style={styles.field}>
                  <span style={styles.label}>{t('parent')}</span>
                  <select
                    aria-label={t('parent')}
                    style={styles.input}
                    value={selected.parentIdeaId ?? ''}
                    onChange={(event) => { void changeParent(event.target.value) }}
                    disabled={busy}
                  >
                    <option value="">{t('none')}</option>
                    {ideas
                      .filter(idea => idea.id !== selected.id)
                      .map(idea => <option key={idea.id} value={idea.id}>{idea.title}</option>)}
                  </select>
                </div>
                <button style={styles.button} onClick={() => { void archive() }} disabled={busy || selected.status === 'archived'}>{t('archive')}</button>
                <div style={styles.section}>
                  <h3>{t('relations')}</h3>
                  {relations.length === 0
                    ? <p style={styles.empty}>{t('noRelations')}</p>
                    : relations.map(relation => (
                      <div key={relation.id} style={styles.relation}>
                        <div>{relationLabel(relation)}</div>
                        <div style={styles.meta}>{relation.status}{relation.note.length === 0 ? '' : ` · ${relation.note}`}</div>
                      </div>
                    ))}
                  <div style={styles.field}>
                    <select style={styles.input} value={targetId} onChange={(event) => { setTargetId(event.target.value) }}>
                      <option value="">{t('targetIdea')}</option>
                      {ideas
                        .filter(idea => idea.id !== selected.id)
                        .map(idea => <option key={idea.id} value={idea.id}>{idea.title}</option>)}
                    </select>
                    <select style={styles.input} value={relationType} onChange={(event) => { setRelationType(event.target.value) }}>
                      {RELATION_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                    </select>
                    <input style={styles.input} value={note} placeholder={t('note')} onChange={(event) => { setNote(event.target.value) }} />
                    <button style={styles.button} onClick={() => { void addRelation() }} disabled={busy || targetId.length === 0}>{t('addRelation')}</button>
                  </div>
                </div>
                <div style={styles.section}>
                  <h3>{t('timeline')}</h3>
                  {timeline.length === 0
                    ? <p style={styles.empty}>{t('noTimeline')}</p>
                    : timeline.map(event => (
                      <div key={event.id} style={styles.relation}>
                        <div>{event.summary}</div>
                        <div style={styles.meta}>{new Date(event.createdAt).toLocaleString()}</div>
                      </div>
                    ))}
                </div>
              </>
            )}
        </section>
      </div>
    </div>
  )
}

/**
 * Slot-facing dashboard wrapper; the pure view is exported for focused tests.
 * @param props - slot locale and injected Host operations.
 * @returns the research dashboard.
 */
export function ResearchPanel(props: PanelProps) {
  return <ResearchPanelView {...props} />
}
