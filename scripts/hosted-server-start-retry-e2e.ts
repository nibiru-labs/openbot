// Checks that automatic hosted-server start retries stop after five attempts and report exhaustion.
// Writes .openbot-build/hosted-server-start-retry-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { HostedServerStartRetry } from "../src/main/hosted-server-start-retry";
import { RemoteWorkflowError } from "../src/main/remote-service-effects";

const OUT = resolve(import.meta.dirname, "../.openbot-build/hosted-server-start-retry-e2e");
const START_FAILURE = new RemoteWorkflowError({ cause: new Error("Sign-in failed.") });

interface Report {
  passed: boolean;
  attempts: number;
  exhausted: boolean;
  exhaustedError: string | null;
  sixthTickAttempts: number;
}

const report: Report = {
  passed: false,
  attempts: 0,
  exhausted: false,
  exhaustedError: null,
  sixthTickAttempts: 0,
};

try {
  let phase: "error" | "online" = "error";
  let now = 0;
  let attempts = 0;
  let exhausted = false;
  let exhaustedError: unknown = null;

  const retry = new HostedServerStartRetry({
    hostPhase: () => phase,
    startHost: () => {
      attempts += 1;
      return Effect.fail(START_FAILURE);
    },
    onError: () => {},
    onExhausted: (error) => {
      exhausted = true;
      exhaustedError = error;
    },
    now: () => now,
  });

  for (let tick = 0; tick < 5; tick += 1) {
    now = (tick + 1) * 11 * 60_000;
    try {
      await runCauseEffect(retry.tick());
    } catch {
      // Each start attempt fails until retries end.
    }
  }

  assert.equal(attempts, 5, "Five start attempts run before exhaustion.");
  assert.equal(exhausted, true, "Exhaustion is reported after the last attempt.");
  assert.ok(exhaustedError instanceof Error, "The last failure is passed to onExhausted.");
  if (!(exhaustedError instanceof Error)) throw new Error("Expected an Error from onExhausted.");
  assert.equal(exhaustedError.message, "Sign-in failed.");

  const attemptsBeforeSixth = attempts;
  now = 6 * 11 * 60_000;
  await runCauseEffect(retry.tick());
  assert.equal(attempts, attemptsBeforeSixth, "No further start attempts run after exhaustion.");

  phase = "online";
  now = 7 * 11 * 60_000;
  await runCauseEffect(retry.tick());
  attempts = 0;
  exhausted = false;
  phase = "error";
  now = 8 * 11 * 60_000;
  try {
    await runCauseEffect(retry.tick());
  } catch {
    // Expected start failure after the counter reset.
  }
  assert.equal(attempts, 1, "Online phase resets the retry counter.");

  report.attempts = 5;
  report.exhausted = true;
  report.exhaustedError = exhaustedError instanceof Error ? exhaustedError.message : null;
  report.sixthTickAttempts = attemptsBeforeSixth;
  report.passed = true;
} catch (error) {
  report.passed = false;
  throw error;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
