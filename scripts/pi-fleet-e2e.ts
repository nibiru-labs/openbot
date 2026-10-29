import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentClient } from "../src/backend/agent-client";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { getRecord, getString } from "../src/backend/protocol";
import { requireProviderDriver } from "../src/backend/provider-drivers";
import { installFakeAgent, startThread, stopClients } from "./provider-fakes/host";

const root = await mkdtemp(join(tmpdir(), "openbot-pi-fleet-e2e-"));
const journal = join(root, "journal");
const held = join(root, "held");
const config = join(root, "config.json");
const coordinator = join(root, "coordinator.mjs");
const executable = join(root, "bin", "pi");
const reportDirectory = resolve(import.meta.dirname, "../.openbot-build/pi-fleet-e2e");
const clients: AgentClient[] = [];
const checks: string[] = [];
await mkdir(held);
await writeFile(
  coordinator,
  `
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const request = JSON.parse(readFileSync(0, 'utf8'));
const path = join(process.argv[2], request.run_id);
if (request.op === 'acquire') {
  if (request.backend !== 'pi' || request.provider !== 'minimax-cn') process.exit(4);
  writeFileSync(path, 'held', { flag: 'wx' });
  if (existsSync(join(process.argv[2], 'lose-response'))) process.exit(1);
  process.stdout.write(JSON.stringify({ok:true, admitted:true}));
} else {
  unlinkSync(path);
  process.stdout.write(JSON.stringify({ok:true, released:true}));
}
`,
);
await writeFile(config, JSON.stringify({ journalDirectory: journal, command: [process.execPath, coordinator, held] }));
process.env.OPENBOT_FLEET_CAPACITY_CONFIG = config;
await installFakeAgent(executable, "pi-steer", { FAKE_LOG: join(root, "pi.log"), FAKE_DIR: root });

try {
  const client = requireProviderDriver("deepseek").createClient(
    { executable, version: "1.4.0", source: "managed" },
    5_000,
    { apiKey: () => null, customProviders: () => [], mcpServers: () => [] },
  );
  clients.push(client);
  client.start();
  const thread = await startThread(client, { cwd: root });
  let completed: (() => void) | undefined;
  const done = new Promise<void>((finish) => {
    completed = finish;
  });
  client.on("notification", (notification) => {
    if (notification.method === "turn/completed" && getString(notification.params, "threadId") === thread)
      completed?.();
  });
  const response = await runCauseEffect(
    client.request(
      "turn/start",
      {
        threadId: thread,
        input: [{ type: "text", text: "work", text_elements: [] }],
      },
      (value) => value,
    ),
  );
  const turnId = getString(getRecord(response, "turn"), "id");
  assert.ok(turnId);
  assert.equal((await readdir(held)).length, 1);
  await runCauseEffect(
    client.request(
      "turn/steer",
      {
        threadId: thread,
        expectedTurnId: turnId,
        input: [{ type: "text", text: "finish", text_elements: [] }],
      },
      (value) => value,
    ),
  );
  await done;
  const deadline = Date.now() + 10_000;
  while ((await readdir(held)).length) {
    if (Date.now() > deadline) throw new Error("Pi reservation did not release.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  checks.push("Pi holds admission throughout a real adapter turn and steer");
  await runCauseEffect(client.request("thread/compact/start", { threadId: thread }, (value) => value));
  assert.deepEqual(await readdir(held), []);
  assert.deepEqual(await readdir(journal), []);
  checks.push("Pi compaction releases admission after the RPC acknowledges completion");
  await writeFile(join(held, "lose-response"), "");
  await assert.rejects(
    runCauseEffect(
      client.request(
        "turn/start",
        {
          threadId: thread,
          input: [{ type: "text", text: "not-sent", text_elements: [] }],
        },
        (value) => value,
      ),
    ),
  );
  assert.equal((await readdir(journal)).length, 1);
  const log = await readFile(join(root, "pi.log"), "utf8");
  assert.equal(log.includes("not-sent"), false);
  checks.push("a lost admission response retains its journal and never sends the Pi prompt");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, "report.json"), `${JSON.stringify({ passed: true, checks }, null, 2)}\n`);
  process.stdout.write(`PASS ${join(reportDirectory, "report.json")}\n`);
} catch (error) {
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    join(reportDirectory, "report.json"),
    `${JSON.stringify({ passed: false, checks, error: String(error) }, null, 2)}\n`,
  );
  throw error;
} finally {
  await stopClients(clients);
  await rm(root, { recursive: true, force: true });
}
