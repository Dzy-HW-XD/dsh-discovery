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
export const RESEARCH_DATABASE_LAYOUT_VERSION = 5

/** Business schema version written by the latest migration. */
export const RESEARCH_SCHEMA_VERSION = 5

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


const MIGRATION_3 = `
CREATE TABLE research_branches (
  id                TEXT PRIMARY KEY,
  idea_id           TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  parent_branch_id  TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','paused','merged','split','rejected','promoted_to_idea')),
  merged_into_id    TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX idx_branches_idea_status ON research_branches(idea_id, status, updated_at DESC);

ALTER TABLE research_sessions ADD COLUMN branch_id TEXT REFERENCES research_branches(id) ON DELETE RESTRICT;
ALTER TABLE research_timeline_events ADD COLUMN branch_id TEXT REFERENCES research_branches(id) ON DELETE RESTRICT;

CREATE TABLE research_sources (
  id              TEXT PRIMARY KEY,
  origin_idea_id  TEXT REFERENCES research_ideas(id) ON DELETE RESTRICT,
  source_type     TEXT NOT NULL
                  CHECK (source_type IN ('paper','preprint','web','documentation','repository','book','dataset','other')),
  title           TEXT NOT NULL,
  authors_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(authors_json)),
  year            INTEGER,
  venue           TEXT,
  doi             TEXT,
  arxiv_id        TEXT,
  url             TEXT,
  canonical_url   TEXT,
  abstract        TEXT,
  metadata_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  content_hash    TEXT,
  retrieved_at    INTEGER,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','archived','retracted','unavailable')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE UNIQUE INDEX ux_sources_doi ON research_sources(doi) WHERE doi IS NOT NULL;
CREATE UNIQUE INDEX ux_sources_arxiv ON research_sources(arxiv_id) WHERE arxiv_id IS NOT NULL;
CREATE INDEX idx_sources_origin ON research_sources(origin_idea_id, created_at DESC);

CREATE TABLE research_idea_sources (
  idea_id      TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  source_id    TEXT NOT NULL REFERENCES research_sources(id) ON DELETE RESTRICT,
  relevance    TEXT NOT NULL DEFAULT 'cited'
               CHECK (relevance IN ('primary','cited','context','rejected')),
  note         TEXT NOT NULL DEFAULT '',
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (idea_id, source_id)
) STRICT;

CREATE INDEX idx_idea_sources_source ON research_idea_sources(source_id);

CREATE TABLE research_source_locations (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES research_sources(id) ON DELETE RESTRICT,
  locator_type  TEXT NOT NULL
                CHECK (locator_type IN ('page','section','paragraph','line','url_fragment','char_range','figure','table')),
  locator       TEXT NOT NULL,
  page          INTEGER,
  char_start    INTEGER,
  char_end      INTEGER,
  quote         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_source_locations_source ON research_source_locations(source_id);

CREATE TABLE research_concepts (
  id                 TEXT PRIMARY KEY,
  idea_id            TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  name               TEXT NOT NULL,
  definition         TEXT NOT NULL DEFAULT '',
  aliases_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  parent_concept_id  TEXT REFERENCES research_concepts(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','merged','deprecated')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE UNIQUE INDEX ux_concepts_idea_name ON research_concepts(idea_id, name);

CREATE TABLE research_claims (
  id                    TEXT PRIMARY KEY,
  idea_id               TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  statement             TEXT NOT NULL,
  normalized_statement  TEXT NOT NULL DEFAULT '',
  epistemic_status      TEXT NOT NULL DEFAULT 'reported'
                        CHECK (epistemic_status IN ('observed','reported','inferred','speculative','disputed','rejected')),
  confidence            REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','disputed','rejected','superseded','archived')),
  source_ids_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_ids_json)),
  origin_session_id     TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq      INTEGER,
  origin_tool_call_id   TEXT,
  content_hash          TEXT NOT NULL,
  supersedes_id         TEXT REFERENCES research_claims(id) ON DELETE RESTRICT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE UNIQUE INDEX ux_claims_tool_call ON research_claims(origin_tool_call_id) WHERE origin_tool_call_id IS NOT NULL;
CREATE INDEX idx_claims_idea_status ON research_claims(idea_id, status, updated_at DESC);
CREATE INDEX idx_claims_hash ON research_claims(content_hash);

CREATE TABLE research_claim_versions (
  id             TEXT PRIMARY KEY,
  claim_id       TEXT NOT NULL REFERENCES research_claims(id) ON DELETE RESTRICT,
  version        INTEGER NOT NULL,
  snapshot_json  TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  change_reason  TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (claim_id, version)
) STRICT;

CREATE INDEX idx_claim_versions_claim ON research_claim_versions(claim_id, version DESC);

CREATE TABLE research_evidence (
  id                  TEXT PRIMARY KEY,
  idea_id             TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  claim_id            TEXT REFERENCES research_claims(id) ON DELETE RESTRICT,
  source_id           TEXT NOT NULL REFERENCES research_sources(id) ON DELETE RESTRICT,
  location_id         TEXT REFERENCES research_source_locations(id) ON DELETE RESTRICT,
  evidence_type       TEXT NOT NULL
                      CHECK (evidence_type IN ('supports','refutes','context','contradicts')),
  strength            REAL NOT NULL DEFAULT 0.5 CHECK (strength >= 0 AND strength <= 1),
  quote               TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '',
  epistemic_status    TEXT NOT NULL DEFAULT 'reported'
                      CHECK (epistemic_status IN ('observed','reported','inferred','speculative','disputed','rejected')),
  origin_session_id   TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq    INTEGER,
  origin_tool_call_id TEXT,
  content_hash        TEXT NOT NULL,
  supersedes_id       TEXT REFERENCES research_evidence(id) ON DELETE RESTRICT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX idx_evidence_claim ON research_evidence(claim_id, evidence_type);
CREATE INDEX idx_evidence_source ON research_evidence(source_id);

CREATE TABLE research_relations (
  id                TEXT PRIMARY KEY,
  idea_id           TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  from_entity_type  TEXT NOT NULL,
  from_entity_id    TEXT NOT NULL,
  to_entity_type    TEXT NOT NULL,
  to_entity_id      TEXT NOT NULL,
  relation_type     TEXT NOT NULL
                    CHECK (relation_type IN (
                      'supports','refutes','contradicts','extends','depends_on','equivalent_to',
                      'specializes','causes','correlates_with','derived_from','analogous_to',
                      'potentially_related_to')),
  confidence        REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  epistemic_status  TEXT NOT NULL DEFAULT 'inferred'
                    CHECK (epistemic_status IN ('observed','reported','inferred','speculative','disputed','rejected')),
  source_ids_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_ids_json)),
  origin_session_id TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq  INTEGER,
  created_at        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disputed','rejected','superseded')),
  CHECK (from_entity_id <> to_entity_id),
  UNIQUE (idea_id, from_entity_type, from_entity_id, to_entity_type, to_entity_id, relation_type)
) STRICT;

CREATE INDEX idx_relations_from ON research_relations(from_entity_type, from_entity_id);
CREATE INDEX idx_relations_to ON research_relations(to_entity_type, to_entity_id);

CREATE TABLE research_questions (
  id                          TEXT PRIMARY KEY,
  idea_id                     TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id                   TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  question                    TEXT NOT NULL,
  motivation                  TEXT NOT NULL DEFAULT '',
  origin                      TEXT NOT NULL DEFAULT 'session'
                              CHECK (origin IN ('seed','session','gap','discovery','user','critic')),
  priority                    INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  status                      TEXT NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open','investigating','answered','deferred','rejected')),
  related_claim_ids_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related_claim_ids_json)),
  related_hypothesis_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related_hypothesis_ids_json)),
  answer_summary              TEXT NOT NULL DEFAULT '',
  origin_session_id           TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq            INTEGER,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  version                     INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX idx_questions_idea_status ON research_questions(idea_id, status, priority, updated_at DESC);

CREATE TABLE research_gaps (
  id                  TEXT PRIMARY KEY,
  idea_id             TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id           TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  gap_type            TEXT NOT NULL
                      CHECK (gap_type IN ('literature_gap','knowledge_gap','methodological_gap','contradiction_gap','cross_domain_gap')),
  gap_description     TEXT NOT NULL,
  related_work        TEXT NOT NULL DEFAULT '',
  missing_connection  TEXT NOT NULL DEFAULT '',
  evidence            TEXT NOT NULL DEFAULT '',
  novelty_assessment  TEXT NOT NULL DEFAULT '',
  uncertainty         REAL NOT NULL DEFAULT 0.5 CHECK (uncertainty >= 0 AND uncertainty <= 1),
  status              TEXT NOT NULL DEFAULT 'candidate'
                      CHECK (status IN ('candidate','reviewed','accepted','rejected','superseded')),
  origin_session_id   TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq    INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX idx_gaps_idea_status ON research_gaps(idea_id, status, updated_at DESC);

CREATE TABLE research_hypotheses (
  id                             TEXT PRIMARY KEY,
  idea_id                        TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id                      TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  title                          TEXT NOT NULL,
  description                    TEXT NOT NULL,
  theoretical_reasoning          TEXT NOT NULL DEFAULT '',
  assumptions_json               TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(assumptions_json)),
  boundary_conditions_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(boundary_conditions_json)),
  alternative_explanations_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternative_explanations_json)),
  falsification_conditions_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(falsification_conditions_json)),
  related_work_json              TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related_work_json)),
  status                         TEXT NOT NULL DEFAULT 'candidate'
                                 CHECK (status IN ('candidate','under_review','supported','disputed','rejected','superseded')),
  current_version                INTEGER NOT NULL DEFAULT 1,
  origin_session_id              TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq               INTEGER,
  origin_tool_call_id            TEXT,
  created_at                     INTEGER NOT NULL,
  updated_at                     INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_hypotheses_idea_status ON research_hypotheses(idea_id, status, updated_at DESC);

CREATE TABLE research_hypothesis_versions (
  id             TEXT PRIMARY KEY,
  hypothesis_id  TEXT NOT NULL REFERENCES research_hypotheses(id) ON DELETE RESTRICT,
  version        INTEGER NOT NULL,
  snapshot_json  TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  change_reason  TEXT NOT NULL DEFAULT '',
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (hypothesis_id, version)
) STRICT;

CREATE TABLE research_hypothesis_evidence (
  hypothesis_id  TEXT NOT NULL REFERENCES research_hypotheses(id) ON DELETE RESTRICT,
  evidence_id    TEXT NOT NULL REFERENCES research_evidence(id) ON DELETE RESTRICT,
  relation       TEXT NOT NULL CHECK (relation IN ('supports','refutes','context')),
  weight         REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
  note           TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (hypothesis_id, evidence_id, relation)
) STRICT;

CREATE TABLE research_discoveries (
  id                            TEXT PRIMARY KEY,
  idea_id                       TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id                     TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  discovery_type                TEXT NOT NULL
                                CHECK (discovery_type IN ('research_gap','knowledge_bridge','contradiction','counterfactual','novelty','other')),
  description                   TEXT NOT NULL,
  reasoning_chain               TEXT NOT NULL DEFAULT '',
  supporting_entity_ids_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supporting_entity_ids_json)),
  contradicting_entity_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(contradicting_entity_ids_json)),
  novelty_score                 REAL CHECK (novelty_score BETWEEN 0 AND 1),
  gap_quality_score             REAL CHECK (gap_quality_score BETWEEN 0 AND 1),
  evidence_quality_score        REAL CHECK (evidence_quality_score BETWEEN 0 AND 1),
  logical_consistency_score     REAL CHECK (logical_consistency_score BETWEEN 0 AND 1),
  falsifiability_score          REAL CHECK (falsifiability_score BETWEEN 0 AND 1),
  potential_impact_score        REAL CHECK (potential_impact_score BETWEEN 0 AND 1),
  total_score                   REAL CHECK (total_score BETWEEN 0 AND 1),
  score_explanation_json        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(score_explanation_json)),
  reviewer_verdict              TEXT
                                CHECK (reviewer_verdict IN ('pass','revise','reject','insufficient_evidence')),
  status                        TEXT NOT NULL DEFAULT 'candidate'
                                CHECK (status IN ('candidate','reviewed','accepted','rejected','superseded')),
  origin_session_id             TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq              INTEGER,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  version                       INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX idx_discoveries_idea_status ON research_discoveries(idea_id, status, total_score DESC);

CREATE TABLE research_decisions (
  id                TEXT PRIMARY KEY,
  idea_id           TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id         TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  title             TEXT NOT NULL,
  decision          TEXT NOT NULL,
  rationale         TEXT NOT NULL DEFAULT '',
  alternatives_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternatives_json)),
  consequences      TEXT NOT NULL DEFAULT '',
  origin_session_id TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq  INTEGER,
  created_at        INTEGER NOT NULL,
  created_by        TEXT NOT NULL
) STRICT;

CREATE TABLE research_artifacts (
  id                TEXT PRIMARY KEY,
  idea_id           TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  branch_id         TEXT REFERENCES research_branches(id) ON DELETE RESTRICT,
  artifact_type     TEXT NOT NULL
                    CHECK (artifact_type IN ('research_report','literature_review','technical_analysis','markdown','html','graph_export','diagram','dataset','other')),
  title             TEXT NOT NULL,
  path              TEXT,
  mime_type         TEXT,
  content_hash      TEXT,
  size_bytes        INTEGER,
  markdown          TEXT,
  metadata_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','ready','missing','failed','archived')),
  origin_session_id TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  origin_event_seq  INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX idx_artifacts_idea ON research_artifacts(idea_id, created_at DESC);
CREATE INDEX idx_artifacts_status ON research_artifacts(status);

CREATE TABLE research_session_summaries (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  idea_id             TEXT REFERENCES research_ideas(id) ON DELETE RESTRICT,
  summary             TEXT NOT NULL,
  open_questions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(open_questions_json)),
  hypotheses_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hypotheses_json)),
  artifacts_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifacts_json)),
  event_start_seq     INTEGER NOT NULL,
  event_end_seq       INTEGER NOT NULL,
  input_hash          TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'candidate'
                      CHECK (status IN ('candidate','reviewed','superseded','rejected')),
  supersedes_id       TEXT REFERENCES research_session_summaries(id) ON DELETE RESTRICT,
  model_provider      TEXT,
  model_id            TEXT,
  prompt_version      TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  UNIQUE (session_id, event_start_seq, event_end_seq, version)
) STRICT;

CREATE INDEX idx_summaries_session ON research_session_summaries(session_id, created_at DESC);
`


