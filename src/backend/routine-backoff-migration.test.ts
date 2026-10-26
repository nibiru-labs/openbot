// @vitest-environment node
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: an upgrade loses or changes an agent routine or its trigger; the new table is missing
// on an upgraded database; a backoff row survives its deleted routine; a row with a zero streak or a
// negative step is accepted; a retry of the migration fails because the table already exists.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** The schema as of `version`, with the migration to the next version refused by a trigger. */
function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
  return db;
}

/** One agent routine with a daily trigger, in the columns every released version has. */
function seedRoutine(db: DatabaseSync): void {
  const stamp = "2026-10-01T07:00:00.000Z";
  db.prepare(
    `INSERT INTO projection_agent_routines (routine_id, agent_id, name, instruction, active, timezone, created_at,
       updated_at, last_event_sequence) VALUES ('routine-1', 'agent-1', 'Morning brief', 'Collect the news.', 1,
       'Europe/Warsaw', ?, ?, 1)`,
  ).run(stamp, stamp);
  db.prepare(
    `INSERT INTO projection_routine_triggers (trigger_id, routine_id, schedule_json, next_run_at, created_at,
       updated_at, last_event_sequence) VALUES ('trigger-1', 'routine-1', '{"kind":"daily","time":"09:00"}',
       '2026-10-02T07:00:00.000Z', ?, ?, 2)`,
  ).run(stamp, stamp);
}

type TableRow = Record<string, SQLOutputValue>;

function rows(db: DatabaseSync, table: string): TableRow[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function pick(list: TableRow[], columns: string[]): TableRow[] {
  return list.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
}

/** The released versions whose routines the upgrade reads: the baseline, and each later table change. */
const RELEASED_VERSIONS = [8, 19, 37, 44];

describe("routine backoff migration", () => {
  for (const version of RELEASED_VERSIONS) {
    it(`keeps the routines of a version ${version} database and adds an empty backoff table`, () => {
      const db = databaseAt(version);
      seedRoutine(db);
      // Upgrades add columns to old rows, so only the columns every version has are compared.
      const before = {
        routines: pick(rows(db, "projection_agent_routines"), [
          "routine_id",
          "agent_id",
          "name",
          "instruction",
          "active",
          "timezone",
        ]),
        triggers: pick(rows(db, "projection_routine_triggers"), [
          "trigger_id",
          "routine_id",
          "schedule_json",
          "next_run_at",
        ]),
      };

      migrateOpenBotDatabase(db);

      expect(pick(rows(db, "projection_agent_routines"), Object.keys(before.routines[0] ?? {}))).toEqual(
        before.routines,
      );
      expect(pick(rows(db, "projection_routine_triggers"), Object.keys(before.triggers[0] ?? {}))).toEqual(
        before.triggers,
      );
      expect(rows(db, "routine_backoff")).toEqual([]);
      expect(db.prepare("SELECT MAX(version) AS latest FROM schema_migrations").get()).toEqual({ latest: 45 });
    });
  }

  it("cascades a backoff row with its routine and rejects impossible values", () => {
    const db = databaseAt(44);
    seedRoutine(db);
    migrateOpenBotDatabase(db);
    db.exec("PRAGMA foreign_keys = ON");
    const stamp = "2026-10-21T00:00:00.000Z";
    db.prepare(
      "INSERT INTO routine_backoff (routine_id, fingerprint, streak, backoff_steps, backoff_until, updated_at) VALUES ('routine-1', 'a', 3, 1, NULL, ?)",
    ).run(stamp);

    expect(() =>
      db
        .prepare(
          "INSERT INTO routine_backoff (routine_id, fingerprint, streak, backoff_steps, backoff_until, updated_at) VALUES ('routine-2', 'a', 0, 0, NULL, ?)",
        )
        .run(stamp),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE routine_backoff SET backoff_steps = -1 WHERE routine_id = 'routine-1'").run(),
    ).toThrow();

    db.prepare("DELETE FROM projection_agent_routines WHERE routine_id = 'routine-1'").run();
    expect(rows(db, "routine_backoff")).toEqual([]);
  });

  it("is not applied twice when the migration runs again on an upgraded database", () => {
    const db = databaseAt(44);
    seedRoutine(db);
    migrateOpenBotDatabase(db);

    expect(() => migrateOpenBotDatabase(db)).not.toThrow();
    expect(rows(db, "projection_agent_routines")).toHaveLength(1);
  });
});
