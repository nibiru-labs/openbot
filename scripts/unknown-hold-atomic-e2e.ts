// Checks mailbox and unknown-hold persistence with a real SQLite database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { UsageLimitGate } from "../src/backend/agent/usage-limit-gate";
import { ChannelService } from "../src/backend/channel-service";
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
let publications = 0;
const channels = new ChannelService(db, mailbox, {
  agents: () => [],
  generate: () => Effect.succeed(""),
  schedule: () => {},
  interrupt: () => Effect.void,
  busy: () => false,
  changed: () => {
    publications++;
  },
  error: () => {},
});
const channel = channels.store.create("atomic-channel", {
  name: "atomic-channel",
  title: "Atomic",
  instructions: "",
  members: [],
  leadAgentId: null,
});
const task = {
  id: "atomic-task",
  channelId: channel.id,
  parentTaskId: null,
  rootTaskId: "atomic-task",
  ownerAgentId: agent.id,
  requestMessageId: "atomic-request",
  instruction: "atomic",
  attachmentDraftIds: [],
  expectedResult: "",
  sourceMessageIds: [],
  dependencies: [],
  resources: [],
  state: "running" as const,
  revision: 1,
  assignmentCount: 1,
  error: null,
};
const assignment = {
  id: "atomic-assignment",
  channelId: channel.id,
  taskId: task.id,
  agentId: agent.id,
  taskRevision: 1,
  requestMessageId: null,
  resources: [],
  deliveryId: id,
  turnId: null,
  state: "starting" as const,
  throughSequence: 0,
  summaryVersion: 0,
  awaitedTaskIds: [],
  pendingRevision: null,
  pendingOutcome: null,
};
channels.store.update(channel, { tasks: [task], assignments: [assignment] });
const prepareChannel = () => {
  const finish = channels.prepareRequeueForLimit(id, true);
  assert.ok(finish);
  return {
    status: "queued" as const,
    publish: () => {
      Effect.runSync(finish);
    },
  };
};
db.connection.exec(
  "CREATE TRIGGER atomic_mailbox_failure BEFORE UPDATE ON projection_deliveries BEGIN SELECT RAISE(ABORT, 'injected mailbox failure'); END",
);
assert.throws(
  () =>
    mailbox.requeueWithHold([{ id }], (connection) => gate.prepareUnknown(agent.id, null, connection), prepareChannel),
  /injected mailbox failure/,
);
db.connection.exec("DROP TRIGGER atomic_mailbox_failure");
assert.equal(channels.store.assignmentForDelivery(id)?.state, "starting");
assert.equal(mailbox.getDelivery(id)?.delivery.status, "starting");
assert.equal(publications, 0);
assert.equal(timers, 0);
db.connection.exec(
  "CREATE TRIGGER atomic_hold_failure BEFORE INSERT ON unknown_usage_holds BEGIN SELECT RAISE(ABORT, 'injected hold failure'); END",
);
assert.throws(
  () =>
    mailbox.requeueWithHold([{ id }], (connection) => gate.prepareUnknown(agent.id, null, connection), prepareChannel),
  /injected hold failure/,
);
db.connection.exec("DROP TRIGGER atomic_hold_failure");
assert.equal(channels.store.assignmentForDelivery(id)?.state, "starting");
assert.equal(channels.store.tasks(channel.id)[0]?.state, "running");
assert.equal(mailbox.getDelivery(id)?.delivery.status, "starting");
assert.equal(publications, 0);
assert.equal(timers, 0);
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
mailbox.requeueWithHold([{ id }], (connection) => gate.prepareUnknown(agent.id, null, connection), prepareChannel);
assert.equal(mailbox.getDelivery(id)?.delivery.status, "queued");
assert.equal(channels.store.assignmentForDelivery(id)?.state, "queued");
assert.equal(channels.store.tasks(channel.id)[0]?.state, "queued");
assert.equal(publications, 1);
assert.equal(db.connection.prepare("SELECT count(*) AS n FROM unknown_usage_holds").get()?.n, 1);
assert.equal(timers, 1);
assert.equal(gate.hasUnknownLimit(agent.id), true);
const after = new MailboxStore(root, join(root, "shared"), db);
await runCauseEffect(after.initialize());
assert.equal(after.getDelivery(id)?.delivery.status, "queued");
await runCauseEffect(gate.dispose());
db.close();
await writeFile(join(root, "report.json"), JSON.stringify({ rollback: true, commit: true, restart: true }, null, 2));
