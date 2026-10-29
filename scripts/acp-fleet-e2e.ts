import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentClient } from "../src/backend/agent-client";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { getRecord, getString } from "../src/backend/protocol";
import { NO_PROVIDER_CREDENTIALS, requireProviderDriver } from "../src/backend/provider-drivers";
import { installFakeAgent, runTurn, startThread, stopClients } from "./provider-fakes/host";

const root = await mkdtemp(join(tmpdir(), "openbot-acp-fleet-e2e-"));
const journal = join(root, "journal");
const held = join(root, "held");
const coordinator = join(root, "coordinator.mjs");
const log = join(root, "coordinator.log");
const reportDirectory = resolve(import.meta.dirname, "../.openbot-build/acp-fleet-e2e");
const clients: AgentClient[] = [];
const checks: string[] = [];
let agyClient: AgentClient | undefined;
let agyThread: string | undefined;
await mkdir(held);
await writeFile(
  coordinator,
  `
import { readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const request = JSON.parse(readFileSync(0, 'utf8'));
const path = join(process.argv[2], request.run_id);
appendFileSync(process.argv[3], JSON.stringify({op:request.op, backend:request.backend ?? null}) + '\\n');
if (request.op === 'acquire') {
  writeFileSync(path, 'held', {flag:'wx'});
  process.stdout.write(JSON.stringify({ok:true, admitted:true}));
} else {
  unlinkSync(path);
  process.stdout.write(JSON.stringify({ok:true, released:true}));
}
`,
);
const config = join(root, "config.json");
await writeFile(
  config,
  JSON.stringify({ journalDirectory: journal, command: [process.execPath, coordinator, held, log] }),
);
process.env.OPENBOT_FLEET_CAPACITY_CONFIG = config;
try {
  for (const provider of ["cursor", "antigravity"] as const) {
    const executable = join(root, provider, "agent");
    await installFakeAgent(executable, "conformance", {
      FAKE_MISSING: provider,
      ...(provider === "antigravity" ? { FAKE_IGNORE_CANCEL: "1" } : {}),
    });
    const client = requireProviderDriver(provider).createClient(
      { executable, version: "1.4.1", source: "managed" },
      10_000,
      NO_PROVIDER_CREDENTIALS,
    );
    clients.push(client);
    client.start();
    const thread = await startThread(client, { cwd: root });
    if (provider === "antigravity") {
      agyClient = client;
      agyThread = thread;
    }
    const result = await runTurn(client, thread, { text: "hello", timeoutMs: 10_000 });
    assert.equal(result.status, "completed");
    const deadline = Date.now() + 10_000;
    while ((await readdir(held)).length) {
      if (Date.now() > deadline) throw new Error(`${provider} reservation did not release.`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(client.readUsageText);
    const answer = await runCauseEffect(client.readUsageText("fake-alpha", "private usage probe"));
    assert.ok(answer);
    assert.deepEqual(await readdir(held), []);
    const entries = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const backend = provider === "cursor" ? "cursor" : "agy";
    assert.equal(entries.filter((entry) => entry.op === "acquire" && entry.backend === backend).length, 2);
    checks.push(`${provider} holds admission for both a turn and a private usage prompt`);
  }
  assert.ok(agyClient && agyThread);
  const ended = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Antigravity cancellation did not finish locally.")), 10_000);
    agyClient?.on("notification", (event) => {
      if (event.method === "turn/completed" && getString(event.params, "threadId") === agyThread) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const started = await runCauseEffect(
    agyClient.request(
      "turn/start",
      {
        threadId: agyThread,
        input: [{ type: "text", text: "wait", text_elements: [] }],
      },
      (value) => value,
    ),
  );
  const turnId = getString(getRecord(started, "turn"), "id");
  assert.ok(turnId);
  await runCauseEffect(agyClient.request("turn/interrupt", { threadId: agyThread, turnId }, (value) => value));
  await ended;
  assert.equal((await readdir(held)).length, 1);
  assert.equal((await readdir(journal)).length, 1);
  checks.push("a locally abandoned Antigravity prompt retains its reservation");
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
