// Checks the real AgentService + SQLite + a provider process for queue pause, Run now, Stop and send,
// the steer default, and teammate steer and interrupt through `openbot.send_message`. No model or
// credentials. `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --import tsx
// scripts/steer-interrupt-pause-e2e.ts` (node:sqlite with FTS5). Writes .openbot-build/steer-interrupt-pause-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type BusyMessageMode, DEFAULT_BUSY_MESSAGE_MODE } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import { cliPathEnvironment } from "../src/backend/cli";
import { getString, isRecord } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/steer-interrupt-pause-e2e");
mkdirSync(OUT, { recursive: true });
const root = await mkdtemp(join(OUT, "synthetic-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const logPath = join(root, "protocol.jsonl");
const controlPath = join(root, "control.json");
const fakeCodex = join(root, "codex.cjs");

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.OPENBOT_CODEX_PATH = fakeCodex;
process.env.OPENBOT_FAKE_CODEX_LOG = logPath;
process.env.OPENBOT_FAKE_CODEX_CONTROL = controlPath;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

/**
 * A turn whose input has HOLD stays open until it is interrupted. A turn whose input has CALL sends
 * the `openbot.send_message` call named in the control file, logs the answer, and ends.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const processInstance = randomUUID();
const log = (entry) => fs.appendFileSync(process.env.OPENBOT_FAKE_CODEX_LOG, JSON.stringify({ ...entry, processId: process.pid, processInstance }) + "\\n");
process.on("exit", () => log({ method: "process-exit", params: {} }));
process.on("SIGTERM", () => process.exit(0));
const control = () => JSON.parse(fs.readFileSync(process.env.OPENBOT_FAKE_CODEX_CONTROL, "utf8"));
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let calls = 0;
let generation = 0;
/** threadId -> turnId of the held turn. */
const held = new Map();
/** request id -> the turn whose tool calls wait for it, shared by the calls of one turn. */
const pending = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (threadId, turnId, status) => {
  const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
  if (status === "completed") write({ method: "item/completed", params: { threadId, turnId, item } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-5.5", displayName: "GPT-5.5" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": {
      const threadId = "thread-" + (++threads);
      log({ method: "thread-bound", params: { threadId } });
      return write({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
    }
    case "thread/resume":
      log({ method: "thread-bound", params: { threadId: params.threadId } });
      return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + randomUUID();
      const turnGeneration = ++generation;
      const input = JSON.stringify(params.input);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId }, processInstance, turnGeneration } });
      log({ method: "turn-ready", params: { threadId: params.threadId, turnId, turnGeneration, input: params.input } });
      if (input.includes("HOLD")) {
        held.set(params.threadId, turnId);
        log({ method: "held-ready", params: { threadId: params.threadId, turnId, turnGeneration, input: params.input } });
      }
      else if (input.includes("CALL")) {
        // calls sends several tool calls at once, as a model may; call sends one.
        const overlap = input.match(/CALL-OVERLAP-(\\d+)/);
        const selected = overlap
          ? JSON.parse(fs.readFileSync(process.env.OPENBOT_FAKE_CODEX_CONTROL + "." + overlap[1], "utf8"))
          : control();
        const specs = selected.calls ?? [selected.call];
        const shared = { threadId: params.threadId, turnId, remaining: specs.length };
        for (const spec of specs) {
          const id = "call-" + (++calls);
          pending.set(id, { ...shared, shared, spec, answered: false });
          log({ method: "tool-call", id, params: { threadId: params.threadId, turnId, spec } });
          write({ id, method: "item/tool/call", params: { threadId: params.threadId, turnId, callId: id, namespace: "openbot", tool: "send_message", arguments: spec } });
        }
      } else setImmediate(() => finish(params.threadId, turnId, "completed"));
      return;
    }
    case "turn/steer":
      return write({ id: message.id, result: { turnId: params.expectedTurnId } });
    case "turn/interrupt": {
      write({ id: message.id, result: {} });
      const turnId = held.get(params.threadId);
      if (turnId) {
        held.delete(params.threadId);
        finish(params.threadId, turnId, "interrupted");
      }
      return;
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method) {
        log({ method: message.method, id: message.id ?? null, params: message.params ?? null });
        if (message.id !== undefined) answer(message);
      } else {
        const call = pending.get(message.id);
        log({ method: "tool-answer", id: message.id ?? null, params: { threadId: call?.threadId, turnId: call?.turnId, spec: call?.spec, result: message.result ?? null, error: message.error ?? null } });
        if (call && !call.answered) {
          call.answered = true;
          if (--call.shared.remaining === 0) finish(call.threadId, call.turnId, "completed");
        }
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

function recordOf(value: unknown) {
  return isRecord(value) ? value : {};
}

/** The first busy outcome in the answer to a `send_message` call, from the fake's `tool-answer` entry. */
function busyOutcomes(params: unknown) {
  const result = isRecord(params) && isRecord(params.result) ? params.result : {};
  const items = Array.isArray(result.contentItems) ? result.contentItems : [];
  const text = isRecord(items[0]) ? getString(items[0], "text") : undefined;
  const receipt = recordOf(text ? JSON.parse(text) : null);
  const busy = Array.isArray(receipt.busy) ? receipt.busy : [];
  return busy.map((item) => {
    const outcome = isRecord(item) ? item : {};
    return {
      agentId: getString(outcome, "agentId"),
      result: getString(outcome, "result"),
      reason: getString(outcome, "reason"),
    };
  });
}

// The fake logs its supported requests and notifications, plus its own lifecycle and tool records.
const protocolMethods = new Set([
  "initialize",
  "initialized",
  "account/read",
  "account/rateLimits/read",
  "model/list",
  "plugin/list",
  "config/read",
  "config/batchWrite",
  "thread/start",
  "thread/resume",
  "thread/unsubscribe",
  "thread/turns/list",
  "thread/items/list",
  "thread/read",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread-bound",
  "turn-ready",
  "held-ready",
  "tool-call",
  "tool-answer",
  "process-exit",
]);

function protocol(path = logPath) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const entry = JSON.parse(line);
      assert(isRecord(entry), `invalid synthetic log record at line ${index + 1}: expected an object`);
      const method = getString(entry, "method");
      assert(method && protocolMethods.has(method), `invalid synthetic log method at line ${index + 1}`);
      assert(
        Number.isSafeInteger(entry.processId) && Number(entry.processId) > 0,
        `invalid process ID at line ${index + 1}`,
      );
      const processInstance = getString(entry, "processInstance");
      assert(
        processInstance &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(processInstance),
        `invalid process instance at line ${index + 1}`,
      );
      assert(entry.params === null || isRecord(entry.params), `invalid params at line ${index + 1}`);
      assert(
        entry.id === undefined || entry.id === null || typeof entry.id === "string" || typeof entry.id === "number",
        `invalid ID at line ${index + 1}`,
      );
      const params = isRecord(entry.params) ? entry.params : {};
      return {
        method,
        input: JSON.stringify(params.input ?? ""),
        threadId: getString(params, "threadId"),
        turnId: getString(params, "turnId"),
        turnGeneration: params.turnGeneration,
        outcome: method === "tool-answer" ? busyOutcomes(params) : null,
        callId: getString(entry, "id"),
        processId: entry.processId,
        processInstance,
        spec: params.spec,
      };
    });
}

