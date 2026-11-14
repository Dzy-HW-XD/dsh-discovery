/**
 * Durable outbox for Research side effects. Rows are inserted in the same
 * transaction as the state change that requires them and are claimed by a
 * worker; completion is recorded only after the effect commits.
 * @module @deepseek-ai/dsh-research-core/outbox
 */

import { randomUUID } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ResearchDatabase } from './database.ts'
import { ResearchError } from './errors.ts'
import { integer, json, optionalInteger, optionalText, text, type SqlRow } from './rows.ts'

/** Outbox lifecycle states. */
export type ResearchOutboxStatus = 'pending' | 'processing' | 'done' | 'failed' | 'dead'

/** One outbox row as the worker reads it. */
export interface ResearchOutboxRow {
  readonly id: string
  readonly topic: string
  readonly aggregateType: string
  readonly aggregateId: string
  readonly idempotencyKey: string
  readonly payload: JsonValue
  readonly status: ResearchOutboxStatus
  readonly attempts: number
  readonly nextAttemptAt: number
  readonly lastError?: string
  readonly createdAt: number
  readonly processedAt?: number
}

/** Input accepted by `enqueue`. */
export interface EnqueueOutboxInput {
  readonly topic: string
  readonly aggregateType: string
  readonly aggregateId: string
  readonly idempotencyKey: string
  readonly payload: JsonValue
}

function mapRow(row: SqlRow): ResearchOutboxRow {
  const lastError = optionalText(row, 'last_error')
  const processedAt = optionalInteger(row, 'processed_at')
  return {
    id: text(row, 'id'),
    topic: text(row, 'topic'),
    aggregateType: text(row, 'aggregate_type'),
    aggregateId: text(row, 'aggregate_id'),
    idempotencyKey: text(row, 'idempotency_key'),
    payload: json(row, 'payload_json'),
    status: text(row, 'status') as ResearchOutboxStatus,
    attempts: integer(row, 'attempts'),
    nextAttemptAt: integer(row, 'next_attempt_at'),
    ...lastError === undefined ? {} : { lastError },
    createdAt: integer(row, 'created_at'),
    ...processedAt === undefined ? {} : { processedAt },
  }
}

/** Durable outbox repository. */
export class ResearchOutbox {
  /**
   * @param database - open research database.
   */
  constructor(private readonly database: ResearchDatabase) {}

  /**
   * Insert one idempotent effect request.
   * @param input - topic, aggregate, unique key, and JSON payload.
   * @param now - creation timestamp.
   * @returns true when a new row was inserted.
   */
  enqueue(input: EnqueueOutboxInput, now: number = Date.now()): boolean {
    const result = this.database.connection.prepare(`
      INSERT OR IGNORE INTO research_outbox (
        id, topic, aggregate_type, aggregate_id, idempotency_key, payload_json,
        status, attempts, next_attempt_at, last_error, created_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, NULL)
    `).run(`outbox_${randomUUID()}`, input.topic, input.aggregateType, input.aggregateId,
      input.idempotencyKey, JSON.stringify(input.payload), now, now)
    return result.changes === 1
  }

  /**
   * Claim a bounded batch of due work. Claiming increments attempts and marks
   * rows processing atomically, so a second worker cannot claim them.
   * @param limit - maximum rows.
   * @param now - claim timestamp.
   * @returns claimed rows.
   */
  claimPending(limit: number, now: number = Date.now(), topic?: string): ResearchOutboxRow[] {
    const bounded = Math.max(1, Math.min(limit, 100))
    return this.database.transaction(() => {
      const rows = topic === undefined
        ? this.database.connection.prepare(`
            SELECT * FROM research_outbox
            WHERE status = 'pending' AND next_attempt_at <= ?
            ORDER BY created_at ASC, id ASC
            LIMIT ?
          `).all(now, bounded)
        : this.database.connection.prepare(`
            SELECT * FROM research_outbox
            WHERE status = 'pending' AND next_attempt_at <= ? AND topic = ?
            ORDER BY created_at ASC, id ASC
            LIMIT ?
          `).all(now, topic, bounded)
      const claimed: ResearchOutboxRow[] = []
      for (const row of rows) {
        const id = text(row, 'id')
        this.database.connection.prepare(`
          UPDATE research_outbox
          SET status = 'processing', attempts = attempts + 1
          WHERE id = ? AND status = 'pending'
        `).run(id)
        claimed.push(mapRow(row))
      }
      return claimed
    })
  }

