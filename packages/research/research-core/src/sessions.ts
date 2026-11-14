/**
 * Research Session bindings, Idea links, and processing watermarks. The
 * Research database stores business identity and checkpoints; the DSH Session
 * log remains the source of conversational facts.
 * @module @deepseek-ai/dsh-research-core/sessions
 */

import { randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResearchDatabase } from './database.ts'
import { ResearchError } from './errors.ts'
import { integer, optionalInteger, optionalText, text, type SqlRow } from './rows.ts'
import { IdeaId, TimelineEventId, type IdeaId as IdeaIdType } from './types.ts'

/** Lifecycle state of one Session binding. */
export type ResearchSessionStatus =
  | 'pending' | 'active' | 'inbox' | 'finalizing' | 'finalized' | 'failed' | 'archived'

/** Why the Session was bound to its primary Idea. */
export type ResearchSessionBindingSource = 'research' | 'inbox' | 'manual' | 'schedule' | 'tool'

/** Session role relative to its primary Idea. */
export type ResearchSessionRole = 'primary' | 'inbox' | 'child' | 'reference'

/** How the Session was created. */
export type ResearchSessionOrigin = 'ui' | 'tool' | 'schedule' | 'subagent' | 'unknown'

/** One Session-to-Idea binding as the Host and tools expose it. */
export interface ResearchSessionBinding {
  readonly sessionId: SessionId
  readonly ideaId?: IdeaIdType
  readonly role: ResearchSessionRole
  readonly status: ResearchSessionStatus
  readonly bindingSource: ResearchSessionBindingSource
  readonly workspaceId?: string
  readonly cwd?: string
  readonly agentPreset?: string
  readonly origin: ResearchSessionOrigin
  readonly createdAt: number
  readonly boundAt?: number
  readonly finalizedAt?: number
  readonly lastError?: string
  readonly version: number
}

/** Processing watermark and retry state for one Session. */
export interface ResearchSessionCheckpoint {
  readonly sessionId: SessionId
  readonly lastSeenSeq: number
  readonly lastSuccessfullyProcessedSeq: number
  readonly lastSummarizedSeq: number
  readonly status: 'idle' | 'processing' | 'failed' | 'complete'
  readonly attempts: number
  readonly lastError?: string
  readonly updatedAt: number
}

/** Input accepted by `createPendingSession`. */
export interface CreatePendingSessionInput {
  readonly sessionId: SessionId
  readonly ideaId?: IdeaIdType
  readonly role?: ResearchSessionRole
  readonly bindingSource?: ResearchSessionBindingSource
  readonly workspaceId?: string
  readonly cwd?: string
  readonly agentPreset?: string
  readonly origin?: ResearchSessionOrigin
}

/** Input accepted by `ensureInboxSession`. */
export interface EnsureInboxSessionInput {
  readonly sessionId: SessionId
  readonly cwd?: string
  readonly origin?: ResearchSessionOrigin
}

/** One referenced Idea for a Session. */
export interface ResearchSessionIdeaLink {
  readonly sessionId: SessionId
  readonly ideaId: IdeaIdType
  readonly linkType: 'reference' | 'derived' | 'child' | 'knowledge_reuse'
  readonly note: string
  readonly createdAt: number
}

/** One observed Session event recorded for processing. */
export interface ResearchSessionEventRecord {
  readonly sessionId: SessionId
  readonly seq: number
  readonly type: string
  readonly time: number
}

function mapSession(row: SqlRow): ResearchSessionBinding {
  const ideaId = optionalText(row, 'idea_id')
  const workspaceId = optionalText(row, 'workspace_id')
  const cwd = optionalText(row, 'cwd')
  const agentPreset = optionalText(row, 'agent_preset')
  const boundAt = optionalInteger(row, 'bound_at')
  const finalizedAt = optionalInteger(row, 'finalized_at')
  const lastError = optionalText(row, 'last_error')
  return {
    sessionId: text(row, 'session_id') as SessionId,
    ...ideaId === undefined ? {} : { ideaId: IdeaId(ideaId) },
    role: text(row, 'role') as ResearchSessionRole,
    status: text(row, 'status') as ResearchSessionStatus,
    bindingSource: text(row, 'binding_source') as ResearchSessionBindingSource,
    ...workspaceId === undefined ? {} : { workspaceId },
    ...cwd === undefined ? {} : { cwd },
    ...agentPreset === undefined ? {} : { agentPreset },
    origin: text(row, 'origin') as ResearchSessionOrigin,
    createdAt: integer(row, 'created_at'),
    ...boundAt === undefined ? {} : { boundAt },
    ...finalizedAt === undefined ? {} : { finalizedAt },
    ...lastError === undefined ? {} : { lastError },
    version: integer(row, 'version'),
  }
}