function assertAnswerCardinality(entries: ReturnType<typeof protocol>) {
  const toolCalls = entries.filter((entry) => entry.method === "tool-call");
  const answers = entries.filter((entry) => entry.method === "tool-answer");
  const matches = (call: (typeof entries)[number], answer: (typeof entries)[number]) =>
    typeof call.callId === "string" &&
    answer.callId === call.callId &&
    answer.processInstance === call.processInstance &&
    answer.threadId === call.threadId &&
    answer.turnId === call.turnId;
  for (const call of toolCalls) {
    assert.equal(answers.filter((answer) => matches(call, answer)).length, 1, `expected one answer for ${call.callId}`);
  }
  for (const answer of answers) {
    assert.equal(toolCalls.filter((call) => matches(call, answer)).length, 1, `unknown answer ${answer.callId}`);
  }
}

const calls = (method: string) => protocol().filter((entry) => entry.method === method);

/** Waits for a state of the service or of the fake Codex. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

await writeFile(logPath, "");
await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
await writeFile(controlPath, JSON.stringify({ call: null }));
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
let busyMode: BusyMessageMode = "queue";
// Capture the generation on the client that received the actual provider notification.
const activeTurns = new Map<
  string,
  { client: CodexAppServerClient; processInstance: string; turnGeneration: number; turnId: string }
>();
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  clientFactory: (provider, cli, _confinement, accountEnvironment) => {
    assert.equal(provider, "codex");
    const client = new CodexAppServerClient(cli.executable, 30_000, {
      ...cliPathEnvironment(cli),
      ...accountEnvironment,
    });
    client.on("notification", (notification) => {
      if (notification.method !== "turn/started") return;
      const params = recordOf(notification.params);
      const threadId = getString(params, "threadId");
      const turnId = getString(recordOf(params.turn), "id");
      const processInstance = getString(params, "processInstance");
      const turnGeneration = params.turnGeneration;
      if (
        threadId &&
        turnId &&
        processInstance &&
        typeof turnGeneration === "number" &&
        Number.isSafeInteger(turnGeneration)
      ) {
        activeTurns.set(threadId, { client, processInstance, turnGeneration, turnId });
      }
    });
    return client;
  },
  busyMessageMode: () => busyMode,
});

/** Read back from SQLite, not from the mailbox in memory. */
const pausedInDatabase = (agentId: string) => {
  const state = recordOf(database.readMailboxState());
  return Array.isArray(state.pausedAgentIds) && state.pausedAgentIds.includes(agentId);
};
const status = (deliveryId: string | undefined) =>
  deliveryId ? mailbox.getDelivery(deliveryId)?.delivery.status : null;
