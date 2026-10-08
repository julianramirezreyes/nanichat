import type { DatabaseSync } from 'node:sqlite';

const VERSION = 11;

const INITIAL_SCHEMA = `
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_code TEXT NOT NULL CHECK (provider_code = 'META'),
  login_kind TEXT NOT NULL CHECK (login_kind IN ('instagram_login', 'facebook_login')),
  app_id TEXT,
  graph_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unvalidated', 'valid', 'invalid', 'disconnected')),
  access_token_nonce TEXT,
  access_token_ciphertext TEXT,
  access_token_tag TEXT,
  last_validated_at TEXT,
  validation_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((access_token_nonce IS NULL AND access_token_ciphertext IS NULL AND access_token_tag IS NULL)
      OR (access_token_nonce IS NOT NULL AND access_token_ciphertext IS NOT NULL AND access_token_tag IS NOT NULL))
);

CREATE TABLE social_accounts (
  account_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  provider_account_id TEXT NOT NULL,
  username TEXT NOT NULL,
  normalized_username TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('unvalidated', 'valid', 'disconnected')),
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  last_validated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, connection_id)
);
CREATE UNIQUE INDEX active_provider_account_owner ON social_accounts(provider_account_id) WHERE status <> 'disconnected';
CREATE UNIQUE INDEX active_normalized_username_owner ON social_accounts(normalized_username) WHERE status <> 'disconnected';
CREATE INDEX social_accounts_connection_idx ON social_accounts(connection_id, status);

CREATE TABLE media (
  account_id TEXT NOT NULL REFERENCES social_accounts(account_id) ON DELETE RESTRICT,
  media_id TEXT NOT NULL,
  permalink TEXT,
  published_at TEXT,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(account_id, media_id)
);

CREATE TABLE comments (
  account_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  text TEXT,
  username TEXT,
  created_at TEXT,
  parent_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(account_id, media_id, comment_id),
  UNIQUE(account_id, comment_id),
  FOREIGN KEY(account_id, media_id) REFERENCES media(account_id, media_id) ON DELETE RESTRICT
);
CREATE INDEX comments_account_created_idx ON comments(account_id, created_at);

CREATE TABLE automations (
  automation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES social_accounts(account_id) ON DELETE RESTRICT,
  media_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'enabled', 'paused')),
  match_mode TEXT NOT NULL DEFAULT 'contains' CHECK (match_mode IN ('exact', 'contains')),
  reply_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(automation_id, account_id),
  FOREIGN KEY(account_id, media_id) REFERENCES media(account_id, media_id) ON DELETE RESTRICT
);
CREATE TABLE automation_keywords (
  account_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  keyword_id TEXT NOT NULL,
  phrase TEXT NOT NULL,
  normalized_phrase TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, automation_id, keyword_id),
  FOREIGN KEY(automation_id, account_id) REFERENCES automations(automation_id, account_id) ON DELETE CASCADE
);

CREATE TABLE queue_items (
  queue_item_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  automation_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('DISCOVERED', 'MATCHED', 'QUEUED', 'SEND_INTENT_RECORDED', 'SENDING', 'SENT', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'UNKNOWN_OUTCOME', 'EXPIRED', 'SKIPPED', 'SIMULATED')),
  dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, comment_id, automation_id),
  UNIQUE(queue_item_id, account_id),
  FOREIGN KEY(account_id, comment_id) REFERENCES comments(account_id, comment_id) ON DELETE RESTRICT,
  FOREIGN KEY(automation_id, account_id) REFERENCES automations(automation_id, account_id) ON DELETE RESTRICT
);
CREATE INDEX queue_account_state_idx ON queue_items(account_id, state, created_at);

CREATE TABLE send_attempts (
  attempt_event_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  queue_item_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('intent_recorded', 'accepted', 'definitive_rejection', 'retryable_failure', 'ambiguous_outcome', 'readback')),
  event_at TEXT NOT NULL,
  message_id TEXT,
  safe_error_code TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(queue_item_id, account_id) REFERENCES queue_items(queue_item_id, account_id) ON DELETE RESTRICT
);
CREATE INDEX send_attempts_queue_idx ON send_attempts(account_id, queue_item_id, event_at);
CREATE TRIGGER send_attempts_no_update BEFORE UPDATE ON send_attempts BEGIN
  SELECT RAISE(ABORT, 'send_attempts is append-only');
END;
CREATE TRIGGER send_attempts_no_delete BEFORE DELETE ON send_attempts BEGIN
  SELECT RAISE(ABORT, 'send_attempts is append-only');
END;

CREATE TABLE checkpoints (
  account_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  checkpoint_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id, media_id, checkpoint_key),
  FOREIGN KEY(account_id, media_id) REFERENCES media(account_id, media_id) ON DELETE RESTRICT
);
CREATE TABLE app_state (
  state_key TEXT PRIMARY KEY,
  state_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO app_state(state_key, state_value, updated_at) VALUES
  ('dry_run', 'true', CURRENT_TIMESTAMP),
  ('monitoring_enabled', 'false', CURRENT_TIMESTAMP);
PRAGMA user_version = 1;
`;

