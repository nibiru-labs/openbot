// Checks that the first failed optional CDP command closes a capture session and reaches the caller,
// and that later cleanup on the same session is ignored. Writes .openbot-build/browser-cdp-dead-session-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { CdpCaptureSessionGuard, optionalCdpCommand, type SendCommand } from "../src/backend/browser-cdp-values";
import { browserFailure } from "../src/backend/browser-effects";
import { runCauseEffect } from "../src/backend/effect-boundary";

const OUT = resolve(import.meta.dirname, "../.openbot-build/browser-cdp-dead-session-e2e");
const SESSION = "frame-session-1";
const DEAD_MESSAGE = "target closed while handling command";

interface Report {
  passed: boolean;
  firstFailure: string | null;
  callsAfterClose: number;
}

const report: Report = {
  passed: false,
  firstFailure: null,
  callsAfterClose: 0,
};

try {
  const guard = new CdpCaptureSessionGuard();
  let calls = 0;
  let failNextRelease = true;
  const send: SendCommand = (method, params, sessionId) => {
    calls += 1;
    if (method === "Runtime.releaseObject" && sessionId === SESSION && failNextRelease) {
      failNextRelease = false;
      return Effect.fail(browserFailure(new Error(DEAD_MESSAGE)));
    }
    return Effect.succeed({ objectId: String(params?.objectId ?? "") });
  };

  let thrown: unknown;
  try {
    await runCauseEffect(optionalCdpCommand(guard, send, "Runtime.releaseObject", { objectId: "a" }, SESSION));
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error, "The first release failure reaches the caller.");
  if (!(thrown instanceof Error)) throw new Error("Expected an Error from runCauseEffect.");
  assert.equal(thrown.message, DEAD_MESSAGE);
  assert.equal(guard.isClosed(SESSION), true, "The capture session is marked closed.");

  const callsAfterFirst = calls;
  await runCauseEffect(optionalCdpCommand(guard, send, "Runtime.releaseObject", { objectId: "b" }, SESSION));
  assert.equal(calls, callsAfterFirst, "Later releases on a closed session are ignored.");

  await runCauseEffect(optionalCdpCommand(guard, send, "Input.setInterceptDrags", { enabled: false }, SESSION));
  assert.equal(calls, callsAfterFirst, "Later optional commands on a closed session are ignored.");

  guard.clear();
  failNextRelease = false;
  const callsBeforeClear = calls;
  await runCauseEffect(optionalCdpCommand(guard, send, "Runtime.releaseObject", { objectId: "c" }, SESSION));
  assert.equal(calls, callsBeforeClear + 1, "Clearing the guard allows the session to send again.");

  report.firstFailure = thrown instanceof Error ? thrown.message : null;
  report.callsAfterClose = calls - callsAfterFirst;
  report.passed = true;
} catch (error) {
  report.passed = false;
  throw error;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