  /**
   * Mark one claimed row done.
   * @param id - outbox row identity.
   * @param now - completion timestamp.
   */
  complete(id: string, now: number = Date.now()): void {
    const result = this.database.connection.prepare(`
      UPDATE research_outbox
      SET status = 'done', processed_at = ?, last_error = NULL
      WHERE id = ? AND status = 'processing'
    `).run(now, id)
    if (result.changes !== 1) {
      throw new ResearchError('research/outbox-not-found', `outbox row "${id}" is not processing`, { id })
    }
  }

  /**
   * Return one claimed row to the pending queue, or mark it dead.
   * @param id - outbox row identity.
   * @param error - user-safe failure detail.
   * @param nextAttemptAt - next eligible time.
   * @param dead - whether the retry budget is exhausted.
   * @param now - update timestamp.
   */
  retry(id: string, error: string, nextAttemptAt: number, dead: boolean = false, now: number = Date.now()): void {
    const result = this.database.connection.prepare(`
      UPDATE research_outbox
      SET status = ?, next_attempt_at = ?, last_error = ?, processed_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(dead ? 'dead' : 'pending', nextAttemptAt, error, dead ? now : null, id)
    if (result.changes !== 1) {
      throw new ResearchError('research/outbox-not-found', `outbox row "${id}" is not processing`, { id })
    }
  }

  /**
   * Reset rows left processing by a crashed worker.
   * @param error - recovery note stored on each row.
   * @param now - recovery timestamp.
   * @returns number of recovered rows.
   */
  recoverProcessing(error: string = 'worker interrupted', now: number = Date.now(), topic?: string): number {
    const result = topic === undefined
      ? this.database.connection.prepare(`
          UPDATE research_outbox
          SET status = 'pending', next_attempt_at = ?, last_error = ?
          WHERE status = 'processing'
        `).run(now, error)
      : this.database.connection.prepare(`
          UPDATE research_outbox
          SET status = 'pending', next_attempt_at = ?, last_error = ?
          WHERE status = 'processing' AND topic = ?
        `).run(now, error, topic)
    return Number(result.changes)
  }

  /**
   * Read one outbox row.
   * @param id - outbox row identity.
   * @returns the row, or undefined.
   */
  get(id: string): ResearchOutboxRow | undefined {
    const row = this.database.connection.prepare('SELECT * FROM research_outbox WHERE id = ?').get(id)
    return row === undefined ? undefined : mapRow(row)
  }

  /**
   * Earliest time a pending row becomes eligible.
   * @returns the timestamp, or undefined when no pending row exists.
   */
  nextDueAt(topic?: string): number | undefined {
    const row = (topic === undefined
      ? this.database.connection.prepare(`
          SELECT MIN(next_attempt_at) AS next FROM research_outbox WHERE status = 'pending'
        `).get()
      : this.database.connection.prepare(`
          SELECT MIN(next_attempt_at) AS next FROM research_outbox WHERE status = 'pending' AND topic = ?
        `).get(topic)) as SqlRow
    const value = row['next']
    return typeof value === 'number' ? value : undefined
  }

  /**
   * Count pending rows.
   * @param now - only rows due at or before this time count.
   * @returns pending row count.
   */
  pendingCount(now: number = Date.now(), topic?: string): number {
    const row = (topic === undefined
      ? this.database.connection.prepare(`
          SELECT COUNT(*) AS count FROM research_outbox
          WHERE status = 'pending' AND next_attempt_at <= ?
        `).get(now)
      : this.database.connection.prepare(`
          SELECT COUNT(*) AS count FROM research_outbox
          WHERE status = 'pending' AND next_attempt_at <= ? AND topic = ?
        `).get(now, topic)) as SqlRow
    return integer(row, 'count')
  }
}
