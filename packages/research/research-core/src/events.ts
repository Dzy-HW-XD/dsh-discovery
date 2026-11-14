/**
 * Reliable Session-event processing. DSH owns the append-only Session log;
 * Research records observation and processing watermarks and moves side
 * effects through `research_outbox`. A successful watermark advances only in
 * the same transaction that marks the outbox row done.
 * @module @deepseek-ai/dsh-research-core/events
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ResearchDatabase } from './database.ts'
import { ResearchError } from './errors.ts'
import type { ResearchOutbox, ResearchOutboxRow } from './outbox.ts'
import { summaryIdempotencyKey } from './summary-types.ts'
import type { ResearchSessionManager } from './sessions.ts'

/**
 * Minimal Session-log read surface the processor needs. Research Core does not
 * depend on the Session query package; the Host wires its implementation in.
 */
export interface ResearchSessionLogReader {
  /**
   * Read one complete Session log.
   * @param sessionId - live or persisted Session id to read.
   * @returns inherited prefix length and raw events.
   */
  readSession(sessionId: SessionId): Promise<{
    readonly inheritedEventCount: number
    readonly events: readonly SessionEvent[]
  }>
}

/** Topic used for one committed Session event. */
export const SESSION_EVENT_TOPIC = 'research/session-event'

/** Topic used for deterministic Session summary generation. */
export const SESSION_SUMMARY_TOPIC = 'research/session-summary'

/** Maximum outbox attempts before a row is marked dead. */
const MAX_ATTEMPTS = 10

/** Delay before retrying a row blocked behind an event gap. */
const GAP_RETRY_MS = 1000

interface SessionEventPayload {
  readonly [key: string]: JsonValue
  readonly sessionId: string
  readonly seq: number
  readonly type: string
  readonly time: number
}

function payloadOf(row: ResearchOutboxRow): SessionEventPayload {
  const payload = row.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ResearchError('research/invalid-input', 'outbox payload is not an object', { id: row.id })
  }
  const record = payload as Record<string, JsonValue>
  const sessionId = record['sessionId']
  const seq = record['seq']
  const type = record['type']
  const time = record['time']
  if (typeof sessionId !== 'string' || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0
    || typeof type !== 'string' || typeof time !== 'number' || !Number.isSafeInteger(time)) {
    throw new ResearchError('research/invalid-input', 'outbox payload does not name a Session event', { id: row.id })
  }
  return { sessionId, seq, type, time }
}

/** Reliable processor for bound Session events. */
export class ResearchSessionEventProcessor {
  private reader: ResearchSessionLogReader | undefined
  private running = false
  private rerun = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param ctx - Host context carrying the live Session store and Session query.
   * @param database - research database owning outbox and checkpoints.
   * @param sessions - Session binding repository.
   * @param outbox - durable side-effect queue.
   */
  constructor(
    private readonly ctx: Context,
    private readonly database: ResearchDatabase,
    private readonly sessions: ResearchSessionManager,
    private readonly outbox: ResearchOutbox,
  ) {
  }

  /**
   * Attach the Host Session-log reader used by startup reconciliation.
   * @param reader - Session query implementation, or undefined before it mounts.
   */
  setSessionLogReader(reader: ResearchSessionLogReader | undefined): void {
    this.reader = reader
  }

  /**
   * Observe one committed event. The seen watermark and outbox row commit
   * together; duplicate observations are idempotent.
   * @param sessionId - DSH Session identity.
   * @param event - committed Session event.
   */
  observe(sessionId: SessionId, event: SessionEvent): void {
    if (this.sessions.getSession(sessionId) === undefined) return
    const payload: SessionEventPayload = {
      sessionId,
      seq: event.seq,
      type: event.type,
      time: event.time,
    }
    this.database.transaction(() => {
      this.sessions.recordEventsSeen(sessionId, event.seq)
      this.outbox.enqueue({
        topic: SESSION_EVENT_TOPIC,
        aggregateType: 'research_session',
        aggregateId: sessionId,
        idempotencyKey: `session-event:${sessionId}:${event.seq}`,
        payload,
      })
      if (event.type === 'turn/end') {
        const binding = this.sessions.getSession(sessionId)
        if (binding?.ideaId !== undefined) {
          this.outbox.enqueue({
            topic: SESSION_SUMMARY_TOPIC,
            aggregateType: 'research_session',
            aggregateId: sessionId,
            idempotencyKey: summaryIdempotencyKey(sessionId, 0, event.seq),
            payload: { sessionId, ideaId: binding.ideaId, startSeq: 0, endSeq: event.seq },
          })
        }
      }
    })
    void this.pump()
  }

  /**
   * Read one Session log and enqueue every event after the successful
   * watermark. Fork-inherited events are skipped as a prefix.
   * @param sessionId - DSH Session identity.
   */
  async scanSession(sessionId: SessionId): Promise<void> {
    if (this.sessions.getSession(sessionId) === undefined) return
    if (this.reader === undefined) {
      throw new ResearchError('research/database-unavailable', 'Session query is not mounted', {})
    }
    const snapshot = await this.reader.readSession(sessionId)
    const checkpoint = this.sessions.getCheckpoint(sessionId)
    if (checkpoint === undefined) return
    const inherited = snapshot.inheritedEventCount - 1
    if (inherited > checkpoint.lastSuccessfullyProcessedSeq) {
      this.sessions.markInheritedPrefixProcessed(sessionId, inherited)
    }
    for (const event of snapshot.events) {
      if (event.seq <= (this.sessions.getCheckpoint(sessionId)?.lastSuccessfullyProcessedSeq ?? -1)) continue
      this.observe(sessionId, event)
    }
    await this.pump()
  }

