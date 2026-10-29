import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { FleetTurnGate } from "../src/backend/agent/fleet-turn-gate";
import { FleetTurnCommandTransport } from "../src/backend/agent/fleet-turn-transport";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { decodeRecordResponse } from "../src/backend/protocol";

const root = await mkdtemp(join(tmpdir(), "openbot-codex-fleet-e2e-"));
const executable = join(root, "codex");
const coordinator = join(root, "coordinator.mjs");
const held = join(root, "held");
const journal = join(root, "journal");
const requests = join(root, "provider-requests.log");
await mkdir(held);
await writeFile(
  coordinator,
  `
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const request = JSON.parse(readFileSync(0, 'utf8'));
const path = join(process.argv[2], request.run_id);
if (request.op === 'acquire') {
  if (existsSync(join(process.argv[2], 'deny'))) {
    writeFileSync(join(process.argv[2], 'denied'), 'observed');
    process.stdout.write(JSON.stringify({ok:true, admitted:false}));
    process.exit(0);
  }
  writeFileSync(path, 'held', {flag:'wx', mode:0o600});
  process.stdout.write(JSON.stringify({ok:true, admitted:true}));
} else {
  unlinkSync(path);
  process.stdout.write(JSON.stringify({ok:true, released:true}));
}
`,
);
await writeFile(
  executable,
  `#!/usr/bin/env node
const readline = require('node:readline');
const { appendFileSync } = require('node:fs');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line), threadId = request.params.threadId;
  appendFileSync(${JSON.stringify(requests)}, request.method + '\\n');
  if (threadId === 'missing') return send({id:request.id, result:{}});
  if (threadId === 'archived') return send({id:request.id, error:{code:-32600, message:'thread is archived'}});
  if (threadId === 'wrong-before') {
    send({method:'turn/started', params:{threadId, turn:{id:'other'}}});
    return send({id:request.id, result:{turn:{id:'current'}}});
  }
  if (threadId === 'wrong-after') {
    send({id:request.id, result:{turn:{id:'current'}}});
    return send({method:'turn/started', params:{threadId, turn:{id:'other'}}});
  }
  if (threadId === 'compact') {
    send({method:'turn/started', params:{threadId, turn:{id:'compact-turn'}}});
    send({method:'turn/completed', params:{threadId, turn:{id:'compact-turn'}}});
    return send({id:request.id, result:{}});
  }
  if (threadId === 'early') {
    send({method:'turn/started', params:{threadId, turn:{id:'current'}}});
    send({method:'turn/completed', params:{threadId, turn:{id:'current'}}});
    send({method:'turn/completed', params:{threadId, turn:{id:'old'}}});
  }
  send({id:request.id, result:{turn:{id:'current'}}});
});
`,
);
await chmod(executable, 0o700);
const transport = new FleetTurnCommandTransport(process.execPath, [coordinator, held]);
const gate = await runCauseEffect(FleetTurnGate.open(journal, transport));
const client = new CodexAppServerClient(executable, 5_000, undefined, gate);
const checks: string[] = [];
client.start();
try {
  await Effect.runPromise(client.request("turn/start", { threadId: "early" }, decodeRecordResponse));
  assert.deepEqual(await readdir(held), []);
  assert.deepEqual(await readdir(journal), []);
  checks.push("early completion and a stale completion release the correct slot");

  await assert.rejects(Effect.runPromise(client.request("turn/start", { threadId: "archived" }, decodeRecordResponse)));
  assert.deepEqual(await readdir(held), []);
  assert.deepEqual(await readdir(journal), []);
  assert.equal(gate.recoveryRequired, false);
  checks.push("an explicitly archived thread releases the refused admission");

  await Effect.runPromise(client.request("thread/compact/start", { threadId: "compact" }, decodeRecordResponse));
  assert.deepEqual(await readdir(held), []);
  assert.deepEqual(await readdir(journal), []);
  checks.push("compaction completion before its empty response releases the matching slot");

  await assert.rejects(Effect.runPromise(client.request("turn/start", { threadId: "missing" }, decodeRecordResponse)));
  assert.equal(gate.recoveryRequired, true);
  assert.equal((await readdir(held)).length, 1);
  assert.equal((await readdir(journal)).length, 1);
  checks.push("missing provider confirmation retains the coordinator slot");

  for (const scenario of ["wrong-before", "wrong-after"]) {
    const scenarioHeld = join(root, `${scenario}-held`);
    const scenarioJournal = join(root, `${scenario}-journal`);
    await mkdir(scenarioHeld);
    const scenarioGate = await runCauseEffect(
      FleetTurnGate.open(scenarioJournal, new FleetTurnCommandTransport(process.execPath, [coordinator, scenarioHeld])),
    );
    const scenarioClient = new CodexAppServerClient(executable, 5_000, undefined, scenarioGate);
    scenarioClient.start();
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Provider did not stop after a mismatched start.")), 5_000);
      scenarioClient.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      await Effect.runPromise(scenarioClient.request("turn/start", { threadId: scenario }, decodeRecordResponse)).catch(
        () => {},
      );
      await exited;
      assert.equal(scenarioGate.recoveryRequired, true);
      assert.equal((await readdir(scenarioHeld)).length, 1);
      assert.equal((await readdir(scenarioJournal)).length, 1);
    } finally {
      await Effect.runPromise(scenarioClient.stop());
    }
  }
  checks.push("a mismatched start before or after the response stops the provider and retains admission");

  const busyHeld = join(root, "busy-held");
  const busyJournal = join(root, "busy-journal");
  await mkdir(busyHeld);
  await writeFile(join(busyHeld, "deny"), "");
  const busyGate = await runCauseEffect(
    FleetTurnGate.open(busyJournal, new FleetTurnCommandTransport(process.execPath, [coordinator, busyHeld])),
  );
  const busyClient = new CodexAppServerClient(executable, 5_000, undefined, busyGate);
  busyClient.start();
  const compactWaiting = Effect.runPromise(
    busyClient.request("thread/compact/start", { threadId: "busy-compact" }, decodeRecordResponse),
  );
  compactWaiting.catch(() => {});
  const compactDeadline = Date.now() + 5_000;
  while (!(await readdir(busyHeld)).includes("denied")) {
    if (Date.now() > compactDeadline) throw new Error("The coordinator did not observe the compaction wait.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(busyClient.cancelPendingCompaction("busy-compact"), true);
  await assert.rejects(compactWaiting);
  assert.deepEqual(await readdir(busyJournal), []);
  const observed = await readFile(requests, "utf8");
  assert.equal(observed.split("\n").filter((name) => name === "thread/compact/start").length, 1);
  checks.push("a cancelled pending compaction never reaches the provider");
  await rm(join(busyHeld, "denied"));
  const waiting = Effect.runPromise(busyClient.request("turn/start", { threadId: "busy" }, decodeRecordResponse));
  waiting.catch(() => {});
  try {
    const deadline = Date.now() + 5_000;
    while (!(await readdir(busyHeld)).includes("denied")) {
      if (Date.now() > deadline) throw new Error("The coordinator did not observe the admission wait.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await Effect.runPromise(busyClient.stop());
    await assert.rejects(waiting);
    assert.deepEqual(await readdir(busyJournal), []);
    assert.equal(busyGate.recoveryRequired, false);
  } finally {
    await Effect.runPromise(busyClient.stop());
  }
  checks.push("stopping a client cancels its admission wait without leaking a slot");

  const directory = join(process.cwd(), ".openbot-build", "app-server-fleet-e2e");
  await mkdir(directory, { recursive: true });
  const output = join(directory, "report.json");
  await writeFile(output, `${JSON.stringify({ passed: true, checks }, null, 2)}\n`);
  process.stdout.write(`PASS ${output}\n`);
} catch (error) {
  const directory = join(process.cwd(), ".openbot-build", "app-server-fleet-e2e");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "report.json"),
    `${JSON.stringify({ passed: false, checks, error: String(error) }, null, 2)}\n`,
  );
  throw error;
} finally {
  await Effect.runPromise(client.stop());
  await rm(root, { recursive: true, force: true });
}