const MIGRATION_4 = `
CREATE TABLE research_memory_records (
  id                    TEXT PRIMARY KEY,
  idea_id               TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  memory_type           TEXT NOT NULL CHECK (memory_type IN (
                          'goal','fact','finding','hypothesis','decision','constraint',
                          'failure','open_question','strategy','preference')),
  title                 TEXT NOT NULL,
  content               TEXT NOT NULL,
  structured_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(structured_json)),
  epistemic_status      TEXT NOT NULL DEFAULT 'inferred'
                        CHECK (epistemic_status IN ('verified','supported','inferred','unverified','disputed','refuted')),
  lifecycle_status      TEXT NOT NULL DEFAULT 'candidate'
                        CHECK (lifecycle_status IN ('candidate','active','superseded','rejected','archived')),
  confidence            REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  source_session_id     TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  source_event_seqs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_event_seqs_json)),
  source_ids_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_ids_json)),
  origin_tool_call_id   TEXT,
  content_hash          TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1,
  supersedes_id         TEXT REFERENCES research_memory_records(id) ON DELETE RESTRICT,
  promoted_at           INTEGER,
  archived_at           INTEGER,
  last_used_at          INTEGER,
  use_count             INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (idea_id, memory_type, content_hash)
) STRICT;

CREATE INDEX idx_memory_idea_status
  ON research_memory_records(idea_id, lifecycle_status, memory_type, updated_at DESC);
CREATE INDEX idx_memory_session ON research_memory_records(source_session_id);
CREATE INDEX idx_memory_hash ON research_memory_records(content_hash);

CREATE TABLE research_memory_versions (
  id                TEXT PRIMARY KEY,
  memory_id         TEXT NOT NULL REFERENCES research_memory_records(id) ON DELETE RESTRICT,
  version           INTEGER NOT NULL,
  snapshot_json     TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  change_reason     TEXT NOT NULL,
  change_source     TEXT NOT NULL
                    CHECK (change_source IN ('extractor','user','agent','system','review')),
  created_by        TEXT NOT NULL,
  source_session_id TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  source_event_seq  INTEGER,
  created_at        INTEGER NOT NULL,
  UNIQUE (memory_id, version)
) STRICT;

CREATE INDEX idx_memory_versions_memory ON research_memory_versions(memory_id, version DESC);

CREATE TABLE research_memory_sources (
  id            TEXT PRIMARY KEY,
  memory_id     TEXT NOT NULL REFERENCES research_memory_records(id) ON DELETE RESTRICT,
  source_key    TEXT NOT NULL,
  session_id    TEXT REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  event_seq     INTEGER,
  entity_type   TEXT CHECK (entity_type IN (
                  'source','concept','claim','evidence','question','gap','hypothesis',
                  'discovery','decision','artifact','session_summary','memory')),
  entity_id     TEXT,
  source_id     TEXT REFERENCES research_sources(id) ON DELETE RESTRICT,
  location_id   TEXT REFERENCES research_source_locations(id) ON DELETE RESTRICT,
  quote         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  UNIQUE (memory_id, source_key),
  CHECK (session_id IS NOT NULL OR entity_id IS NOT NULL OR source_id IS NOT NULL)
) STRICT;

CREATE INDEX idx_memory_sources_memory ON research_memory_sources(memory_id);
CREATE INDEX idx_memory_sources_session ON research_memory_sources(session_id);

CREATE TABLE research_memory_relations (
  id            TEXT PRIMARY KEY,
  memory_id     TEXT NOT NULL REFERENCES research_memory_records(id) ON DELETE RESTRICT,
  entity_type   TEXT NOT NULL CHECK (entity_type IN (
                  'source','concept','claim','evidence','question','gap','hypothesis',
                  'discovery','decision','artifact','session_summary','memory')),
  entity_id     TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN (
                  'about','derived_from','supports','refutes','supersedes','related','conflicts_with')),
  note          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  UNIQUE (memory_id, entity_type, entity_id, relation_type)
) STRICT;

CREATE INDEX idx_memory_relations_entity ON research_memory_relations(entity_type, entity_id);

CREATE TABLE research_memory_conflicts (
  id            TEXT PRIMARY KEY,
  idea_id       TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  memory_a_id   TEXT NOT NULL REFERENCES research_memory_records(id) ON DELETE RESTRICT,
  memory_b_id   TEXT NOT NULL REFERENCES research_memory_records(id) ON DELETE RESTRICT,
  conflict_type TEXT NOT NULL
                CHECK (conflict_type IN ('contradiction','condition_mismatch','possible_duplicate','superseded')),
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','resolved','dismissed')),
  resolution    TEXT NOT NULL DEFAULT '',
  detected_by   TEXT NOT NULL,
  resolved_at   INTEGER,
  created_at    INTEGER NOT NULL,
  CHECK (memory_a_id <> memory_b_id),
  UNIQUE (memory_a_id, memory_b_id, conflict_type)
) STRICT;

CREATE INDEX idx_memory_conflicts_idea ON research_memory_conflicts(idea_id, status, created_at DESC);

CREATE TABLE research_memory_selections (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE RESTRICT,
  idea_id        TEXT NOT NULL REFERENCES research_ideas(id) ON DELETE RESTRICT,
  turn           INTEGER NOT NULL,
  step           INTEGER NOT NULL,
  memory_id      TEXT NOT NULL REFERENCES research_memory_records(id) ON DELETE RESTRICT,
  rank           INTEGER NOT NULL,
  layer          TEXT NOT NULL CHECK (layer IN ('core','relevant','historical')),
  reason         TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (session_id, turn, step, memory_id)
) STRICT;

CREATE INDEX idx_memory_selections_session
  ON research_memory_selections(session_id, turn, step);
CREATE INDEX idx_memory_selections_idea
  ON research_memory_selections(idea_id, created_at DESC);
`