/**
 * Applies every pending versioned migration in one transaction. `targetVersion` exists only so tests can build an
 * older schema shape and then exercise the upgrade path; production always migrates to the latest version.
 */
export function migrateDatabase(database: DatabaseSync, targetVersion: number = VERSION): void {
  const current = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > VERSION) throw new Error(`Database schema version ${current} is newer than supported version ${VERSION}`);
  const target = Math.min(VERSION, Math.max(1, Math.trunc(targetVersion)));
  if (current >= target) return;
  // The v10 automations rebuild must not fire ON DELETE actions (CASCADE would delete keywords). SQLite only allows
  // toggling foreign_keys outside a transaction, so it is switched off here, re-verified with foreign_key_check inside
  // the transaction, and always restored afterwards.
  const rebuild = current < 10 && target >= 10;
  const foreignKeys = (database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
  if (rebuild) database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    if (current === 0) database.exec(INITIAL_SCHEMA);
    if (current < 2 && target >= 2) migrateQueueUniqueness(database);
    if (current < 3 && target >= 3) migrateConnectionLifecycle(database);
    if (current < 4 && target >= 4) migrateObservedAccountIdentity(database);
    if (current < 5 && target >= 5) migrateAutomationEngine(database);
    if (current < 6 && target >= 6) migrateLegacyAcknowledgements(database);
    if (current < 7 && target >= 7) migrateClassificationProvenance(database);
    if (current < 8 && target >= 8) migrateQueueStateReason(database);
    if (current < 9 && target >= 9) migrateMediaDisplay(database);
    if (rebuild) migrateAutomationScope(database);
    if (current < 11 && target >= 11) migratePublicReply(database);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    if (rebuild && foreignKeys) database.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * v11: optional public reply after an accepted private reply. Additive only (ADD COLUMN, new table); the v10
 * automations shape (scope, nullable media_id) is kept untouched. Per-item public state lives on queue_items; every
 * public attempt event is appended to the immutable `public_reply_attempts` table. At most one `accepted` public
 * reply can ever exist per queue item (partial unique index).
 */
function migratePublicReply(database: DatabaseSync): void {
  database.exec(`ALTER TABLE automations ADD COLUMN public_reply_enabled INTEGER NOT NULL DEFAULT 0 CHECK (public_reply_enabled IN (0, 1));
  ALTER TABLE automations ADD COLUMN public_reply_variants_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE queue_items ADD COLUMN public_reply_state TEXT CHECK (public_reply_state IS NULL OR public_reply_state IN
    ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN_OUTCOME', 'SKIPPED', 'EXPIRED'));
  ALTER TABLE queue_items ADD COLUMN public_reply_text TEXT;
  ALTER TABLE queue_items ADD COLUMN public_reply_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE queue_items ADD COLUMN public_reply_next_at TEXT;
  ALTER TABLE queue_items ADD COLUMN public_reply_variant TEXT;
  ALTER TABLE queue_items ADD COLUMN public_reply_selected_at TEXT;
  CREATE INDEX queue_public_reply_idx ON queue_items(public_reply_state, account_id, created_at);
  CREATE INDEX queue_public_reply_rotation_idx ON queue_items(account_id, public_reply_selected_at);
  CREATE TABLE public_reply_attempts (
    attempt_event_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    queue_item_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('intent_recorded', 'accepted', 'definitive_rejection', 'ambiguous', 'skipped', 'expired', 'manual_retry')),
    event_at TEXT NOT NULL,
    reply_id TEXT,
    safe_error_code TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(queue_item_id, account_id) REFERENCES queue_items(queue_item_id, account_id) ON DELETE RESTRICT
  );
  CREATE INDEX public_reply_attempts_queue_idx ON public_reply_attempts(account_id, queue_item_id, event_at);
  CREATE INDEX public_reply_attempts_type_idx ON public_reply_attempts(event_type, event_at);
  CREATE UNIQUE INDEX public_reply_one_accepted_per_item ON public_reply_attempts(queue_item_id) WHERE event_type = 'accepted';
  CREATE TRIGGER public_reply_attempts_no_update BEFORE UPDATE ON public_reply_attempts BEGIN
    SELECT RAISE(ABORT, 'public_reply_attempts is append-only');
  END;
  CREATE TRIGGER public_reply_attempts_no_delete BEFORE DELETE ON public_reply_attempts BEGIN
    SELECT RAISE(ABORT, 'public_reply_attempts is append-only');
  END;
  PRAGMA user_version = 11;`);
}

/**
 * v10: automations gain `scope` ('media' = one publication, 'account' = every publication of the account without its
 * own enabled automation). Account-scoped rows have a NULL media_id, so NOT NULL must be relaxed, which SQLite can
 * only do by rebuilding the table (documented 12-step procedure). The composite FK to media is kept: SQLite treats a
 * NULL child column as satisfying it, while media-scoped rows stay enforced. A CHECK ties scope to media_id.
 * All referencing rows (keywords, queue items, classifications) keep their automation_id; nothing is deleted.
 */
function migrateAutomationScope(database: DatabaseSync): void {
  database.exec(`CREATE TABLE automations_v10 (
    automation_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES social_accounts(account_id) ON DELETE RESTRICT,
    media_id TEXT,
    scope TEXT NOT NULL DEFAULT 'media' CHECK (scope IN ('media', 'account')),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'enabled', 'paused')),
    match_mode TEXT NOT NULL DEFAULT 'contains' CHECK (match_mode IN ('exact', 'contains')),
    reply_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    real_enabled INTEGER NOT NULL DEFAULT 0 CHECK (real_enabled IN (0, 1)),
    buttons_json TEXT NOT NULL DEFAULT '[]',
    monitoring_started_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(automation_id, account_id),
    CHECK ((scope = 'media' AND media_id IS NOT NULL) OR (scope = 'account' AND media_id IS NULL)),
    FOREIGN KEY(account_id, media_id) REFERENCES media(account_id, media_id) ON DELETE RESTRICT
  );
  INSERT INTO automations_v10 (automation_id, account_id, media_id, scope, name, status, match_mode, reply_text,
    created_at, updated_at, real_enabled, buttons_json, monitoring_started_at, version)
    SELECT automation_id, account_id, media_id, 'media', name, status, match_mode, reply_text,
      created_at, updated_at, real_enabled, buttons_json, monitoring_started_at, version FROM automations;
  DROP TABLE automations;
  ALTER TABLE automations_v10 RENAME TO automations;
  CREATE INDEX automations_account_scope_idx ON automations(account_id, scope, status);
  CREATE INDEX automations_account_media_idx ON automations(account_id, media_id, status);`);
  const violations = database.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) {
    throw new Error('Cannot migrate automations: foreign key check failed; existing rows were left unchanged');
  }
  database.exec('PRAGMA user_version = 10;');
}

