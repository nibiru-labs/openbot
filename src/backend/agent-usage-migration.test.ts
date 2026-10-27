import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

describe("agent usage migration", () => {
  it("upgrades v14 without touching existing data and rolls back a failed migration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateOpenBotDatabase(db);
      // The tables that the migrations after 14 created go with their markers: a database from that
      // release never had them. The reserved schema check rejects a database that holds the tables
      // of a later release under the marker of an earlier one, so the fixture has to look like the
      // release it claims to be. The migrations that create these tables run again below.
      db.exec(
        `DROP TABLE agent_usage_records;
        DROP TABLE agent_usage_checkpoints;
        DROP TABLE agent_usage_activity;
        DROP TABLE projection_agent_threads;
        DROP TABLE routine_backoff;
        DROP TABLE browser_profiles;
        DROP TABLE workflow_output_deliveries;
        DROP TABLE workflow_steps;
        DROP TABLE workflow_runs;
        DROP TABLE workflow_webhook_receipts;
        DROP TABLE workflow_trigger_webhooks;
        DROP TABLE workflow_triggers;
        DROP TABLE workflow_versions;
        DROP TABLE workflow_edges;
        DROP TABLE workflow_nodes;
        DROP TABLE workflows;
        DELETE FROM schema_migrations WHERE version >= 15;
        CREATE TABLE preservation(value TEXT);
        INSERT INTO preservation VALUES ('keep');
        CREATE TABLE agent_usage_date (conflict TEXT)`,
      );
      // Every later version goes with 15: a history that keeps 16 but drops 15 has a gap,
      // which the schema check rejects before any upgrade runs.
      // The squatted name is the index's, not a table's: the migration creates its tables with
      // IF NOT EXISTS, and SQLite refuses an index whose name a table already holds however the
      // statement is spelled. What is under test is the rollback, not which object collides.
      expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 15 failed");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_usage_records'").get()).toBeUndefined();
      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 15").get()).toBeUndefined();
      db.exec("DROP TABLE agent_usage_date");
      migrateOpenBotDatabase(db);
      expect(db.prepare("SELECT value FROM preservation").get()).toMatchObject({ value: "keep" });
      // A host-wide report constrains the date alone, so it can only seek on an index that
      // leads with `occurred_at`. Without these a report scans all retained history, and
      // the parity check cannot notice: it compares the two build paths to each other.
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_occurred' ORDER BY name")
          .all(),
      ).toEqual([{ name: "agent_usage_activity_occurred" }, { name: "agent_usage_occurred" }]);
      expect(db.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
