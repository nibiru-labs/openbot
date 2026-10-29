// Checks mailbox and unknown-hold persistence with a real SQLite database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { UsageLimitGate } from "../src/backend/agent/usage-limit-gate";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const root = resolve(import.meta.dirname, `../.openbot-build/unknown-hold-atomic-e2e-${randomUUID()}`);
await mkdir(root, { recursive: true });
const db = new OpenBotDatabase(root);
const mailbox = new MailboxStore(root, join(root, "shared"), db);
await runCauseEffect(mailbox.initialize());
const agent = { id: "atomic-agent", provider: "codex" as const, model: "atomic-model" };
let timers = 0;
const gate = new UsageLimitGate({
  store: { list: () => [agent] },
  database: () => db.connection,
  timers: {
    set: () => {
      timers++;
      return setTimeout(() => {}, 600_000);
    },
    clear: clearTimeout,
  },
  hooks: {
    emit: () => {},
    emitRuntimeSnapshot: () => {},
    scheduleDrain: () => {},
    readUsage: () => Effect.succeed(null),
    held: () => Effect.void,
    released: () => Effect.void,
  },
});
const receipt = await runCauseEffect(
  mailbox.enqueue({ sender: { kind: "user" }, recipientAgentIds: [agent.id], text: "atomic" }),
);
const id = receipt.deliveries[0]?.id;
assert.ok(id);
await runCauseEffect(mailbox.markStarting(id));
assert.throws(
  () =>
    mailbox.requeueWithHold([{ id }], (connection) => {
      gate.prepareUnknown(agent.id, null, connection);
      throw new Error("injected failure");
    }),
  /injected failure/,
);
assert.equal(mailbox.getDelivery(id)?.delivery.status, "starting");
assert.equal(db.connection.prepare("SELECT count(*) AS n FROM unknown_usage_holds").get()?.n, 0);
assert.equal(timers, 0);
assert.equal(gate.hasUnknownLimit(agent.id), false);
const restored = new MailboxStore(root, join(root, "shared"), db);
await runCauseEffect(restored.initialize());
assert.equal(restored.getDelivery(id)?.delivery.status, "starting");
mailbox.requeueWithHold([{ id }], (connection) => gate.prepareUnknown(agent.id, null, connection));
assert.equal(mailbox.getDelivery(id)?.delivery.status, "queued");
assert.equal(db.connection.prepare("SELECT count(*) AS n FROM unknown_usage_holds").get()?.n, 1);
assert.equal(timers, 1);
assert.equal(gate.hasUnknownLimit(agent.id), true);
const after = new MailboxStore(root, join(root, "shared"), db);
await runCauseEffect(after.initialize());
assert.equal(after.getDelivery(id)?.delivery.status, "queued");
await runCauseEffect(gate.dispose());
await writeFile(join(root, "report.json"), JSON.stringify({ rollback: true, commit: true, restart: true }, null, 2));
