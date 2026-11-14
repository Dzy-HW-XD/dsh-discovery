/**
 * Outbox-driven Summary coordinator. It claims only summary jobs, reads the
 * committed Session log outside any database transaction, generates a
 * deterministic summary, then commits the summary and completes the outbox row.
 * @module @deepseek-ai/dsh-research-memory/coordinator
 */

import { SessionId } from '@deepseek-ai/dsh-session/types'
import type ResearchCore from '@deepseek-ai/dsh-research-core'
import { IdeaId, SESSION_SUMMARY_TOPIC, summaryIdempotencyKey, type ResearchSessionSummary } from '@deepseek-ai/dsh-research-core'
import { SummaryEngine, type SummarySessionLog } from './summary-engine.ts'

/** Reader used to load one committed Session log. */
export interface SummaryLogReader {
  /**
   * Read one Session log.
   * @param sessionId - Session identity.
   * @returns inherited prefix length and committed events.
   */
  readSession(sessionId: SessionId): Promise<SummarySessionLog>
}

/** Minimal logger accepted by the coordinator. */
export interface SummaryLogger {
  /**
   * Record a contained failure.
   * @param message - diagnostic text.
   */
  warn(message: string): void
}

/** Options accepted by `SummaryCoordinator`. */
export interface SummaryCoordinatorOptions {
  readonly core: ResearchCore
  readonly reader: SummaryLogReader
  readonly logger: SummaryLogger
  readonly pollMs?: number
}

interface SummaryJobPayload {
  readonly sessionId: string
  readonly ideaId: string
  readonly startSeq: number
  readonly endSeq: number
}

const MAX_ATTEMPTS = 10

function payloadOf(value: Record<string, unknown>): SummaryJobPayload {
  const sessionId = value['sessionId']
  const ideaId = value['ideaId']
  const startSeq = value['startSeq']
  const endSeq = value['endSeq']
  if (typeof sessionId !== 'string' || typeof ideaId !== 'string'
    || typeof startSeq !== 'number' || !Number.isSafeInteger(startSeq)
    || typeof endSeq !== 'number' || !Number.isSafeInteger(endSeq) || endSeq < startSeq) {
    throw new Error('summary payload does not name a valid Session range')
  }
  return { sessionId, ideaId, startSeq, endSeq }
}

/** Durable deterministic Session summary worker. */
export class SummaryCoordinator {
  private readonly engine: SummaryEngine
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private rerun = false

  /**
   * @param options - research core, Session log reader, logger, and poll interval.
   */
  constructor(private readonly options: SummaryCoordinatorOptions) {
    this.engine = new SummaryEngine(options.core)
  }

  /** Start periodic draining and recover interrupted jobs. */
  start(): void {
    if (this.timer !== undefined) return
    this.options.core.outbox.recoverProcessing('summary worker interrupted', Date.now(), SESSION_SUMMARY_TOPIC)
    this.timer = setInterval(() => { void this.pump() }, this.options.pollMs ?? 500)
    this.timer.unref()
  }

  /** Stop the timer without deleting queued work. */
  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Enqueue a summary for one Session.
   * @param sessionId - Session identity.
   * @param endSeq - explicit inclusive end; defaults to the observed watermark.
   * @returns the idempotency key, or undefined for an unbound Session.
   */
  enqueue(sessionId: SessionId, endSeq?: number): string | undefined {
    const binding = this.options.core.sessionBindings.getSession(sessionId)
    if (binding?.ideaId === undefined) return undefined
    const checkpoint = this.options.core.sessionBindings.getCheckpoint(sessionId)
    const end = endSeq ?? Math.max(0, checkpoint?.lastSeenSeq ?? 0)
    const key = summaryIdempotencyKey(sessionId, 0, end)
    this.options.core.outbox.enqueue({
      topic: SESSION_SUMMARY_TOPIC,
      aggregateType: 'research_session',
      aggregateId: sessionId,
      idempotencyKey: key,
      payload: { sessionId, ideaId: binding.ideaId, startSeq: 0, endSeq: end },
    })
    return key
  }

