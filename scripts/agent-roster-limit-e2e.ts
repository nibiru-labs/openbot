// Drives a real AgentStore and the agent import manifest decoder in temporary directories and
// checks the OPENBOT_AGENT_LIMIT roster limit: the default of 100, a raised limit, and the import
// manifest bound. No browser, provider or network is used.
// Run: bun scripts/agent-roster-limit-e2e.ts
// Artifact: .openbot-build/agent-roster-limit-e2e/report.json
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveAgentRosterLimit } from "@openbot/contracts/agent-roster-limits";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { decodeImportManifest } from "../src/main/agent-import-manifest";

const OUT = resolve(import.meta.dirname, "../.openbot-build/agent-roster-limit-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-agent-roster-limit-e2e-"));
const checks: Array<{ name: string; detail: string }> = [];

function check(name: string, detail: string) {
  checks.push({ name, detail });
  process.stdout.write(`- ${name}: ${detail}\n`);
}

async function makeStore(name: string): Promise<AgentStore> {
  const state = join(root, name, "state");
  const store = new AgentStore(state, join(root, name, "home"), new OpenBotDatabase(state));
  await runCauseEffect(store.initialize());
  return store;
}

async function createAgents(store: AgentStore, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await runCauseEffect(
      store.createAgent({ name: `Agent ${index}`, description: "", avatarSeed: `roster-${index}`, avatarHue: null }),
    );
  }
}

async function createOneMore(store: AgentStore): Promise<string> {
  try {
    await runCauseEffect(
      store.createAgent({ name: "One too many", description: "", avatarSeed: "roster-extra", avatarHue: null }),
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Creating one agent past the limit did not fail.");
}

let passed = false;
try {
  // The resolver: default, a raised value, the hard maximum, and unreadable values.
  assert.equal(resolveAgentRosterLimit(undefined), 100);
  assert.equal(resolveAgentRosterLimit("250"), 250);
  assert.equal(resolveAgentRosterLimit("2000"), 1000);
  assert.equal(resolveAgentRosterLimit("0"), 100);
  assert.equal(resolveAgentRosterLimit("-5"), 100);
  assert.equal(resolveAgentRosterLimit("10.5"), 100);
  assert.equal(resolveAgentRosterLimit("many"), 100);
  check("resolver", "unset 100, 250 stays, 2000 clamps to 1000, unreadable values keep 100");

  // A host with no setting holds 100 agents and refuses the next one.
  delete process.env.OPENBOT_AGENT_LIMIT;
  const defaultStore = await makeStore("default");
  await createAgents(defaultStore, 100);
  const defaultFailure = await createOneMore(defaultStore);
  assert.equal(defaultFailure, "A host can have up to 100 agents.");
  check("default limit", "100 agents created, the 101st fails with the limit in the message");

  // A host with OPENBOT_AGENT_LIMIT=103 holds 103 and refuses the next one.
  process.env.OPENBOT_AGENT_LIMIT = "103";
  const raisedStore = await makeStore("raised");
  await createAgents(raisedStore, 103);
  const raisedFailure = await createOneMore(raisedStore);
  assert.equal(raisedFailure, "A host can have up to 103 agents.");
  check("raised limit", "103 agents created, the 104th fails with the limit in the message");

  // The import manifest enforces the same limit before it decodes any agent.
  const exportBytes = new TextEncoder().encode(
    JSON.stringify({
      format: "openbot-agent-import",
      version: 1,
      source: { app: "OpenBot", exportedAt: null },
      agents: Array.from({ length: 101 }, () => ({})),
    }),
  );
  delete process.env.OPENBOT_AGENT_LIMIT;
  assert.throws(() => decodeImportManifest(exportBytes, 64), /more than 100 agents/);
  process.env.OPENBOT_AGENT_LIMIT = "150";
  assert.throws(
    () => decodeImportManifest(exportBytes, 64),
    (error: unknown) => !(error instanceof Error && error.message.includes("more than 150 agents")),
  );
  check("import manifest", "101 agents fail at the default limit and pass the count check at 150");
  passed = true;
} finally {
  delete process.env.OPENBOT_AGENT_LIMIT;
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
