/**
 * One synchronous SQLite connection for the research workspace. The database
 * is separate from DSH Session persistence: Session logs remain the source of
 * conversational facts, while this file stores research-domain records.
 * @module @deepseek-ai/dsh-research-core/database
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ResearchError } from './errors.ts'

/** Physical database layout version, independent of business migrations. */
export const RESEARCH_DATABASE_LAYOUT_VERSION = 1

/** Business schema version written by the Phase 1 migration. */
export const RESEARCH_SCHEMA_VERSION = 1

const MIGRATION_1 = `
CREATE TABLE research_ideas (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  research_question TEXT NOT NULL DEFAULT '',
  objectives_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(objectives_json)),
  status            TEXT NOT NULL DEFAULT 'seed'
                    CHECK (status IN ('seed','exploring','developing','reviewing','mature','archived')),
  parent_idea_id    TEXT REFERENCES research_ideas(id) ON DELETE RESTRICT,
  current_summary   TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived_at       INTEGER,
  version           INTEGER NOT NULL DEFAULT 1,
  created_by        TEXT NOT NULL DEFAULT 'user'
) STRICT;

CREATE INDEX idx_ideas_status_updated ON research_ideas(status, updated_at DESC);
CREATE INDEX idx_ideas_parent ON research_ideas(parent_idea_id);

CREATE TABLE research_idea_relations (
  id                     TEXT PRIMARY KEY,
  from_idea_id           TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  to_idea_id             TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  relation_type          TEXT NOT NULL
                         CHECK (relation_type IN ('related_to','derived_from','merged_from','references')),
  status                 TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','superseded','rejected')),
  note                   TEXT NOT NULL DEFAULT '',
  group_id               TEXT,
  supersedes_relation_id TEXT REFERENCES research_idea_relations(id) ON DELETE RESTRICT,
  created_by             TEXT NOT NULL DEFAULT 'user',
  created_at             INTEGER NOT NULL,
  CHECK (from_idea_id <> to_idea_id),
  CHECK (relation_type <> 'related_to' OR from_idea_id < to_idea_id)
) STRICT;

CREATE INDEX idx_idea_relations_to ON research_idea_relations(to_idea_id);
CREATE INDEX idx_idea_relations_group ON research_idea_relations(group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX ux_idea_relations_active
  ON research_idea_relations(from_idea_id, to_idea_id, relation_type)
  WHERE status = 'active';

CREATE TABLE research_timeline_events (
  id           TEXT PRIMARY KEY,
  idea_id      TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  event_type   TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  summary      TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_timeline_idea_time ON research_timeline_events(idea_id, created_at DESC);
`

/** One open research database. */
export class ResearchDatabase {
  private readonly database: DatabaseSync

  /**
   * Open (and, when absent, create) the research SQLite database.
   * @param root - directory that owns `database.sqlite`; created owner-only.
   */
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.database = new DatabaseSync(join(root, 'database.sqlite'))
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  /** The underlying connection for the Phase 1 repositories. */
  get connection(): DatabaseSync {
    return this.database
  }

  /**
   * Run one synchronous write transaction, rolling back on throw.
   * @param operation - callback that performs all writes and reads.
   * @returns the callback's result after commit.
   */
  transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch (rollbackError) {
        throw new ResearchError(
          'research/database-unavailable',
          'research database rollback failed; the database state is unknown',
          { cause: String(rollbackError) },
        )
      }
      throw error
    }
  }

  /** Close the connection; idempotent at the service teardown boundary. */
  close(): void {
    this.database.close()
  }

  /** Apply the Phase 1 migration when the business schema is absent. */
  private migrate(): void {
    const layout = this.readUserVersion()
    if (layout > RESEARCH_DATABASE_LAYOUT_VERSION) {
      throw new ResearchError(
        'research/database-unavailable',
        `research database layout v${layout} is newer than this build supports`,
        { layout, supported: RESEARCH_DATABASE_LAYOUT_VERSION },
      )
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS research_schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        checksum   TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `)
    const applied = this.database
      .prepare('SELECT version FROM research_schema_migrations WHERE version = ?')
      .get(RESEARCH_SCHEMA_VERSION)
    if (applied !== undefined) return
    const checksum = createHash('sha256').update(MIGRATION_1).digest('hex')
    this.transaction(() => {
      this.database.exec(MIGRATION_1)
      this.database.prepare(`
        INSERT INTO research_schema_migrations (version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(RESEARCH_SCHEMA_VERSION, 'ideas', checksum, Date.now())
      this.database.exec(`PRAGMA user_version = ${RESEARCH_DATABASE_LAYOUT_VERSION}`)
    })
  }

  /** Read the physical layout version without throwing on a new database. */
  private readUserVersion(): number {
    const row = this.database.prepare('PRAGMA user_version').get()
    const value = row?.['user_version']
    return typeof value === 'number' ? value : 0
  }
}
