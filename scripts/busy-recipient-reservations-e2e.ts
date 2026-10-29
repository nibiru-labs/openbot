// Runs the real busy-recipient controller with an in-memory clock and controlled stop hooks.
// No database, provider, network service, or credentials are used.
// bun scripts/busy-recipient-reservations-e2e.ts
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { BusyRecipientControls } from "../src/backend/agent/busy-recipient-control";

const cooldown = 60_000;
const steps: string[] = [];

function setup() {
  let now = 0;
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const controls = new BusyRecipientControls({
    mailbox: { findDeliveriesByTurn: () => [] },
    logger: createOpenBotLogger("busy-recipient-e2e", () => undefined),
    now: () => now,
    hooks: {
      activeTurnId: () => "active",
      agentName: (id) => id,
      redact: (text) => text,
      steer: () => Effect.void,
      runNow: (_agentId, deliveryId) =>
        Effect.tryPromise({
          try: () => new Promise<void>((resolve, reject) => pending.set(deliveryId, { resolve, reject })),
          catch: (error) => error,
        }),
    },
  });
  const request = (deliveryId: string, senderAgentId = "sender") =>
    Effect.runPromise(
      controls.control({
        senderAgentId,
        senderTurnId: "turn",
        recipientAgentId: "recipient",
        deliveryId,
        mode: "interrupt",
      }),
    );
  function finish(id: string, success: boolean) {
    const hook = pending.get(id);
    assert.ok(hook, `missing reservation ${id}`);
    pending.delete(id);
    if (success) hook.resolve();
    else hook.reject(new Error("synthetic stop failure"));
  }
  return {
    request,
    finish,
    setTime: (value: number) => {
      now = value;
    },
  };
}

async function refused(outcome: Awaited<ReturnType<ReturnType<typeof setup>["request"]>>) {
  assert.equal(outcome.result, "queued");
  assert.equal(outcome.reason, sourceText("error.backend.agentControlCooldown"));
}

// Keep the returned promises pending while later reservations cross the cooldown boundary.
async function startPending(env: ReturnType<typeof setup>, id: string, at: number) {
  env.setTime(at);
  const promise = env.request(id);
  return { promise };
}

for (const order of [
  ["old", "middle"],
  ["middle", "old"],
]) {
  const env = setup();
  const old = await startPending(env, "old", 0);
  const middle = await startPending(env, "middle", cooldown);
  const newest = await startPending(env, "newest", cooldown * 2);
  env.finish("newest", true);
  assert.equal((await newest.promise).result, "interrupted");
  for (const id of order) env.finish(id, false);
  assert.equal((await old.promise).result, "queued");
  assert.equal((await middle.promise).result, "queued");
  await refused(await env.request("third"));
  env.setTime(cooldown * 3);
  const afterExpiry = env.request("after-expiry");
  env.finish("after-expiry", true);
  assert.equal((await afterExpiry).result, "interrupted");
  steps.push(`new success survives failures: ${order.join(", ")}`);
}

{
  const env = setup();
  const first = await startPending(env, "first", 0);
  env.finish("first", true);
  assert.equal((await first.promise).result, "interrupted");
  await refused(await env.request("immediate"));
  const old = await startPending(env, "old", cooldown);
  const newer = await startPending(env, "newer", cooldown * 2);
  env.finish("newer", false);
  env.finish("old", false);
  assert.equal((await old.promise).result, "queued");
  assert.equal((await newer.promise).result, "queued");
  const retry = env.request("retry");
  env.finish("retry", true);
  assert.equal((await retry).result, "interrupted");
  steps.push("normal success and all-fail restore");
}

const out = resolve(import.meta.dirname, "../.openbot-build/busy-recipient-reservations-e2e");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "report.json"), JSON.stringify({ passed: true, steps }, null, 2));
process.stdout.write(`Passed ${steps.length} scenarios. Report: ${out}/report.json\n`);
