import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
await mkdir(held);
await writeFile(
  coordinator,
  `
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const request = JSON.parse(readFileSync(0, 'utf8'));
const path = join(process.argv[2], request.run_id);
if (request.op === 'acquire') {
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
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line), threadId = request.params.threadId;
  if (threadId === 'missing') return send({id:request.id, result:{}});
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

  await assert.rejects(Effect.runPromise(client.request("turn/start", { threadId: "missing" }, decodeRecordResponse)));
  assert.equal(gate.recoveryRequired, true);
  assert.equal((await readdir(held)).length, 1);
  assert.equal((await readdir(journal)).length, 1);
  checks.push("missing provider confirmation retains the coordinator slot");

  const directory = join(process.cwd(), ".openbot-build", "app-server-fleet-e2e");
  await mkdir(directory, { recursive: true });
  const output = join(directory, "report.json");
  await writeFile(output, `${JSON.stringify({ passed: true, checks }, null, 2)}\n`);
  process.stdout.write(`PASS ${output}\n`);
} finally {
  await Effect.runPromise(client.stop());
  await rm(root, { recursive: true, force: true });
}