function migrateMediaDisplay(database: DatabaseSync): void {
  // Display-only metadata so publications are readable in the UI. Nullable: legacy rows stay valid.
  database.exec(`ALTER TABLE media ADD COLUMN caption TEXT;
  ALTER TABLE media ADD COLUMN media_type TEXT;
  PRAGMA user_version = 9;`);
}

function migrateQueueStateReason(database: DatabaseSync): void {
  // Safe machine reason for terminal transitions that are not provider attempts (for example EXPIRED).
  database.exec(`ALTER TABLE queue_items ADD COLUMN state_reason_code TEXT;
  PRAGMA user_version = 8;`);
}

function migrateClassificationProvenance(database: DatabaseSync): void {
  // Records which scan run produced each classification so backlog processing can require a completed scan.
  database.exec(`ALTER TABLE comment_classifications ADD COLUMN scan_id TEXT;
  PRAGMA user_version = 7;`);
}

function migrateLegacyAcknowledgements(database: DatabaseSync): void {
  database.exec(`CREATE TABLE legacy_account_acknowledgements (
    account_id TEXT PRIMARY KEY REFERENCES social_accounts(account_id) ON DELETE RESTRICT,
    username TEXT NOT NULL,
    counter_version TEXT NOT NULL,
    acknowledged_at TEXT NOT NULL
  );
  PRAGMA user_version = 6;`);
}