const MIGRATION_5 = `
ALTER TABLE research_session_summaries ADD COLUMN objective TEXT NOT NULL DEFAULT '';
ALTER TABLE research_session_summaries ADD COLUMN key_findings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(key_findings_json));
ALTER TABLE research_session_summaries ADD COLUMN hypotheses_created_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hypotheses_created_json));
ALTER TABLE research_session_summaries ADD COLUMN hypotheses_validated_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hypotheses_validated_json));
ALTER TABLE research_session_summaries ADD COLUMN hypotheses_rejected_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hypotheses_rejected_json));
ALTER TABLE research_session_summaries ADD COLUMN decisions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(decisions_json));
ALTER TABLE research_session_summaries ADD COLUMN unresolved_questions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(unresolved_questions_json));
ALTER TABLE research_session_summaries ADD COLUMN failed_attempts_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(failed_attempts_json));
ALTER TABLE research_session_summaries ADD COLUMN next_steps_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(next_steps_json));
ALTER TABLE research_session_summaries ADD COLUMN generated_artifacts_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(generated_artifacts_json));
ALTER TABLE research_session_summaries ADD COLUMN source_references_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_references_json));
ALTER TABLE research_session_summaries ADD COLUMN generation_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (generation_status IN ('pending','generating','completed','failed','skipped'));
ALTER TABLE research_session_summaries ADD COLUMN generation_error TEXT;
ALTER TABLE research_session_summaries ADD COLUMN idempotency_key TEXT;
ALTER TABLE research_session_summaries ADD COLUMN updated_at INTEGER;

CREATE UNIQUE INDEX ux_summary_idempotency
  ON research_session_summaries(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_summaries_idea_time
  ON research_session_summaries(idea_id, created_at DESC);
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
      { version: 3, name: 'artifacts', sql: MIGRATION_3 },
      { version: 4, name: 'memory', sql: MIGRATION_4 },
      { version: 5, name: 'session-summaries', sql: MIGRATION_5 },
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
