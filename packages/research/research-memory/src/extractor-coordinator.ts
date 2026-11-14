/**
 * Outbox-driven memory extraction. It consumes only the extraction topic and
 * writes candidates through the Memory Store. It never calls the model or runs
 * inside the Summary transaction.
 * @module @deepseek-ai/dsh-research-memory/extractor-coordinator
 */

import type ResearchCore from '@deepseek-ai/dsh-research-core'
import {
  SESSION_MEMORY_EXTRACTION_TOPIC,
  extractionIdempotencyKey,
  type ResearchSessionSummary,
} from '@deepseek-ai/dsh-research-core'
import { MemoryExtractor } from './memory-extractor.ts'

/** Logger accepted by the extraction coordinator. */
export interface ExtractionLogger {
  /**
   * Record a contained failure.
   * @param message - diagnostic text.
   */
  warn(message: string): void
}

/** Options accepted by `ExtractorCoordinator`. */
export interface ExtractorCoordinatorOptions {
  readonly core: ResearchCore
  readonly logger: ExtractionLogger
  readonly pollMs?: number
}

interface ExtractionJob {
  readonly summaryId: string
  readonly summaryVersion: number
}

const MAX_ATTEMPTS = 10

function jobOf(value: unknown): ExtractionJob {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('extraction payload is not an object')
  }
  const record = value as Record<string, unknown>
  const summaryId = record['summaryId']
  const summaryVersion = record['summaryVersion']
  if (typeof summaryId !== 'string' || typeof summaryVersion !== 'number'
    || !Number.isSafeInteger(summaryVersion) || summaryVersion < 1) {
    throw new Error('extraction payload does not name a Summary version')
  }
  return { summaryId, summaryVersion }
}

/** Durable extractor worker. */
export class ExtractorCoordinator {
  private readonly extractor: MemoryExtractor
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private rerun = false

  /**
   * @param options - research core, logger, and poll interval.
   */
  constructor(private readonly options: ExtractorCoordinatorOptions) {
    this.extractor = new MemoryExtractor(options.core)
  }

  /** Start periodic draining, recover interrupted work, and reconcile summaries. */
  start(): void {
    if (this.timer !== undefined) return
    this.options.core.outbox.recoverProcessing('extractor worker interrupted', Date.now(), SESSION_MEMORY_EXTRACTION_TOPIC)
    this.reconcile()
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
   * Enqueue extraction for one Summary version.
   * @param summary - persisted summary.
   * @returns the idempotency key.
   */
  enqueue(summary: ResearchSessionSummary): string {
    const key = extractionIdempotencyKey(summary.id, summary.generationVersion)
    this.options.core.outbox.enqueue({
      topic: SESSION_MEMORY_EXTRACTION_TOPIC,
      aggregateType: 'research_summary',
      aggregateId: summary.id,
      idempotencyKey: key,
      payload: {
        summaryId: summary.id,
        sessionId: summary.sessionId,
        ideaId: summary.ideaId ?? null,
        summaryVersion: summary.generationVersion,
      },
    })
    return key
  }

  /** Enqueue missing extraction jobs for existing summaries. */
  reconcile(): void {
    for (const summary of this.options.core.summaries.list({ limit: 500 })) this.enqueue(summary)
  }

  /**
   * Drain currently due extraction jobs.
   * @returns after the worker is idle.
   */
  async flush(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!this.running
        && this.options.core.outbox.pendingCount(Date.now(), SESSION_MEMORY_EXTRACTION_TOPIC) === 0) return
      await this.pump()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  /**
   * Process one batch of extraction jobs.
   * @returns claimed row count.
   */
  async pump(): Promise<number> {
    await Promise.resolve()
    if (this.running) {
      this.rerun = true
      return 0
    }
    this.running = true
    let claimed = 0
    try {
      for (;;) {
        const rows = this.options.core.outbox.claimPending(16, Date.now(), SESSION_MEMORY_EXTRACTION_TOPIC)
        if (rows.length === 0) break
        claimed += rows.length
        for (const row of rows) this.processRow(row)
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

  private processRow(row: { id: string; payload: unknown; attempts: number }): void {
    let job: ExtractionJob
    try {
      job = jobOf(row.payload)
    } catch (error: unknown) {
      this.fail(row, error, true)
      return
    }
    try {
      const summary = this.options.core.summaries.get(job.summaryId)
      if (summary === undefined || summary.generationVersion !== job.summaryVersion) {
        throw new Error(`summary ${job.summaryId} v${job.summaryVersion} is unavailable`)
      }
      this.extractor.extract(summary, row.id)
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
      this.options.logger.warn(`research memory: failed to release extraction row ${row.id}: ${String(retryError)}`)
    }
  }
}
