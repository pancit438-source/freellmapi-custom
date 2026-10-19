// Migration: per-endpoint identity for custom relay models (#651)
// Created: 2026-07-29
//
// DOWN: reversible (throws when duplicates exist — see below)
//
// `models` was unique on (platform, model_id). Every custom relay is stored
// under platform = 'custom', so two relays offering the same model id could not
// coexist: the second registration silently rebound the first one's row. One
// enabled flag, one set of ranks, one stats bucket — turning the model off
// because relay A was broken turned it off for relay B as well (#619).
//
// This adds `endpoint_scope` (the endpoint's normalized base_url, '' for every
// catalog platform) and moves uniqueness to (platform, model_id,
// endpoint_scope). Catalog rows all share the '' scope, so their constraint is
// bit-for-bit the old one; only custom rows gain room for a sibling.
//
// SQLite cannot drop a table-level UNIQUE, so `models` is rebuilt. Two details
// make that safe on a live DB:
//   - row ids are copied verbatim, so fallback_config / profile_models /
//     saved fusion configs keep pointing at the same models;
//   - `PRAGMA foreign_keys` is a no-op inside a transaction and the migration
//     runner wraps up() in one, so the child rows are parked in temp tables
//     across the DROP and restored after the rename. Renaming `models` itself
//     is avoided on purpose: with foreign keys on, a rename rewrites the
//     REFERENCES clauses of every child table to the new name.
//
// Schema only — no catalog data.

import type { Db } from '../types.js';

// The models table as of this migration, plus the new column. Written out in
// full rather than derived, so the rebuilt schema is auditable here and
// identical on every run.
const MODELS_COLUMNS = `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      key_id INTEGER,
      supports_tools INTEGER NOT NULL DEFAULT 0,
      paid_input_per_m REAL,
      paid_output_per_m REAL,
      source TEXT NOT NULL DEFAULT 'catalog'`;

const CARRIED_COLUMNS = [
  'id', 'platform', 'model_id', 'display_name', 'intelligence_rank', 'speed_rank',
  'size_label', 'rpm_limit', 'rpd_limit', 'tpm_limit', 'tpd_limit',
  'monthly_token_budget', 'context_window', 'enabled', 'supports_vision', 'key_id',
  'supports_tools', 'paid_input_per_m', 'paid_output_per_m', 'source',
].join(', ');

// Tables whose rows must survive the DROP. Discovered from the schema rather
// than hard-coded, so a table added later that references models is carried too.
function childTablesOfModels(db: Db): string[] {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'models'
     ORDER BY name
  `).all() as { name: string }[];
  return tables
    .filter(t => (db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as { table: string }[])
      .some(fk => fk.table === 'models'))
    .map(t => t.name);
}

function rebuildModels(db: Db, extraColumns: string, copiedColumns: string, unique: string, selectedColumns = copiedColumns): void {
  const children = childTablesOfModels(db);
  // The historical deployment contains references to deleted models. Keep
  // those chain/profile rows intact, repairing their references with disabled
  // placeholders. They have no provider or key and can never route or sync.
  const preserveDeleted = db.prepare(`
    INSERT OR IGNORE INTO models
      (id, platform, model_id, display_name, intelligence_rank, speed_rank, enabled, key_id, source)
    VALUES (?, 'legacy-deleted', ?, ?, 1000, 1000, 0, NULL, 'user')
  `);
  for (const child of children) {
    const quotedChild = '"' + child.replaceAll('"', '""') + '"';
    const refs = db.prepare(`PRAGMA foreign_key_list(${quotedChild})`).all() as { table: string; from: string; to: string }[];
    for (const ref of refs.filter(row => row.table === 'models' && row.to === 'id')) {
      const column = '"' + ref.from.replaceAll('"', '""') + '"';
      const missing = db.prepare(`SELECT DISTINCT ${column} AS id FROM ${quotedChild}
        WHERE ${column} IS NOT NULL AND ${column} NOT IN (SELECT id FROM models)`)
        .all() as { id: number }[];
      for (const row of missing) preserveDeleted.run(row.id, `__legacy_deleted_model_${row.id}`, `Deleted historical model #${row.id}`);
    }
  }
  // AUTOINCREMENT's high-water mark. DROP TABLE takes the sqlite_sequence row
  // with it, and copying rows back only pushes the counter to the highest id
  // PRESENT — so a table whose top rows were deleted (catalog sync prunes
  // models routinely) would start handing out ids it has already used. Stale
  // fallback_config / profile_models rows pointing at a deleted model would
  // then silently adopt an unrelated new one.
  const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'models'")
    .get() as { seq: number } | undefined;
  for (const child of children) {
    db.exec(`CREATE TEMP TABLE "_endpoint_identity_${child}" AS SELECT * FROM "${child}"`);
    db.exec(`DELETE FROM "${child}"`);
  }

  db.exec(`
    CREATE TABLE models_endpoint_identity (${MODELS_COLUMNS}${extraColumns},
      ${unique}
    );
    INSERT INTO models_endpoint_identity (${copiedColumns})
      SELECT ${selectedColumns} FROM models;
    DROP TABLE models;
    ALTER TABLE models_endpoint_identity RENAME TO models;
  `);

  if (seqRow) {
    // sqlite_sequence has no unique index, so no upsert: update the row the
    // rename carried over, or re-create it if the table was empty.
    const restored = db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'models' AND seq < ?")
      .run(seqRow.seq, seqRow.seq);
    if (restored.changes === 0
      && !db.prepare("SELECT 1 FROM sqlite_sequence WHERE name = 'models'").get()) {
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('models', ?)").run(seqRow.seq);
    }
  }

  for (const child of children) {
    db.exec(`INSERT INTO "${child}" SELECT * FROM "_endpoint_identity_${child}"`);
    db.exec(`DROP TABLE "_endpoint_identity_${child}"`);
  }
}