const runningTurn = (agentId: string) =>
  agents.listQueue(agentId).deliveries.find((item) => item.status === "running")?.turnId;
function heldEvidence(
  entries: ReturnType<typeof protocol>,
  threadId: string,
  turnId: string,
  text: string,
  current: { processInstance: string; turnGeneration: number },
) {
  const turns = entries.filter(
    (entry) =>
      entry.method === "turn-ready" &&
      entry.threadId === threadId &&
      entry.turnId === turnId &&
      entry.processInstance === current.processInstance &&
      entry.turnGeneration === current.turnGeneration &&
      entry.input.includes(text),
  );
  if (turns.length !== 1) return false;
  const turn = turns[0];
  return (
    entries.some(
      (entry) =>
        entry.method === "thread-bound" &&
        entry.processInstance === turn?.processInstance &&
        entry.threadId === threadId,
    ) &&
    entries.some(
      (entry) =>
        entry.method === "held-ready" &&
        entry.processInstance === turn?.processInstance &&
        entry.threadId === threadId &&
        entry.turnId === turnId &&
        entry.turnGeneration === current.turnGeneration &&
        entry.input.includes(text),
    )
  );
}
const waitForHeld = (agentId: string, deliveryId: string, text: string) =>
  waitFor(`${text} to run and be held by the provider`, () => {
    const delivery = mailbox.getDelivery(deliveryId)?.delivery;
    const threadId = store.activeProviderSession(agentId)?.externalSessionId;
    const current = threadId ? activeTurns.get(threadId) : undefined;
    return delivery?.status === "running" &&
      agents.listQueue(agentId).deliveries.some((item) => item.id === deliveryId && item.status === "running") &&
      delivery.turnId &&
      threadId &&
      current?.client.running &&
      current.turnId === delivery.turnId &&
      heldEvidence(protocol(), threadId, delivery.turnId, text, current)
      ? delivery.turnId
      : null;
  });
