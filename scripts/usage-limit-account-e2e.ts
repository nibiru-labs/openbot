// Drives the real usage-limit gate with an in-memory agent list and a no-op provider boundary.
// A plan refusal on one model must hold every agent on the same provider account, not only
// the agents on that model. Another account and another provider stay free.
//
// Run: bun scripts/usage-limit-account-e2e.ts
// It writes .openbot-build/usage-limit-account-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { UsageLimitGate } from "../src/backend/agent/usage-limit-gate";
import type { AgentProvider } from "../src/backend/agent-client";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "usage-limit-account-e2e");

interface FixtureAgent {
  id: string;
  provider: AgentProvider;
  providerAccountId: string;
  model: string;
}

const agents: FixtureAgent[] = [
  { id: "a-fast", provider: "codex", providerAccountId: "acc-1", model: "model-fast" },
  { id: "a-large", provider: "codex", providerAccountId: "acc-1", model: "model-large" },
  { id: "a-other-account", provider: "codex", providerAccountId: "acc-2", model: "model-fast" },
  { id: "a-other-provider", provider: "claude", providerAccountId: "acc-1", model: "model-fast" },
];

const store = { list: () => agents };

const gate = new UsageLimitGate({
  store,
  hooks: {
    emit: () => {},
    emitRuntimeSnapshot: () => {},
    scheduleDrain: () => {},
    readUsage: () => Effect.succeed(null),
    held: () => Effect.void,
    released: () => Effect.void,
  },
});

const cases: { name: string; passed: boolean; detail: string }[] = [];

function check(name: string, condition: () => void): void {
  try {
    condition();
    cases.push({ name, passed: true, detail: "ok" });
  } catch (error) {
    cases.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

const resetInSeconds = Math.floor(Date.now() / 1_000) + 3_600;

check("every agent may drain before any refusal", () => {
  for (const agent of agents) assert.equal(gate.mayDrain(agent.id), true, agent.id);
});

await Effect.runPromise(gate.reached("a-fast", resetInSeconds, "model-fast"));

check("refusal on one model holds the other model on the same account", () => {
  assert.equal(gate.mayDrain("a-large"), false);
});
check("refusal holds the agent that was refused", () => {
  assert.equal(gate.mayDrain("a-fast"), false);
});
check("another provider account is not held", () => {
  assert.equal(gate.mayDrain("a-other-account"), true);
});
check("another provider is not held", () => {
  assert.equal(gate.mayDrain("a-other-provider"), true);
});

await Effect.runPromise(gate.completed("a-large"));

check("a completed turn on the account ends the account hold", () => {
  assert.equal(gate.mayDrain("a-fast"), true);
  assert.equal(gate.mayDrain("a-large"), true);
});

gate.dispose();

const passed = cases.every((item) => item.passed);
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.json"), `${JSON.stringify({ passed, cases }, null, 2)}\n`);
process.stdout.write(`${passed ? "PASS" : "FAIL"}: report in ${join(OUT, "report.json")}\n`);
if (!passed) process.exitCode = 1;
