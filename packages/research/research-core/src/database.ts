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
export const RESEARCH_DATABASE_LAYOUT_VERSION = 2

/** Business schema version written by the latest migration. */
export const RESEARCH_SCHEMA_VERSION = 2

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

const MIGRATION_2 = `
CREATE TABLE research_sessions (
  session_id        TEXT PRIMARY KEY,
  idea_id           TEXT REFERENCES research_ideas(id) ON DELETE RESTRICT,
  role              TEXT NOT NULL DEFAULT 'primary'
                    CHECK (role IN ('primary','inbox','child','reference')),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','active','inbox','finalizing','finalized','failed','archived')),
  binding_source    TEXT NOT NULL DEFAULT 'research'
                    CHECK (binding_source IN ('research','inbox','manual','schedule','tool')),
  workspace_id      TEXT,
  cwd               TEXT,
  agent_preset      TEXT,
  origin            TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (origin IN ('ui','tool','schedule','subagent','unknown')),
  created_at        INTEGER NOT NULL,
  bound_at          INTEGER,
  finalized_at      INTEGER,
  last_error        TEXT,
  version           INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX idx_sessions_idea_status ON research_sessions(idea_id, status, created_at DESC);
CREATE INDEX idx_sessions_status ON research_sessions(status);
CREATE INDEX idx_sessions_pending ON research_sessions(status) WHERE status IN ('pending','finalizing');

CREATE TABLE research_session_idea_links (
  session_id   TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  idea_id      TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  link_type    TEXT NOT NULL DEFAULT 'reference'
               CHECK (link_type IN ('reference','derived','child','knowledge_reuse')),
  note         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, idea_id, link_type)
) STRICT;

CREATE INDEX idx_session_links_idea ON research_session_idea_links(idea_id);

CREATE TABLE research_session_checkpoints (
  session_id        TEXT PRIMARY KEY REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  last_seen_seq     INTEGER NOT NULL DEFAULT -1,
  last_successfully_processed_seq INTEGER NOT NULL DEFAULT -1,
  last_summarized_seq INTEGER NOT NULL DEFAULT -1,
  status            TEXT NOT NULL DEFAULT 'idle'
                    CHECK (status IN ('idle','processing','failed','complete')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  updated_at        INTEGER NOT NULL,
  CHECK (last_seen_seq >= last_successfully_processed_seq),
  CHECK (last_successfully_processed_seq >= last_summarized_seq)
) STRICT;

CREATE TABLE research_outbox (
  id               TEXT PRIMARY KEY,
  topic            TEXT NOT NULL,
  aggregate_type   TEXT NOT NULL,
  aggregate_id     TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  payload_json     TEXT NOT NULL CHECK (json_valid(payload_json)),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','processing','done','failed','dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  processed_at     INTEGER
) STRICT;

CREATE INDEX idx_outbox_pending ON research_outbox(status, next_attempt_at);
CREATE INDEX idx_outbox_aggregate ON research_outbox(aggregate_id, status, created_at);

ALTER TABLE research_ideas ADD COLUMN workspace_id TEXT;
ALTER TABLE research_ideas ADD COLUMN workspace_path TEXT;
ALTER TABLE research_ideas ADD COLUMN last_session_id TEXT;

ALTER TABLE research_idea_relations ADD COLUMN source_session_id TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT;
ALTER TABLE research_idea_relations ADD COLUMN source_event_seq INTEGER;
ALTER TABLE research_idea_relations ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json));

ALTER TABLE research_timeline_events ADD COLUMN session_id TEXT;
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
    for (const migration of [
      { version: 1, name: 'ideas', sql: MIGRATION_1 },
      { version: 2, name: 'sessions', sql: MIGRATION_2 },
    ]) {
      const applied = this.database
        .prepare('SELECT version FROM research_schema_migrations WHERE version = ?')
        .get(migration.version)
      if (applied !== undefined) continue
      const checksum = createHash('sha256').update(migration.sql).digest('hex')
      this.transaction(() => {
        this.database.exec(migration.sql)
        this.database.prepare(`
          INSERT INTO research_schema_migrations (version, name, checksum, applied_at)
          VALUES (?, ?, ?, ?)
        `).run(migration.version, migration.name, checksum, Date.now())
        this.database.exec(`PRAGMA user_version = ${RESEARCH_DATABASE_LAYOUT_VERSION}`)
      })
    }
  }

  /** Read the physical layout version without throwing on a new database. */
  private readUserVersion(): number {
    const row = this.database.prepare('PRAGMA user_version').get()
    const value = row?.['user_version']
    return typeof value === 'number' ? value : 0
  }
}