let sends = 0;
const send = async (agentId: string, text: string, interrupt?: boolean) => {
  const receipt = await runCauseEffect(
    agents.sendMessage({ agentId, text, clientMessageId: `send-${++sends}`, ...(interrupt ? { interrupt } : {}) }),
  );
  const id = receipt.deliveries[0]?.id;
  assert(id, `no delivery for ${text}`);
  return id;
};

const report: { passed: boolean; checks: string[]; error?: string } = { passed: false, checks: [] };
try {
  await runCauseEffect(agents.initialize());
  const target = await runCauseEffect(
    agents.createAgent({
      name: "Target",
      description: "Synthetic target",
      avatarSeed: "target",
      avatarHue: null,
      initialMessage: "HOLD-FIRST",
    }),
  );
  const firstDelivery = await waitFor(
    "the first delivery",
    () => agents.listQueue(target.id).deliveries.find((item) => item.text.includes("HOLD-FIRST"))?.id,
  );
  await waitForHeld(target.id, firstDelivery, "HOLD-FIRST");

  // Pause, Run now, and Resume.
  const queuedA = await send(target.id, "QUEUED-A");
  const queuedB = await send(target.id, "QUEUED-B");
  assert.equal(status(queuedA), "queued");
  assert.equal(status(queuedB), "queued");
  await runCauseEffect(agents.setQueuePaused({ agentId: target.id, paused: true }));
  assert.equal(agents.listQueue(target.id).paused, true);
  assert(pausedInDatabase(target.id), "the pause is not stored");
  report.checks.push("Pause is in the queue snapshot and stored in SQLite; queued messages stay queued");

  await runCauseEffect(agents.runQueuedMessageNow({ agentId: target.id, deliveryId: queuedB }));
  await waitFor("QUEUED-B to complete", () => status(queuedB) === "completed");
  assert.equal(calls("turn/interrupt").length, 1);
  assert.equal(status(firstDelivery), "interrupted");
  assert.equal(status(queuedA), "queued");
  assert.equal(calls("turn/start").filter((entry) => entry.input.includes("QUEUED-A")).length, 0);
  report.checks.push("Run now stops the current turn and starts its message while the queue is paused; the rest waits");

  await runCauseEffect(agents.setQueuePaused({ agentId: target.id, paused: false }));
  await waitFor("QUEUED-A to complete after resume", () => status(queuedA) === "completed");
  assert.equal(agents.listQueue(target.id).paused, undefined);
  assert(!pausedInDatabase(target.id), "the resume is not stored");
  report.checks.push("Resume starts the kept message once and clears the stored pause");

  // Stop and send: the new message starts before the message that waited.
  const holdTwo = await send(target.id, "HOLD-TWO");
  await waitForHeld(target.id, holdTwo, "HOLD-TWO");
  const queuedC = await send(target.id, "QUEUED-C");
  const nowD = await send(target.id, "NOW-D", true);
  await waitFor(
    "QUEUED-C and NOW-D to complete",
    () => status(queuedC) === "completed" && status(nowD) === "completed",
  );
  assert.equal(status(holdTwo), "interrupted");
  const order = calls("turn/start").map((entry) => entry.input);
  const nowIndex = order.findIndex((input) => input.includes("NOW-D"));
  const queuedIndex = order.findIndex((input) => input.includes("QUEUED-C"));
  assert(nowIndex >= 0 && nowIndex < queuedIndex, "NOW-D did not start before QUEUED-C");
  assert.equal(calls("turn/steer").length, 0);
  report.checks.push("Stop and send interrupts, starts the new message next, and keeps the earlier queued message");

  // The default busy mode steers.
  assert.equal(DEFAULT_BUSY_MESSAGE_MODE, "steer");
  busyMode = DEFAULT_BUSY_MESSAGE_MODE;
  const holdThree = await send(target.id, "HOLD-THREE");
  const heldTurn = await waitForHeld(target.id, holdThree, "HOLD-THREE");
  const steered = await send(target.id, "STEERED-E");
  await waitFor("STEERED-E to join the running turn", () => status(steered) === "running");
  assert.equal(mailbox.getDelivery(steered)?.delivery.turnId, heldTurn);
  assert(calls("turn/steer").some((entry) => entry.input.includes("STEERED-E")));
  report.checks.push("With the default busy mode, a message to a busy agent steers the running turn");

  // A teammate steers, interrupts, and meets the cooldown.
  const sender = await runCauseEffect(
    agents.createAgent({
      name: "Sender",
      description: "Synthetic sender",
      avatarSeed: "sender",
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor("the sender's first turn to end", () =>
    agents.listQueue(sender.id).deliveries.every((item) => item.status === "completed"),
  );
  const answersFor = async (senderId: string, deliveryId: string, marker: string, specs: unknown[]) => {
    await waitFor(`${marker} sender turn to complete`, () => status(deliveryId) === "completed");
    const delivery = mailbox.getDelivery(deliveryId)?.delivery;
    assert(delivery?.turnId, `no turn for ${marker}`);
    const turns = calls("turn-ready").filter(
      (entry) => entry.turnId === delivery.turnId && entry.input.includes(marker),
    );
    assert.equal(turns.length, 1, `expected one provider turn for ${marker}`);
    const turn = turns[0];
    assert(turn);
    assert(agents.listQueue(senderId).deliveries.some((item) => item.id === deliveryId && item.turnId === turn.turnId));
    const toolCalls = calls("tool-call").filter(
      (entry) =>
        entry.processInstance === turn.processInstance &&
        entry.threadId === turn.threadId &&
        entry.turnId === turn.turnId,
    );
    assert.equal(toolCalls.length, specs.length, `unexpected call count for ${marker}`);
    return specs.map((spec) => {
      const matching = toolCalls.filter((entry) => JSON.stringify(entry.spec) === JSON.stringify(spec));
      assert.equal(matching.length, 1, `expected one call for ${marker}`);
      const call = matching[0];
      assert(call?.callId);
      const answers = calls("tool-answer").filter(
        (entry) =>
          entry.processInstance === call.processInstance &&
          entry.threadId === call.threadId &&
          entry.turnId === call.turnId &&
          entry.callId === call.callId,
      );
      assert.equal(answers.length, 1, `expected one answer for ${marker} ${call.callId}`);
      assert.deepEqual(answers[0]?.spec, spec);
      assert.equal(answers[0]?.outcome?.length, 1);
      const outcome = answers[0]?.outcome?.[0];
      assert.equal(outcome?.agentId, target.id);
      return outcome;
    });
  };
  const teammateCall = async (busy: "steer" | "interrupt", text: string) => {
    const spec = { recipientAgentIds: [target.id], text, expectsReply: false, busy };
    await writeFile(controlPath, JSON.stringify({ call: spec }));
    const marker = `CALL-${text}`;
    const deliveryId = await send(sender.id, marker);
    return (await answersFor(sender.id, deliveryId, marker, [spec]))[0];
  };
  const steer = await teammateCall("steer", "TEAM-STEER");
  assert.equal(steer?.result, "steered");
  assert(calls("turn/steer").some((entry) => entry.input.includes("TEAM-STEER")));
  report.checks.push("A teammate steers another agent's running turn through send_message");

  const interrupt = await teammateCall("interrupt", "TEAM-INTERRUPT");
  assert.equal(interrupt?.result, "interrupted");
  await waitFor("the interrupted turn to end", () => status(holdThree) === "interrupted");
  await waitFor("TEAM-INTERRUPT to start", () =>
    calls("turn/start").some((entry) => entry.input.includes("TEAM-INTERRUPT")),
  );
  report.checks.push("A teammate interrupts another agent's turn, and its message starts next");

  const holdFour = await send(target.id, "HOLD-FOUR");
  await waitForHeld(target.id, holdFour, "HOLD-FOUR");
  const interruptsBefore = calls("turn/interrupt").length;
  const cooled = await teammateCall("interrupt", "TEAM-AGAIN");
  assert.equal(cooled?.result, "queued");
  assert.equal(cooled?.reason, sourceText("error.backend.agentControlCooldown"));
  assert.equal(calls("turn/interrupt").length, interruptsBefore);
  assert.equal(status(holdFour), "running");
  report.checks.push("A second interrupt within the cooldown is refused with a reason and the message stays queued");

  // Overlapping requests: the cooldown and the limit must hold when the calls arrive together.
  const interruptSpec = (text: string) => ({
    recipientAgentIds: [target.id],
    text,
    expectsReply: false,
    busy: "interrupt",
  });
  let overlapSequence = 0;
  const overlapping = async (senderIds: string[], specsBySender: unknown[][]) => {
    assert.equal(senderIds.length, specsBySender.length);
    const interruptsBefore = calls("turn/interrupt").length;
    const keys = senderIds.map(() => ++overlapSequence);
    await Promise.all(
      keys.map((key, index) => writeFile(`${controlPath}.${key}`, JSON.stringify({ calls: specsBySender[index] }))),
    );
    const deliveryIds = await Promise.all(
      senderIds.map((senderId, index) => send(senderId, `CALL-OVERLAP-${keys[index]}`)),
    );
    const outcomes = (
      await Promise.all(
        senderIds.map((senderId, index) => {
          const deliveryId = deliveryIds[index];
          const specs = specsBySender[index];
          assert(deliveryId && specs);
          return answersFor(senderId, deliveryId, `CALL-OVERLAP-${keys[index]}`, specs);
        }),
      )
    ).flat();
    return { outcomes, stopped: calls("turn/interrupt").length - interruptsBefore };
  };

  // One new sender, two calls at once: the cooldown lets one stop through. The first sender is still
  // inside its cooldown for this target, so it cannot be used here.
  const cooling = await runCauseEffect(
    agents.createAgent({
      name: "Cooling",
      description: "Synthetic",
      avatarSeed: "cooling",
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor("the cooling sender's first turn to end", () =>
    agents.listQueue(cooling.id).deliveries.every((item) => item.status === "completed"),
  );
  await waitForHeld(target.id, holdFour, "HOLD-FOUR");
  const sameSender = await overlapping([cooling.id], [[interruptSpec("HOLD-COOL-1"), interruptSpec("HOLD-COOL-2")]]);
  assert.deepEqual(sameSender.outcomes.map((outcome) => outcome.result).sort(), ["interrupted", "queued"]);
  assert.equal(
    sameSender.outcomes.find((outcome) => outcome.result === "queued")?.reason,
    sourceText("error.backend.agentControlCooldown"),
  );
  assert.equal(sameSender.stopped, 1);
  report.checks.push("Two overlapping interrupts from one sender stop the turn once; the second waits on the cooldown");

  // Two senders at once, with one interrupt left in the window. The second call can see the
  // target's stopping turn as idle before it reaches the limit check; that queued result has no reason.
  const second = await runCauseEffect(
    agents.createAgent({
      name: "Second",
      description: "Synthetic",
      avatarSeed: "second",
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  const third = await runCauseEffect(
    agents.createAgent({
      name: "Third",
      description: "Synthetic",
      avatarSeed: "third",
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor("the new senders' first turns to end", () =>
    [second.id, third.id].every((id) => agents.listQueue(id).deliveries.every((item) => item.status === "completed")),
  );
  const heldBeforeLimit = await waitFor("the started cooling delivery", () =>
    agents
      .listQueue(target.id)
      .deliveries.find((item) => ["HOLD-COOL-1", "HOLD-COOL-2"].includes(item.text) && item.status === "running"),
  );
  await waitForHeld(target.id, heldBeforeLimit.id, heldBeforeLimit.text);
  const secondText = "HOLD-LIMIT-SECOND";
  const thirdText = "HOLD-LIMIT-THIRD";
  const limited = await overlapping([second.id, third.id], [[interruptSpec(secondText)], [interruptSpec(thirdText)]]);
  assert.deepEqual(limited.outcomes.map((outcome) => outcome.result).sort(), ["interrupted", "queued"]);
  const queued = limited.outcomes.find((outcome) => outcome.result === "queued");
  if (queued?.reason) assert.equal(queued.reason, sourceText("error.backend.agentControlLimit"));
  assert.equal(limited.stopped, 1);
  await waitFor("the held delivery to be interrupted", () => status(heldBeforeLimit.id) === "interrupted");
  const readDeliveries = () =>
    [secondText, thirdText].map((text) => agents.listQueue(target.id).deliveries.find((item) => item.text === text));
  await waitFor("one limit message to start", () =>
    readDeliveries().some((delivery) => delivery?.status === "running" || delivery?.status === "completed"),
  );
  const deliveries = readDeliveries();
  assert(deliveries.every(Boolean), "one of the overlapping messages was not queued");
  assert.equal(deliveries.filter((delivery) => delivery?.status === "queued").length, 1);
  assert.equal(
    deliveries.filter((delivery) => delivery?.status === "running" || delivery?.status === "completed").length,
    1,
  );
  const waiting = deliveries.find((delivery) => delivery?.status === "queued");
  const started = deliveries.find((delivery) => delivery?.status === "running" || delivery?.status === "completed");
  assert.equal(calls("turn/start").filter((entry) => entry.input.includes(started?.text ?? "")).length, 1);
  assert.equal(calls("turn/start").filter((entry) => entry.input.includes(waiting?.text ?? "")).length, 0);
  report.checks.push(
    queued?.reason
      ? "Two senders stop one turn; the capacity limit queues the other message"
      : "Two senders stop one turn; the other message stays queued while the target is stopping",
  );

  // The three accepted teammate interrupts have filled the target's window. Wait until the fake
  // provider has held the new turn, then use a fresh sender so the cooldown cannot mask the limit.
  const capacitySender = await runCauseEffect(
    agents.createAgent({
      name: "Capacity sender",
      description: "Synthetic",
      avatarSeed: "capacity-sender",
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor("the capacity sender's first turn to end", () =>
    agents.listQueue(capacitySender.id).deliveries.every((item) => item.status === "completed"),
  );
  assert(started);
  const capacityTurn = await waitForHeld(target.id, started.id, started.text);
  const capacityDelivery = started;
  const capacityText = "CAPACITY-REFUSAL";
  const capacity = await overlapping([capacitySender.id], [[interruptSpec(capacityText)]]);
  assert.deepEqual(capacity.outcomes, [
    { agentId: target.id, result: "queued", reason: sourceText("error.backend.agentControlLimit") },
  ]);
  assert.equal(capacity.stopped, 0);
  assert.equal(status(capacityDelivery.id), "running");
  assert.equal(runningTurn(target.id), capacityTurn);
  const refusedDeliveries = agents.listQueue(target.id).deliveries.filter((item) => item.text === capacityText);
  assert.equal(refusedDeliveries.length, 1);
  assert.equal(refusedDeliveries[0]?.status, "queued");
  assert.equal(calls("turn/start").filter((entry) => entry.input.includes(capacityText)).length, 0);
  report.checks.push(
    "A running target at interrupt capacity refuses one message with the limit reason and stays running",
  );
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  try {
    await runCauseEffect(agents.stop());
    await waitFor("provider processes to exit", () => {
      const entries = protocol();
      const instances = new Set(entries.map((entry) => entry.processInstance));
      return [...instances].every((instance) =>
        entries.some((entry) => entry.method === "process-exit" && entry.processInstance === instance),
      );
    });
    const entries = protocol();
    assertAnswerCardinality(entries);
    const answer = entries.find((entry) => entry.method === "tool-answer");
    assert(answer, "no tool answer to check");
    assert.throws(() => assertAnswerCardinality(entries.filter((entry) => entry !== answer)));
    assert.throws(() => assertAnswerCardinality([...entries, answer]));
    assert.throws(() => assertAnswerCardinality([...entries, { ...answer, callId: "unknown" }]));
    assert.throws(() => assertAnswerCardinality([...entries, { ...answer, callId: null }]));
    const invalidLog = join(root, "invalid-protocol.jsonl");
    writeFileSync(invalidLog, "{invalid\n");
    assert.throws(() => protocol(invalidLog));
    for (const method of [undefined, null, 42, "", "turn/interupt"]) {
      writeFileSync(
        invalidLog,
        `${JSON.stringify({ method, processId: 1, processInstance: "00000000-0000-4000-8000-000000000001", params: {} })}\n`,
      );
      assert.throws(
        () => assert.equal(protocol(invalidLog).filter((entry) => entry.method === "turn/interrupt").length, 0),
        /invalid synthetic log method/,
      );
    }
    const staleFixture = join(root, "stale-protocol.jsonl");
    const current = "00000000-0000-4000-8000-000000000001";
    const stale = "00000000-0000-4000-8000-000000000002";
    const record = (method: string, processInstance: string, turnGeneration: number) => ({
      method,
      processId: processInstance === current ? 1 : 2,
      processInstance,
      params: { threadId: "thread-1", turnId: "turn-1", turnGeneration, input: "HOLD" },
    });
    // This is the previous matcher, kept here to prove each counterexample reaches it.
    const oldHeldEvidence = (entries: ReturnType<typeof protocol>) => {
      const turns = entries.filter(
        (entry) =>
          entry.method === "turn-ready" &&
          entry.threadId === "thread-1" &&
          entry.turnId === "turn-1" &&
          entry.input.includes("HOLD"),
      );
      if (turns.length !== 1) return false;
      const turn = turns[0];
      return (
        entries.some(
          (entry) =>
            entry.method === "thread-bound" &&
            entry.processInstance === turn?.processInstance &&
            entry.threadId === "thread-1",
        ) &&
        entries.some(
          (entry) =>
            entry.method === "held-ready" &&
            entry.processInstance === turn?.processInstance &&
            entry.threadId === "thread-1" &&
            entry.turnId === "turn-1" &&
            entry.input.includes("HOLD"),
        )
      );
    };
    const currentTurn = { processInstance: current, turnGeneration: 2 };
    for (const records of [
      [
        record("thread-bound", stale, 1),
        record("turn-ready", stale, 1),
        record("held-ready", stale, 1),
        record("thread-bound", current, 2),
      ],
      [record("thread-bound", current, 1), record("turn-ready", current, 1), record("held-ready", current, 1)],
    ]) {
      writeFileSync(staleFixture, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      const fixture = protocol(staleFixture);
      assert.equal(oldHeldEvidence(fixture), true);
      assert.equal(heldEvidence(fixture, "thread-1", "turn-1", "HOLD", currentTurn), false);
    }
    writeFileSync(
      staleFixture,
      `${[
        record("thread-bound", current, 2),
        record("turn-ready", current, 2),
        record("thread-bound", stale, 2),
        record("held-ready", stale, 2),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    assert.equal(heldEvidence(protocol(staleFixture), "thread-1", "turn-1", "HOLD", currentTurn), false);
    writeFileSync(
      staleFixture,
      `${[record("thread-bound", current, 2), record("turn-ready", current, 2), record("held-ready", current, 2)].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    assert.equal(heldEvidence(protocol(staleFixture), "thread-1", "turn-1", "HOLD", currentTurn), true);
    writeFileSync(invalidLog, `${JSON.stringify({ method: "held-ready", processId: 1, params: {} })}\n`);
    assert.throws(() => protocol(invalidLog), /invalid process instance/);
    report.checks.push("Old-process and old-generation held evidence is rejected when thread and turn IDs match");
    assert.throws(() => protocol(join(root, "missing-protocol.jsonl")));
    if (!report.error) report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = [report.error, error instanceof Error ? (error.stack ?? error.message) : String(error)]
      .filter(Boolean)
      .join("\n");
    process.exitCode = 1;
  }
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  // Machine-readable: the E2E report, without provider credentials or user content.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