function mapCheckpoint(row: SqlRow): ResearchSessionCheckpoint {
  const lastError = optionalText(row, 'last_error')
  return {
    sessionId: text(row, 'session_id') as SessionId,
    lastSeenSeq: integer(row, 'last_seen_seq'),
    lastSuccessfullyProcessedSeq: integer(row, 'last_successfully_processed_seq'),
    lastSummarizedSeq: integer(row, 'last_summarized_seq'),
    status: text(row, 'status') as ResearchSessionCheckpoint['status'],
    attempts: integer(row, 'attempts'),
    ...lastError === undefined ? {} : { lastError },
    updatedAt: integer(row, 'updated_at'),
  }
}

/** Research Session binding and checkpoint repository. */
export class ResearchSessionManager {
  /**
   * @param database - open research database.
   */
  constructor(private readonly database: ResearchDatabase) {}

  /**
   * Create the pending binding row before the DSH Session exists.
   * @param input - pre-minted Session identity and optional Idea.
   * @returns the existing or new binding.
   */
  createPendingSession(input: CreatePendingSessionInput): ResearchSessionBinding {
    const existing = this.getSession(input.sessionId)
    if (existing !== undefined) return existing
    if (input.ideaId !== undefined) this.assertIdea(input.ideaId)
    const now = Date.now()
    const role = input.role ?? (input.ideaId === undefined ? 'inbox' : 'primary')
    const status = input.ideaId === undefined ? 'inbox' : 'pending'
    return this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT OR IGNORE INTO research_sessions (
          session_id, idea_id, role, status, binding_source, workspace_id, cwd,
          agent_preset, origin, created_at, bound_at, finalized_at, last_error, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1)
      `).run(
        input.sessionId, input.ideaId ?? null, role, status, input.bindingSource ?? 'research',
        input.workspaceId ?? null, input.cwd ?? null, input.agentPreset ?? null, input.origin ?? 'ui', now,
      )
      this.ensureCheckpointRow(input.sessionId, now)
      if (input.ideaId !== undefined) {
        this.recordTimeline(input.ideaId, input.sessionId, 'idea.session_linked', 'research_session',
          input.sessionId, 'Research Session linked to Idea', { status }, now)
      }
      return this.requireSession(input.sessionId)
    })
  }

  /**
   * Ensure a standard UI Session appears in the Inbox without changing an
   * existing research binding.
   * @param input - Session identity and optional cwd/origin.
   * @returns the existing or new binding.
   */
  ensureInboxSession(input: EnsureInboxSessionInput): ResearchSessionBinding {
    const existing = this.getSession(input.sessionId)
    if (existing !== undefined) return existing
    const now = Date.now()
    this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT OR IGNORE INTO research_sessions (
          session_id, idea_id, role, status, binding_source, workspace_id, cwd,
          agent_preset, origin, created_at, bound_at, finalized_at, last_error, version
        ) VALUES (?, NULL, 'inbox', 'inbox', 'inbox', NULL, ?, NULL, ?, ?, NULL, NULL, NULL, 1)
      `).run(input.sessionId, input.cwd ?? null, input.origin ?? 'unknown', now)
      this.ensureCheckpointRow(input.sessionId, now)
    })
    return this.requireSession(input.sessionId)
  }

  /**
   * Mark a pending binding active after the Agent was published.
   * @param sessionId - DSH Session identity.
   * @param agentPreset - optional recorded Agent preset.
   * @returns the active binding.
   */
  markSessionActive(sessionId: SessionId, agentPreset?: string): ResearchSessionBinding {
    const current = this.requireSession(sessionId)
    const now = Date.now()
    return this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE research_sessions
        SET status = 'active', bound_at = ?, agent_preset = COALESCE(?, agent_preset),
            last_error = NULL, version = version + 1
        WHERE session_id = ?
      `).run(now, agentPreset ?? null, sessionId)
      if (current.ideaId !== undefined) {
        this.database.connection.prepare(`
          UPDATE research_ideas SET last_session_id = ?, updated_at = ? WHERE id = ?
        `).run(sessionId, now, current.ideaId)
        this.recordTimeline(current.ideaId, sessionId, 'idea.session_active', 'research_session', sessionId,
          'Research Session became active', {}, now)
      }
      return this.requireSession(sessionId)
    })
  }

  /**
   * Mark a failed creation or binding without deleting the row.
   * @param sessionId - DSH Session identity.
   * @param error - user-safe failure detail.
   * @returns the failed binding.
   */
  markSessionFailed(sessionId: SessionId, error: string): ResearchSessionBinding {
    this.requireSession(sessionId)
    return this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE research_sessions
        SET status = 'failed', last_error = ?, version = version + 1
        WHERE session_id = ?
      `).run(error, sessionId)
      return this.requireSession(sessionId)
    })
  }

  /**
   * Bind an existing Session to an Idea. This changes the primary ownership.
   * @param sessionId - DSH Session identity.
   * @param ideaId - target Idea.
   * @returns the active binding.
   */
  linkSessionToIdea(sessionId: SessionId, ideaId: IdeaIdType): ResearchSessionBinding {
    this.assertIdea(ideaId)
    const existing = this.getSession(sessionId)
    if (existing === undefined) {
      this.ensureInboxSession({ sessionId })
    }
    const now = Date.now()
    return this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE research_sessions
        SET idea_id = ?, role = 'primary', status = 'active', binding_source = 'manual',
            bound_at = ?, finalized_at = NULL, last_error = NULL, version = version + 1
        WHERE session_id = ?
      `).run(ideaId, now, sessionId)
      this.database.connection.prepare(`
        UPDATE research_ideas SET last_session_id = ?, updated_at = ? WHERE id = ?
      `).run(sessionId, now, ideaId)
      this.recordTimeline(ideaId, sessionId, 'idea.session_linked', 'research_session', sessionId,
        'Session linked to Idea', { bindingSource: 'manual' }, now)
      return this.requireSession(sessionId)
    })
  }

  /**
   * Return a Session to the Inbox without deleting its binding history.
   * @param sessionId - DSH Session identity.
   * @returns the Inbox binding.
   */
  unlinkSession(sessionId: SessionId): ResearchSessionBinding {
    const current = this.requireSession(sessionId)
    if (current.ideaId === undefined) return current
    const now = Date.now()
    return this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE research_sessions
        SET idea_id = NULL, role = 'inbox', status = 'inbox', binding_source = 'manual',
            bound_at = NULL, finalized_at = NULL, version = version + 1
        WHERE session_id = ?
      `).run(sessionId)
      this.recordTimeline(current.ideaId as IdeaIdType, sessionId, 'idea.session_unlinked', 'research_session',
        sessionId, 'Session unlinked from Idea', {}, now)
      return this.requireSession(sessionId)
    })
  }

  /**
   * Add a non-primary Idea reference for a Session.
   * @param sessionId - DSH Session identity.
   * @param ideaId - referenced Idea.
   * @param linkType - reference kind.
   * @param note - optional note.
   * @returns the link.
   */
  addSessionIdeaReference(
    sessionId: SessionId,
    ideaId: IdeaIdType,
    linkType: ResearchSessionIdeaLink['linkType'] = 'reference',
    note: string = '',
  ): ResearchSessionIdeaLink {
    this.assertIdea(ideaId)
    this.requireSession(sessionId)
    const now = Date.now()
    this.database.connection.prepare(`
      INSERT OR IGNORE INTO research_session_idea_links (session_id, idea_id, link_type, note, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, ideaId, linkType, note, now)
    const row = this.database.connection.prepare(`
      SELECT * FROM research_session_idea_links
      WHERE session_id = ? AND idea_id = ? AND link_type = ?
    `).get(sessionId, ideaId, linkType)
    const found = row as SqlRow
    return {
      sessionId: text(found, 'session_id') as SessionId,
      ideaId: IdeaId(text(found, 'idea_id')),
      linkType: text(found, 'link_type') as ResearchSessionIdeaLink['linkType'],
      note: text(found, 'note'),
      createdAt: integer(found, 'created_at'),
    }
  }

  /**
   * Read one binding.
   * @param sessionId - DSH Session identity.
   * @returns the binding, or undefined.
   */
  getSession(sessionId: SessionId): ResearchSessionBinding | undefined {
    const row = this.database.connection
      .prepare('SELECT * FROM research_sessions WHERE session_id = ?')
      .get(sessionId)
    return row === undefined ? undefined : mapSession(row)
  }

  /**
   * List Sessions under one Idea.
   * @param ideaId - Idea identity.
   * @param includeArchived - include archived bindings.
   * @returns newest-first bindings.
   */
  listSessions(ideaId: IdeaIdType, includeArchived: boolean = false): ResearchSessionBinding[] {
    this.assertIdea(ideaId)
    const rows = includeArchived
      ? this.database.connection.prepare(`
          SELECT * FROM research_sessions WHERE idea_id = ? ORDER BY created_at DESC
        `).all(ideaId)
      : this.database.connection.prepare(`
          SELECT * FROM research_sessions
          WHERE idea_id = ? AND status <> 'archived' ORDER BY created_at DESC
        `).all(ideaId)
    return rows.map(mapSession)
  }

  /**
   * List unbound Inbox Sessions.
   * @returns newest-first bindings.
   */
  listInboxSessions(): ResearchSessionBinding[] {
    return this.database.connection.prepare(`
      SELECT * FROM research_sessions WHERE status = 'inbox' ORDER BY created_at DESC
    `).all().map(mapSession)
  }

  /**
   * List every binding; startup reconciliation uses this.
   * @returns newest-first bindings.
   */
  listAllSessions(): ResearchSessionBinding[] {
    return this.database.connection.prepare(`
      SELECT * FROM research_sessions ORDER BY created_at DESC
    `).all().map(mapSession)
  }

  /**
   * List bindings that still need creation/reconciliation.
   * @returns pending and finalizing bindings.
   */
  listPendingSessions(): ResearchSessionBinding[] {
    return this.database.connection.prepare(`
      SELECT * FROM research_sessions
      WHERE status IN ('pending','finalizing') ORDER BY created_at ASC
    `).all().map(mapSession)
  }

  /**
   * List non-primary Idea references for one Session.
   * @param sessionId - DSH Session identity.
   * @returns links ordered by creation.
   */
  listSessionIdeaLinks(sessionId: SessionId): ResearchSessionIdeaLink[] {
    return this.database.connection.prepare(`
      SELECT * FROM research_session_idea_links WHERE session_id = ? ORDER BY created_at ASC
    `).all(sessionId).map((row) => {
      const found = row as SqlRow
      return {
        sessionId: text(found, 'session_id') as SessionId,
        ideaId: IdeaId(text(found, 'idea_id')),
        linkType: text(found, 'link_type') as ResearchSessionIdeaLink['linkType'],
        note: text(found, 'note'),
        createdAt: integer(found, 'created_at'),
      }
    })
  }

  /**
   * Mark a Session finalizing before its final research extraction.
   * @param sessionId - DSH Session identity.
   * @returns the finalizing binding.
   */
  markSessionFinalizing(sessionId: SessionId): ResearchSessionBinding {
    this.requireSession(sessionId)
    this.database.connection.prepare(`
      UPDATE research_sessions SET status = 'finalizing', version = version + 1 WHERE session_id = ?
    `).run(sessionId)
    return this.requireSession(sessionId)
  }

  /**
   * Mark a Session finalized. This is a research decision, not a DSH event.
   * @param sessionId - DSH Session identity.
   * @param summary - optional completion note stored in the timeline.
   * @returns the finalized binding.
   */
  finalizeSession(sessionId: SessionId, summary?: string): ResearchSessionBinding {
    const current = this.requireSession(sessionId)
    if (current.ideaId === undefined) {
      throw new ResearchError('research/invalid-input', 'an Inbox Session has no primary Idea to finalize', { sessionId })
    }
    const now = Date.now()
    return this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE research_sessions
        SET status = 'finalized', finalized_at = ?, last_error = NULL, version = version + 1
        WHERE session_id = ?
      `).run(now, sessionId)
      if (current.ideaId !== undefined) {
        this.recordTimeline(current.ideaId, sessionId, 'idea.session_finalized', 'research_session',
          sessionId, summary === undefined ? 'Research Session finalized' : `Research Session finalized: ${summary}`,
          summary === undefined ? {} : { summary }, now)
      }
      return this.requireSession(sessionId)
    })
  }

  /**
   * Read the processing checkpoint.
   * @param sessionId - DSH Session identity.
   * @returns the checkpoint, or undefined.
   */
  getCheckpoint(sessionId: SessionId): ResearchSessionCheckpoint | undefined {
    const row = this.database.connection
      .prepare('SELECT * FROM research_session_checkpoints WHERE session_id = ?')
      .get(sessionId)
    return row === undefined ? undefined : mapCheckpoint(row)
  }

  /**
   * Record that events through `seq` were observed. This never advances the
   * successful watermark.
   * @param sessionId - DSH Session identity.
   * @param seq - highest observed Session seq.
   * @returns the checkpoint.
   */
  recordEventsSeen(sessionId: SessionId, seq: number): ResearchSessionCheckpoint {
    this.requireSession(sessionId)
    this.ensureCheckpointRow(sessionId, Date.now())
    this.database.connection.prepare(`
      UPDATE research_session_checkpoints
      SET last_seen_seq = MAX(last_seen_seq, ?), updated_at = ?
      WHERE session_id = ?
    `).run(seq, Date.now(), sessionId)
    return this.requireCheckpoint(sessionId)
  }

  /**
   * Advance the successful watermark only for the next contiguous event.
   * A duplicate is a no-op; a gap rejects so the caller can retry.
   * @param sessionId - DSH Session identity.
   * @param seq - committed event seq.
   * @returns the checkpoint.
   */
  commitProcessedEvent(sessionId: SessionId, seq: number): ResearchSessionCheckpoint {
    this.requireSession(sessionId)
    this.ensureCheckpointRow(sessionId, Date.now())
    const current = this.requireCheckpoint(sessionId)
    if (seq <= current.lastSuccessfullyProcessedSeq) return current
    if (seq !== current.lastSuccessfullyProcessedSeq + 1) {
      throw new ResearchError('research/event-gap', 'Session event sequence has a gap', {
        sessionId,
        expected: current.lastSuccessfullyProcessedSeq + 1,
        actual: seq,
      })
    }
    this.database.connection.prepare(`
      UPDATE research_session_checkpoints
      SET last_seen_seq = MAX(last_seen_seq, ?),
          last_successfully_processed_seq = ?,
          status = 'idle', attempts = 0, last_error = NULL, updated_at = ?
      WHERE session_id = ?
    `).run(seq, seq, Date.now(), sessionId)
    return this.requireCheckpoint(sessionId)
  }

  /**
   * Advance the summary watermark; the summary must not exceed processed work.
   * @param sessionId - DSH Session identity.
   * @param seq - last summarized event seq.
   * @returns the checkpoint.
   */
  commitSummaryThrough(sessionId: SessionId, seq: number): ResearchSessionCheckpoint {
    const current = this.requireCheckpoint(sessionId)
    if (seq > current.lastSuccessfullyProcessedSeq) {
      throw new ResearchError('research/invalid-input', 'summary cannot exceed processed events', {
        sessionId,
        seq,
        processed: current.lastSuccessfullyProcessedSeq,
      })
    }
    this.database.connection.prepare(`
      UPDATE research_session_checkpoints
      SET last_summarized_seq = MAX(last_summarized_seq, ?), updated_at = ?
      WHERE session_id = ?
    `).run(seq, Date.now(), sessionId)
    return this.requireCheckpoint(sessionId)
  }

  /**
   * Initialize both watermarks over a fork-inherited prefix that the Research
   * processor must not replay as new work.
   * @param sessionId - DSH Session identity.
   * @param seq - last inherited event seq, or -1 for none.
   * @returns the checkpoint.
   */
  markInheritedPrefixProcessed(sessionId: SessionId, seq: number): ResearchSessionCheckpoint {
    if (seq < 0) return this.requireCheckpoint(sessionId)
    this.database.connection.prepare(`
      UPDATE research_session_checkpoints
      SET last_seen_seq = MAX(last_seen_seq, ?),
          last_successfully_processed_seq = MAX(last_successfully_processed_seq, ?),
          updated_at = ?
      WHERE session_id = ?
    `).run(seq, seq, Date.now(), sessionId)
    return this.requireCheckpoint(sessionId)
  }

  /**
   * Mark checkpoint processing failed without moving either watermark.
   * @param sessionId - DSH Session identity.
   * @param error - user-safe failure detail.
   * @returns the failed checkpoint.
   */
  markCheckpointFailed(sessionId: SessionId, error: string): ResearchSessionCheckpoint {
    this.requireCheckpoint(sessionId)
    this.database.connection.prepare(`
      UPDATE research_session_checkpoints
      SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ?
      WHERE session_id = ?
    `).run(error, Date.now(), sessionId)
    return this.requireCheckpoint(sessionId)
  }

  /**
   * Reset a `processing` checkpoint after an interrupted worker.
   * @param sessionId - DSH Session identity.
   * @returns the recovered checkpoint.
   */
  recoverCheckpoint(sessionId: SessionId): ResearchSessionCheckpoint {
    const current = this.requireCheckpoint(sessionId)
    if (current.status === 'processing') {
      this.database.connection.prepare(`
        UPDATE research_session_checkpoints
        SET status = 'idle', last_error = NULL, updated_at = ?
        WHERE session_id = ?
      `).run(Date.now(), sessionId)
      return this.requireCheckpoint(sessionId)
    }
    return current
  }

  private requireSession(sessionId: SessionId): ResearchSessionBinding {
    const session = this.getSession(sessionId)
    if (session === undefined) {
      throw new ResearchError('research/session-not-found', `research Session "${sessionId}" not found`, { sessionId })
    }
    return session
  }

  private requireCheckpoint(sessionId: SessionId): ResearchSessionCheckpoint {
    const checkpoint = this.getCheckpoint(sessionId)
    if (checkpoint === undefined) {
      throw new ResearchError('research/session-not-found', `checkpoint for "${sessionId}" not found`, { sessionId })
    }
    return checkpoint
  }

  private assertIdea(ideaId: IdeaIdType): void {
    const row = this.database.connection.prepare('SELECT id FROM research_ideas WHERE id = ?').get(ideaId)
    if (row === undefined) {
      throw new ResearchError('research/idea-not-found', `Idea "${ideaId}" not found`, { ideaId })
    }
  }

  private ensureCheckpointRow(sessionId: SessionId, now: number): void {
    this.database.connection.prepare(`
      INSERT OR IGNORE INTO research_session_checkpoints (
        session_id, last_seen_seq, last_successfully_processed_seq,
        last_summarized_seq, status, attempts, last_error, updated_at
      ) VALUES (?, -1, -1, -1, 'idle', 0, NULL, ?)
    `).run(sessionId, now)
  }

  private recordTimeline(
    ideaId: IdeaIdType,
    sessionId: SessionId,
    eventType: string,
    entityType: string,
    entityId: string,
    summary: string,
    payload: Record<string, string | number | boolean | null>,
    createdAt: number,
  ): void {
    this.database.connection.prepare(`
      INSERT INTO research_timeline_events (
        id, idea_id, session_id, event_type, entity_type, entity_id, summary, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(TimelineEventId(`tl_${randomUUID()}`), ideaId, sessionId, eventType, entityType, entityId,
      summary, JSON.stringify(payload), createdAt)
  }
}
