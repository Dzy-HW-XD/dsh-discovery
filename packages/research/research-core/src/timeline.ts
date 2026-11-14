/**
 * Append-only Research timeline writes shared by memory mutations.
 * @module @deepseek-ai/dsh-research-core/timeline
 */

import { randomUUID } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ResearchDatabase } from './database.ts'
import { TimelineEventId, type IdeaId } from './types.ts'

/**
 * Append one Idea timeline event inside the caller's transaction.
 * @param database - open research database.
 * @param ideaId - owning Idea.
 * @param eventType - stable event kind.
 * @param entityType - affected entity kind, when any.
 * @param entityId - affected entity identity, when any.
 * @param summary - one-line human-readable account.
 * @param sessionId - Session that produced the change, when any.
 * @param payload - JSON-safe event details.
 * @param createdAt - commit timestamp.
 */
export function appendTimeline(
  database: ResearchDatabase,
  ideaId: IdeaId,
  eventType: string,
  entityType: string | undefined,
  entityId: string | undefined,
  summary: string,
  sessionId: string | undefined,
  payload: Record<string, JsonValue>,
  createdAt: number,
): void {
  database.connection.prepare(`
    INSERT INTO research_timeline_events (
      id, idea_id, session_id, event_type, entity_type, entity_id, summary, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(TimelineEventId(`tl_${randomUUID()}`), ideaId, sessionId ?? null,
    eventType, entityType ?? null, entityId ?? null, summary, JSON.stringify(payload), createdAt)
}