function migrateAutomationEngine(database: DatabaseSync): void {
  database.exec(`ALTER TABLE automations ADD COLUMN real_enabled INTEGER NOT NULL DEFAULT 0 CHECK (real_enabled IN (0, 1));
    ALTER TABLE automations ADD COLUMN buttons_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE queue_items ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE queue_items ADD COLUMN next_attempt_at TEXT;
    ALTER TABLE automations ADD COLUMN monitoring_started_at TEXT;
    ALTER TABLE automations ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    CREATE TABLE scan_runs (
      scan_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      media_id TEXT NOT NULL,
      scan_kind TEXT NOT NULL CHECK (scan_kind IN ('monitor', 'catch_up', 'backlog')),
      status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'incomplete', 'cancelled')),
      cutoff_at TEXT,
      pages_read INTEGER NOT NULL DEFAULT 0,
      comments_seen INTEGER NOT NULL DEFAULT 0,
      stop_reason TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY(account_id, media_id) REFERENCES media(account_id, media_id) ON DELETE RESTRICT
    );
    CREATE INDEX scan_runs_account_idx ON scan_runs(account_id, started_at);
    CREATE TABLE comment_classifications (
      account_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      automation_id TEXT NOT NULL,
      result TEXT NOT NULL,
      reason TEXT NOT NULL,
      matched_keywords_json TEXT NOT NULL DEFAULT '[]',
      observed_at TEXT NOT NULL,
      PRIMARY KEY(account_id, comment_id, automation_id),
      FOREIGN KEY(account_id, comment_id) REFERENCES comments(account_id, comment_id) ON DELETE RESTRICT,
      FOREIGN KEY(automation_id, account_id) REFERENCES automations(automation_id, account_id) ON DELETE RESTRICT
    );
    CREATE INDEX comment_classification_result_idx ON comment_classifications(account_id, result, observed_at);
    CREATE TABLE account_send_holds (
      account_id TEXT PRIMARY KEY REFERENCES social_accounts(account_id) ON DELETE RESTRICT,
      reason_code TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    PRAGMA user_version = 5;`);
}

function migrateConnectionLifecycle(database: DatabaseSync): void {
  database.exec(`ALTER TABLE connections ADD COLUMN deleted_at TEXT;
    ALTER TABLE connections ADD COLUMN monitoring_paused INTEGER NOT NULL DEFAULT 1 CHECK (monitoring_paused IN (0, 1));
    ALTER TABLE connections ADD COLUMN observed_user_id TEXT;
    ALTER TABLE connections ADD COLUMN observed_username TEXT;
    ALTER TABLE connections ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE social_accounts ADD COLUMN page_token_nonce TEXT;
    ALTER TABLE social_accounts ADD COLUMN page_token_ciphertext TEXT;
    ALTER TABLE social_accounts ADD COLUMN page_token_tag TEXT;
    ALTER TABLE social_accounts ADD COLUMN monitoring_paused INTEGER NOT NULL DEFAULT 1 CHECK (monitoring_paused IN (0, 1));
    ALTER TABLE social_accounts ADD COLUMN last_validation_error_code TEXT;
    CREATE INDEX connections_visible_idx ON connections(deleted_at, created_at);
    PRAGMA user_version = 3;`);
}

function migrateObservedAccountIdentity(database: DatabaseSync): void {
  database.exec(`ALTER TABLE social_accounts ADD COLUMN account_type TEXT;
    ALTER TABLE social_accounts ADD COLUMN related_page_id TEXT;
    PRAGMA user_version = 4;`);
}

function migrateQueueUniqueness(database: DatabaseSync): void {
  const duplicate = database.prepare(`SELECT 1 AS duplicate
    FROM queue_items
    GROUP BY account_id, comment_id
    HAVING COUNT(*) > 1
    LIMIT 1`).get();
  if (duplicate) {
    throw new Error('Cannot migrate queue: duplicate initial private-reply items exist for an account/comment; resolve them without deleting history first');
  }
  database.exec(`CREATE UNIQUE INDEX queue_one_initial_reply_per_comment
    ON queue_items(account_id, comment_id);
    PRAGMA user_version = 2;`);
}