  /**
   * Enqueue and drain one Session summary immediately.
   * @param sessionId - Session identity.
   * @returns the latest summary, or undefined when the Session is unbound.
   */
  async summarizeNow(sessionId: SessionId): Promise<ResearchSessionSummary | undefined> {
    this.enqueue(sessionId)
    await this.flush()
    return this.options.core.summaries.list({ sessionId, limit: 1 })[0]
  }

  /**
   * Drain currently due summary jobs.
   * @returns after the worker is idle.
   */
  async flush(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!this.running && this.options.core.outbox.pendingCount(Date.now(), SESSION_SUMMARY_TOPIC) === 0) return
      await this.pump()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  /**
   * Process one batch of due summary jobs.
   * @returns the number of claimed rows.
   */
  async pump(): Promise<number> {
    if (this.running) {
      this.rerun = true
      return 0
    }
    this.running = true
    let claimed = 0
    try {
      for (;;) {
        const rows = this.options.core.outbox.claimPending(16, Date.now(), SESSION_SUMMARY_TOPIC)
        if (rows.length === 0) break
        claimed += rows.length
        for (const row of rows) {
          await this.processRow(row)
        }
      }
    } finally {
      this.running = false
      if (this.rerun) {
        this.rerun = false
        void this.pump()
      }
    }
    return claimed
  }

  private async processRow(row: {
    id: string
    payload: unknown
    attempts: number
  }): Promise<void> {
    let job: SummaryJobPayload
    try {
      if (typeof row.payload !== 'object' || row.payload === null || Array.isArray(row.payload)) {
        throw new Error('summary payload is not an object')
      }
      job = payloadOf(row.payload as Record<string, unknown>)
    } catch (error: unknown) {
      this.fail(row, error, true)
      return
    }
    const key = summaryIdempotencyKey(job.sessionId, job.startSeq, job.endSeq)
    if (this.options.core.summaries.findByIdempotencyKey(key) !== undefined) {
      this.options.core.outbox.complete(row.id)
      return
    }
    try {
      const snapshot = await this.options.reader.readSession(SessionId(job.sessionId))
      const generated = this.engine.generate({
        sessionId: job.sessionId,
        ideaId: IdeaId(job.ideaId),
        startSeq: job.startSeq,
        endSeq: job.endSeq,
        events: snapshot.events,
      })
      this.options.core.summaries.insert({
        sessionId: job.sessionId,
        ideaId: IdeaId(job.ideaId),
        summary: generated.summary,
        objective: generated.objective,
        keyFindings: generated.keyFindings,
        hypothesesCreated: generated.hypothesesCreated,
        hypothesesValidated: generated.hypothesesValidated,
        hypothesesRejected: generated.hypothesesRejected,
        decisions: generated.decisions,
        failedAttempts: generated.failedAttempts,
        unresolvedQuestions: generated.unresolvedQuestions,
        generatedArtifacts: generated.generatedArtifacts,
        nextSteps: generated.nextSteps,
        sourceReferences: generated.sourceReferences,
        eventStartSeq: job.startSeq,
        eventEndSeq: job.endSeq,
        inputHash: generated.inputHash,
        idempotencyKey: key,
        promptVersion: 'deterministic-v1',
        generationStatus: 'completed',
      })
      this.options.core.outbox.complete(row.id)
    } catch (error: unknown) {
      this.fail(row, error, false)
    }
  }

  private fail(row: { id: string; attempts: number }, error: unknown, dead: boolean): void {
    const message = error instanceof Error ? error.message : String(error)
    const exhausted = dead || row.attempts >= MAX_ATTEMPTS
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6))
    try {
      this.options.core.outbox.retry(row.id, message, Date.now() + delay, exhausted)
    } catch (retryError: unknown) {
      this.options.logger.warn(`research memory: failed to release summary row ${row.id}: ${String(retryError)}`)
    }
  }
}
