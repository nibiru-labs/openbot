// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

function seedApplicationData(db: DatabaseSync): void {
  db.exec(`INSERT INTO orchestration_events
      (event_id, command_id, aggregate_type, aggregate_id, event_type, occurred_at, payload_json)
    VALUES ('event-1', 'command-1', 'thread', 'thread-1', 'conversation.snapshot',
      '2026-10-01T10:00:00.000Z', '{"snapshot":{"messages":["hello"]}}');
    INSERT INTO orchestration_command_receipts (command_id, accepted_at, first_sequence, last_sequence, result_json)
      SELECT command_id, occurred_at, sequence, sequence, '{"ok":true}' FROM orchestration_events;
    INSERT INTO projection_threads (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('thread-1', 'agent-1', 'Chat', NULL, '2026-10-01', '2026-10-01', 1);
    INSERT INTO projection_thread_messages
      (thread_id, message_id, turn_id, author, status, item_type, created_at, ordinal, message_json, last_event_sequence)
    VALUES ('thread-1', 'message-1', NULL, 'user', 'completed', NULL, '2026-10-01', 0,
      '{"id":"message-1","text":"hello"}', 1);
    INSERT INTO projection_attachments
      (attachment_id, owner_kind, owner_id, name, path, metadata_json, created_at, last_event_sequence)
    VALUES ('attachment-1', 'draft', 'agent-1', 'notes.md', '/drafts/notes.md',
      '{"id":"attachment-1"}', '2026-10-01', 1);`);
}

const APPLICATION_TABLES = [
  "orchestration_events",
  "orchestration_command_receipts",
  "projection_threads",
  "projection_thread_messages",
  "projection_attachments",
] as const;

// Compare the columns that existed in the source schema, including columns later migrations add.
function applicationSnapshot(db: DatabaseSync) {
  return Object.fromEntries(
    APPLICATION_TABLES.map((table) => {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => String(column.name));
      return [table, { columns, rows: applicationRows(db, table, columns) }];
    }),
  );
}

function applicationRows(db: DatabaseSync, table: string, columns: string[]) {
  return db.prepare(`SELECT ${columns.map((column) => `"${column}"`).join(", ")} FROM ${table} ORDER BY rowid`).all();
}

function expectApplicationData(db: DatabaseSync, before: ReturnType<typeof applicationSnapshot>): void {
  for (const [table, { columns, rows }] of Object.entries(before)) {
    expect(applicationRows(db, table, columns)).toEqual(rows);
  }
}

it("preserves data and rolls back the hold table and marker before a retry", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TEMP TRIGGER stop_at_50 BEFORE INSERT ON schema_migrations WHEN new.version = 50
      BEGIN SELECT RAISE(ABORT, 'stop'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 50 failed");
    db.exec(`DROP TRIGGER stop_at_50;
      CREATE TABLE preservation(value TEXT);
      INSERT INTO preservation VALUES ('keep');`);
    seedApplicationData(db);
    const before = applicationSnapshot(db);
    db.exec(`CREATE TEMP TRIGGER fail_50 BEFORE INSERT ON schema_migrations WHEN new.version = 50
      BEGIN SELECT RAISE(ABORT, 'fail'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 50 failed");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'unknown_usage_holds'").get()).toBeUndefined();
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 50").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM preservation").all()).toEqual([{ value: "keep" }]);
    expectApplicationData(db, before);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec(`DROP TRIGGER fail_50;
      INSERT INTO projection_agents (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
      VALUES ('agent-1', NULL, 'gpt-5', '2026-10-01', 0, '{"id":"agent-1"}', 1);`);
    const agents = db.prepare("SELECT * FROM projection_agents").all();
    migrateOpenBotDatabase(db);
    expect(db.prepare("SELECT * FROM projection_agents").all()).toEqual(agents);
    expect(db.prepare("SELECT * FROM preservation").all()).toEqual([{ value: "keep" }]);
    expectApplicationData(db, before);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 50").get()).toEqual({ version: 50 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    db.close();
  }
});

it.each(Array.from({ length: 42 }, (_, index) => index + 8))(
  "preserves data from released schema %i through migration 50",
  (version) => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TEMP TRIGGER stop_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
        BEGIN SELECT RAISE(ABORT, 'stop'); END;`);
      expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
      db.exec(`DROP TRIGGER stop_version;
        CREATE TABLE preservation(value TEXT);
        INSERT INTO preservation VALUES ('keep');`);
      seedApplicationData(db);
      const before = applicationSnapshot(db);
      db.exec(`CREATE TEMP TRIGGER stop_50 BEFORE INSERT ON schema_migrations WHEN new.version = 50
        BEGIN SELECT RAISE(ABORT, 'stop'); END;`);
      expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 50 failed");
      db.exec("DROP TRIGGER stop_50");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'unknown_usage_holds'").get()).toBeUndefined();
      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 50").get()).toBeUndefined();
      expect(db.prepare("SELECT * FROM preservation").all()).toEqual([{ value: "keep" }]);
      expectApplicationData(db, before);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      migrateOpenBotDatabase(db);
      expect(db.prepare("SELECT * FROM preservation").all()).toEqual([{ value: "keep" }]);
      expectApplicationData(db, before);
      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 50").get()).toEqual({ version: 50 });
      expect(db.prepare("SELECT * FROM unknown_usage_holds").all()).toEqual([]);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      db.close();
    }
  },
);
