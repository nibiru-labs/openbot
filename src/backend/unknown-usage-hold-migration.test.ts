// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

it("preserves data and rolls back the hold table and marker before a retry", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TEMP TRIGGER stop_at_50 BEFORE INSERT ON schema_migrations WHEN new.version = 50
      BEGIN SELECT RAISE(ABORT, 'stop'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 50 failed");
    db.exec(`DROP TRIGGER stop_at_50;
      CREATE TABLE preservation(value TEXT);
      INSERT INTO preservation VALUES ('keep');
      CREATE TEMP TRIGGER fail_50 BEFORE INSERT ON schema_migrations WHEN new.version = 50
      BEGIN SELECT RAISE(ABORT, 'fail'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 50 failed");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'unknown_usage_holds'").get()).toBeUndefined();
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 50").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM preservation").all()).toEqual([{ value: "keep" }]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec(`DROP TRIGGER fail_50;
      INSERT INTO projection_agents (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
      VALUES ('agent-1', NULL, 'gpt-5', '2026-10-01', 0, '{"id":"agent-1"}', 1);`);
    const agents = db.prepare("SELECT * FROM projection_agents").all();
    migrateOpenBotDatabase(db);
    expect(db.prepare("SELECT * FROM projection_agents").all()).toEqual(agents);
    expect(db.prepare("SELECT * FROM preservation").all()).toEqual([{ value: "keep" }]);
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
        INSERT INTO preservation VALUES ('keep');
        CREATE TEMP TRIGGER stop_50 BEFORE INSERT ON schema_migrations WHEN new.version = 50
        BEGIN SELECT RAISE(ABORT, 'stop'); END;`);
      expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 50 failed");
      db.exec("DROP TRIGGER stop_50");
      expect(db.prepare("SELECT * FROM preservation").all()).toEqual([{ value: "keep" }]);
      migrateOpenBotDatabase(db);
      expect(db.prepare("SELECT * FROM preservation").all()).toEqual([{ value: "keep" }]);
      expect(db.prepare("SELECT * FROM unknown_usage_holds").all()).toEqual([]);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      db.close();
    }
  },
);