export function up(db: Db): void {
  rebuildModels(
    db,
    `,\n      endpoint_scope TEXT NOT NULL DEFAULT ''`,
    CARRIED_COLUMNS + ', endpoint_scope',
    'UNIQUE(platform, model_id, endpoint_scope)',
    // This deployment historically keeps a model row per key. Preserve its
    // row ids and bindings. One row stays canonical; siblings receive a local
    // discriminator that identity/statistics helpers understand.
    CARRIED_COLUMNS + `, CASE
      WHEN platform = 'custom' THEN COALESCE((
        SELECT RTRIM(TRIM(base_url), '/') FROM api_keys
         WHERE api_keys.id = models.key_id AND api_keys.platform = 'custom'
      ), '') || CASE WHEN key_id IS NOT NULL AND id <> (
        SELECT MIN(peer.id) FROM models AS peer
        LEFT JOIN api_keys pk ON pk.id = peer.key_id AND pk.platform = 'custom'
         WHERE peer.platform = models.platform AND peer.model_id = models.model_id
           AND COALESCE(RTRIM(TRIM(pk.base_url), '/'), '') = COALESCE((
             SELECT RTRIM(TRIM(base_url), '/') FROM api_keys
              WHERE api_keys.id = models.key_id AND api_keys.platform = 'custom'
           ), '')
      ) THEN '#legacy-key:' || key_id ELSE '' END
      WHEN key_id IS NOT NULL AND id <> (
        SELECT MIN(peer.id) FROM models AS peer
         WHERE peer.platform = models.platform AND peer.model_id = models.model_id
      ) THEN 'legacy-key:' || key_id
      ELSE ''
    END`,
  );

  // Scopes were populated before the constrained INSERT above.

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_models_endpoint_scope
      ON models(endpoint_scope) WHERE endpoint_scope <> '';
  `);
}

export function down(db: Db): void {
  // Going back means two relays' copies of one model id would have to share a
  // row again, and there is no honest way to pick which endpoint's settings
  // survive. Refuse rather than silently discard one.
  const collisions = db.prepare(`
    SELECT platform, model_id, COUNT(*) AS n
      FROM models GROUP BY platform, model_id HAVING COUNT(*) > 1
  `).all() as { platform: string; model_id: string; n: number }[];
  if (collisions.length > 0) {
    const sample = collisions.slice(0, 3).map(c => `${c.platform}/${c.model_id} (${c.n})`).join(', ');
    throw new Error(
      `Cannot revert per-endpoint model identity: ${collisions.length} model id(s) exist on more than one endpoint — ${sample}. ` +
      'Delete the duplicate rows (or the extra endpoint) first.',
    );
  }

  db.exec('DROP INDEX IF EXISTS idx_models_endpoint_scope;');
  rebuildModels(db, '', CARRIED_COLUMNS, 'UNIQUE(platform, model_id)');
}
