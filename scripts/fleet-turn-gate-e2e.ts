import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FleetTurnGate,
  type FleetTurnReservation,
  type FleetTurnTransport,
} from "../src/backend/agent/fleet-turn-gate";
import { runCauseEffect } from "../src/backend/effect-boundary";

// A separate coordinator process persists admission before replying. Its state is deliberately
// independent of the Hub process so a lost reply can be checked after the gate is restarted.
const root = await mkdtemp(join(tmpdir(), "openbot-fleet-e2e-"));
const coordinator = join(root, "coordinator.mjs");
const reservations = join(root, "reservations");
const journal = join(root, "journal");
const output = join(process.cwd(), ".openbot-build", "fleet-turn-gate-e2e", "report.json");
await mkdir(reservations);
await writeFile(
  coordinator,
  `
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const { operation, reservation, mode, directory } = JSON.parse(readFileSync(0, 'utf8'));
const path = join(directory, reservation.run_id);
if (operation === 'acquire') {
  if (mode === 'deny') { process.stdout.write(JSON.stringify({ admitted: false })); process.exit(0); }
  writeFileSync(path, 'held', { flag: 'wx', mode: 0o600 });
  if (mode === 'lost') process.exit(1);
  process.stdout.write(JSON.stringify({ admitted: true }));
} else {
  unlinkSync(path);
  process.stdout.write('{}');
}
`,
);

let mode = "normal";
function call(operation: string, reservation: FleetTurnReservation): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [coordinator], { stdio: ["pipe", "pipe", "ignore"] });
    let response = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      response += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(response) : reject(new Error("Coordinator response lost."))));
    child.stdin.end(JSON.stringify({ operation, reservation, mode, directory: reservations }));
  });
}
const transport: FleetTurnTransport = {
  acquire: async (reservation) => JSON.parse(await call("acquire", reservation)),
  release: async (reservation) => {
    await call("release", reservation);
  },
};
const checks: string[] = [];
try {
  const gate = await runCauseEffect(FleetTurnGate.open(journal, transport));
  assert.equal(await runCauseEffect(gate.begin("thread", "codex", null)), true);
  const [entry] = await readdir(journal);
  assert.ok(entry);
  assert.equal((await stat(join(journal, entry))).mode & 0o777, 0o600);
  gate.sent("thread");
  await runCauseEffect(gate.completed("thread", "current"));
  await runCauseEffect(gate.completed("thread", "old"));
  assert.equal((await readdir(reservations)).length, 1);
  await runCauseEffect(gate.started("thread", "current"));
  assert.deepEqual(await readdir(reservations), []);
  assert.deepEqual(await readdir(journal), []);
  checks.push("early matching completion survives a later stale completion");

  mode = "deny";
  assert.equal(await runCauseEffect(gate.begin("denied", "codex", null)), false);
  assert.deepEqual(await readdir(journal), []);
  checks.push("denial removes the local journal");

  mode = "lost";
  await assert.rejects(runCauseEffect(gate.begin("lost", "codex", null)), /response lost/);
  assert.equal((await readdir(reservations)).length, 1);
  assert.equal((await readdir(journal)).length, 1);
  const restarted = await runCauseEffect(FleetTurnGate.open(journal, transport));
  assert.equal(restarted.recoveryRequired, true);
  await assert.rejects(runCauseEffect(restarted.begin("other", "codex", null)), /requires recovery/);
  assert.equal((await readdir(reservations)).length, 1);
  checks.push("lost admission response retains the slot after restart");

  await mkdir(join(process.cwd(), ".openbot-build", "fleet-turn-gate-e2e"), { recursive: true });
  await writeFile(output, `${JSON.stringify({ passed: true, checks }, null, 2)}\n`);
  assert.equal(JSON.parse(await readFile(output, "utf8")).passed, true);
  process.stdout.write(`PASS ${output}\n`);
} catch (error) {
  await mkdir(join(process.cwd(), ".openbot-build", "fleet-turn-gate-e2e"), { recursive: true });
  await writeFile(output, `${JSON.stringify({ passed: false, checks, error: String(error) }, null, 2)}\n`);
  throw error;
} finally {
  await rm(root, { recursive: true, force: true });
}
