// Exercises a failed unknown-hold write on an isolated disk database and a fresh process.
// Run: bun scripts/usage-hold-write-fault-e2e.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { UsageLimitGate } from "../src/backend/agent/usage-limit-gate";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";

const agent = { id: "agent", provider: "codex" as const, model: "test-model" };
const results: { name: string; passed: boolean; detail: string }[] = [];
const path = process.argv[2];
const child = process.argv[3] === "restart";
if (child && !path) throw new Error("Restart requires a database path.");
const out = child ? "" : resolve(import.meta.dirname, `../.openbot-build/usage-hold-write-fault-${randomUUID()}`);
if (!child) mkdirSync(out, { recursive: true });
const db = new DatabaseSync(child && path ? path : join(out, "test.db"));
if (!child) migrateOpenBotDatabase(db);
let timers = 0;
let held = 0;
let snapshots = 0;
let events = 0;
const gate = new UsageLimitGate({
  store: { list: () => [agent] },
  database: () => db,
  timers: {
    now: () => 1_000,
    set: () => {
      timers++;
      const timer = setTimeout(() => {}, 600_000);
      timer.unref();
      return timer;
    },
    clear: clearTimeout,
  },
  hooks: {
    emit: () => {
      events++;
    },
    emitRuntimeSnapshot: () => {
      snapshots++;
    },
    scheduleDrain: () => {},
    readUsage: () => Effect.succeed(null),
    held: () =>
      Effect.sync(() => {
        held++;
      }),
    released: () => Effect.void,
  },
});

if (child) {
  gate.restore();
  process.stdout.write(JSON.stringify({ mayDrain: gate.mayDrain(agent.id), timers }));
  await Effect.runPromise(gate.dispose());
  db.close();
} else {
  const check = (name: string, test: () => void) => {
    try {
      test();
      results.push({ name, passed: true, detail: "ok" });
    } catch (error) {
      results.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };
  db.exec(
    "CREATE TRIGGER reject_hold BEFORE INSERT ON unknown_usage_holds BEGIN SELECT RAISE(ABORT, 'injected hold write failure'); END",
  );
  let failure: unknown;
  try {
    await Effect.runPromise(gate.reached(agent.id, null, agent.model));
  } catch (error) {
    failure = error;
  }
  check("SQLite rejects the hold and leaves no persisted row", () => {
    assert.match(String(failure), /injected hold write failure/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM unknown_usage_holds").get()?.n, 0);
  });
  check("a failed write rolls back the in-memory hold", () => assert.equal(gate.mayDrain(agent.id), true));
  check("a failed write starts no timer and emits no notifications", () => {
    assert.deepEqual({ timers, held, snapshots, events }, { timers: 0, held: 0, snapshots: 0, events: 0 });
  });
  const restarted = spawnSync(process.execPath, [import.meta.path, join(out, "test.db"), "restart"], {
    encoding: "utf8",
  });
  check("a fresh process reads the rolled-back database", () => {
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(JSON.parse(restarted.stdout), { mayDrain: true, timers: 0 });
  });
  db.exec("DROP TRIGGER reject_hold");
  await Effect.runPromise(gate.reached(agent.id, null, agent.model));
  check("retry persists the hold", () => {
    assert.equal(db.prepare("SELECT count(*) AS n FROM unknown_usage_holds").get()?.n, 1);
  });
  check("retry starts a timer", () => assert.equal(timers, 1));
  await Effect.runPromise(gate.dispose());
  db.close();
  writeFileSync(join(out, "report.json"), `${JSON.stringify({ results }, null, 2)}\n`);
  for (const result of results)
    process.stdout.write(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}\n`);
  process.stdout.write(`Report: ${join(out, "report.json")}\n`);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}
