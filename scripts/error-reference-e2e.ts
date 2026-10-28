// Checks that backend domain failures keep a public error code through `runCauseEffect` and agent
// error events. Writes .openbot-build/error-reference-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { errorReference, referenceCarrierName } from "@openbot/user-errors";
import { Effect } from "effect";
import { AgentLifecycleFailed } from "../src/backend/agent-service";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { storedSync } from "../src/backend/stored-state-effects";
import { decodeScopedAgentEvent } from "../src/preload/agent-event-decoding";

const OUT = resolve(import.meta.dirname, "../.openbot-build/error-reference-e2e");

function withReference(error: Error): Error {
  const reference = errorReference(error);
  if (!reference) return error;
  const carried = new Error(error.message, { cause: error });
  carried.name = referenceCarrierName(reference);
  return carried;
}

interface Report {
  passed: boolean;
  runCauseEffectReference: string | null;
  ipcCarrierName: string;
  agentEventReference: string;
}

const report: Report = {
  passed: false,
  runCauseEffectReference: null,
  ipcCarrierName: "",
  agentEventReference: "",
};

try {
  const operation = storedSync(() => {
    throw new Error("The host is busy.");
  });
  let thrown: unknown;
  try {
    await runCauseEffect(operation);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "runCauseEffect rejects with the wrapped failure.");
  report.runCauseEffectReference = errorReference(thrown);
  assert.equal(report.runCauseEffectReference, "error/StoredStateFailure");

  const carried = withReference(thrown);
  report.ipcCarrierName = carried.name;
  assert.equal(String(carried), "Error[ref:error/StoredStateFailure]: The host is busy.");

  const tagged = new AgentLifecycleFailed({ operation: "getUsage", cause: new Error("Usage read failed.") });
  const reference = errorReference(tagged.cause);
  assert.equal(reference, null, "A raw cause has no code until runCauseEffect copies the tag.");
  const taggedOperation = Effect.fail(tagged);
  let lifecycleThrown: unknown;
  try {
    await runCauseEffect(taggedOperation);
  } catch (error) {
    lifecycleThrown = error;
  }
  assert.equal(errorReference(lifecycleThrown), "error/AgentLifecycleFailed");

  const agentEvent = {
    serverId: "local",
    event: {
      type: "error" as const,
      agentId: "agent-1",
      code: "usage_limit_hold_failed",
      message: "Could not hold usage.",
      reference: "error/AgentLifecycleFailed",
    },
  };
  const decoded = decodeScopedAgentEvent(agentEvent);
  assert.equal(decoded.event.type, "error");
  if (decoded.event.type !== "error") throw new Error("Expected an agent error event.");
  report.agentEventReference = decoded.event.reference ?? "";
  assert.equal(report.agentEventReference, "error/AgentLifecycleFailed");

  report.passed = true;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exit(1);