  /**
   * Reconcile every known binding. Recovery is idempotent and safe to call on
   * startup or after a reconnect.
   */
  async reconcile(): Promise<void> {
    this.outbox.recoverProcessing('worker interrupted', Date.now(), SESSION_EVENT_TOPIC)
    if (this.reader !== undefined) {
      for (const session of this.sessions.listAllSessions()) {
        try {
          await this.scanSession(session.sessionId)
        } catch (error: unknown) {
          this.ctx.logger.warn(`research: failed to reconcile Session ${session.sessionId}: ${String(error)}`)
        }
      }
    }
    await this.pump()
  }

  /**
   * Drain due outbox rows. Rows for one Session are applied in seq order; a
   * gap leaves the row pending and never advances the success watermark.
   * @returns after the currently due rows settle.
   */
  pump(): Promise<void> {
    this.drain()
    return Promise.resolve()
  }

  /** Synchronous drain loop; `pump` exposes it as the awaited public operation. */
  private drain(): void {
    if (this.running) {
      this.rerun = true
      return
    }
    this.running = true
    try {
      for (;;) {
        const rows = this.outbox.claimPending(64, Date.now(), SESSION_EVENT_TOPIC)
        if (rows.length === 0) break
        const bySession = new Map<string, ResearchOutboxRow[]>()
        for (const row of rows) {
          const group = bySession.get(row.aggregateId)
          if (group === undefined) bySession.set(row.aggregateId, [row])
          else group.push(row)
        }
        for (const [sessionIdText, group] of bySession) {
          const sessionId = SessionId(sessionIdText)
          group.sort((left, right) => payloadOf(left).seq - payloadOf(right).seq)
          for (let index = 0; index < group.length; index += 1) {
            const row = group[index] as ResearchOutboxRow
            let advanced: boolean
            try {
              advanced = this.processRow(sessionId, row)
            } catch (error: unknown) {
              this.ctx.logger.warn(`research: outbox row ${row.id} failed: ${String(error)}`)
              this.failRow(row, error, false)
              advanced = true
            }
            if (!advanced) {
              for (const blocked of group.slice(index + 1)) {
                this.outbox.retry(blocked.id, 'blocked behind a Session event gap', Date.now() + GAP_RETRY_MS)
              }
              break
            }
          }
        }
      }
    } finally {
      this.running = false
      if (this.rerun) {
        this.rerun = false
        void this.pump()
      } else if (this.outbox.nextDueAt(SESSION_EVENT_TOPIC) !== undefined) {
        this.scheduleRetry()
      }
    }
  }

  /** Schedule one bounded retry for rows parked behind a gap. */
  private scheduleRetry(): void {
    if (this.retryTimer !== undefined) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.pump().catch((error: unknown) => {
        this.ctx.logger.warn(`research: outbox retry failed: ${String(error)}`)
      })
    }, GAP_RETRY_MS)
  }

  /** Release the retry timer when the owning service unloads. */
  dispose(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  /**
   * Wait until currently due rows settle. Test and shutdown callers use this;
   * a row parked behind a gap remains pending and is not waited on forever.
   * @returns after the processor is idle.
   */
  async flush(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!this.running && this.outbox.pendingCount(Date.now(), SESSION_EVENT_TOPIC) === 0) return
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  /** Process one claimed row; return false when the Session's contiguous prefix is blocked. */
  private processRow(sessionId: SessionId, row: ResearchOutboxRow): boolean {
    let payload: SessionEventPayload
    try {
      payload = payloadOf(row)
      if (payload.sessionId !== sessionId) {
        throw new ResearchError('research/invalid-input', 'outbox row aggregate does not match payload', { id: row.id })
      }
    } catch (error: unknown) {
      this.failRow(row, error, true)
      return true
    }
    const checkpoint = this.sessions.getCheckpoint(sessionId)
    if (checkpoint === undefined) {
      this.failRow(row, new ResearchError('research/session-not-found', 'Session binding is missing', { sessionId }), true)
      return true
    }
    if (payload.seq <= checkpoint.lastSuccessfullyProcessedSeq) {
      this.outbox.complete(row.id)
      return true
    }
    if (payload.seq !== checkpoint.lastSuccessfullyProcessedSeq + 1) {
      this.outbox.retry(row.id, `waiting for Session event ${checkpoint.lastSuccessfullyProcessedSeq + 1}`, Date.now() + GAP_RETRY_MS)
      return false
    }
    try {
      this.database.transaction(() => {
        if (payload.type === 'turn/start') {
          this.database.connection.prepare(`
            UPDATE research_sessions
            SET status = 'active', bound_at = COALESCE(bound_at, ?), version = version + 1
            WHERE session_id = ? AND status = 'pending'
          `).run(payload.time, sessionId)
        }
        this.sessions.commitProcessedEvent(sessionId, payload.seq)
        this.outbox.complete(row.id)
      })
      return true
    } catch (error: unknown) {
      this.sessions.markCheckpointFailed(sessionId, error instanceof Error ? error.message : String(error))
      this.failRow(row, error, false)
      return true
    }
  }

  private failRow(row: ResearchOutboxRow, error: unknown, dead: boolean): void {
    const message = error instanceof Error ? error.message : String(error)
    const exhausted = dead || row.attempts >= MAX_ATTEMPTS
    try {
      this.outbox.retry(row.id, message, Date.now() + GAP_RETRY_MS, exhausted)
    } catch (retryError: unknown) {
      this.ctx.logger.warn(`research: failed to release outbox row ${row.id}: ${String(retryError)}`)
    }
  }
}
