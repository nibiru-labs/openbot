// Checks real AgentService + SQLite + provider process with a turn held until explicit release. No model or credentials.
// Writes .openbot-build/busy-inbox-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { getString, isRecord } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/busy-inbox-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-busy-inbox-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const logPath = join(root, "protocol.jsonl");
const controlPath = join(root, "control.json");
const fakeCodex = join(root, "codex");

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

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const log = (entry) => fs.appendFileSync(process.env.OPENBOT_FAKE_CODEX_LOG, JSON.stringify(entry) + "\\n");
const control = () => JSON.parse(fs.readFileSync(process.env.OPENBOT_FAKE_CODEX_CONTROL, "utf8"));
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
/** threadId -> { turnId, finish } of the compaction turn that runs. */
const compacting = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
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
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + (++turns);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const finish = () => {
        const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      };
      if (turns === 1 && !control().release) {
        const watcher = fs.watch(process.env.OPENBOT_FAKE_CODEX_CONTROL, () => {
          try { if (control().release) { watcher.close(); finish(); } } catch {}
        });
      } else setImmediate(finish);
      return;
    }
    case "turn/steer":
      return write({ id: message.id, error: { code: -32603, message: "The model is thinking and cannot take steering input yet." } });
    case "turn/interrupt":
      return write({ id: message.id, result: {} });
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
      log({ method: message.method ?? null, id: message.id ?? null, params: message.params ?? null });
      if (message.method && message.id !== undefined) answer(message);
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
};

function protocol() {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => parseProtocol(JSON.parse(line)));
  } catch {
    return [];
  }
}

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

function parseProtocol(value: unknown) {
  const entry = isRecord(value) ? value : {};
  const params = isRecord(entry.params) ? entry.params : {};
  return {
    method: getString(entry, "method"),
    input: JSON.stringify(params.input),
    threadId: getString(params, "threadId"),
  };
}
await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  busyMessageMode: () => "queue",
});

const report: { passed: boolean; checks: string[]; error?: string } = { passed: false, checks: [] };
try {
  await writeFile(controlPath, JSON.stringify({ release: false }));
  await runCauseEffect(agents.initialize());
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Inbox check",
      description: "Synthetic busy inbox check",
      avatarSeed: "inbox",
      avatarHue: null,
      initialMessage: "HOLD-FIRST",
    }),
  );
  const turnId = await waitFor(
    "the held turn",
    () => agents.listQueue(agent.id).deliveries.find((item) => item.status === "running")?.turnId,
  );
  const input = { agentId: agent.id, text: "FOLLOWUP-SECOND", clientMessageId: "inbox-second" };
  const second = await runCauseEffect(agents.sendMessage(input));
  const duplicate = await runCauseEffect(agents.sendMessage(input));
  const third = await runCauseEffect(
    agents.sendMessage({ agentId: agent.id, text: "FOLLOWUP-THIRD", clientMessageId: "inbox-third" }),
  );
  const secondId = second.deliveries[0]?.id;
  const thirdId = third.deliveries[0]?.id;
  assert(secondId && thirdId);
  assert.equal(duplicate.deliveries[0]?.id, secondId);
  assert.equal(mailbox.getDelivery(secondId)?.delivery.status, "queued");
  assert.equal(mailbox.getDelivery(thirdId)?.delivery.status, "queued");
  assert.equal(protocol().filter((entry) => entry.method === "turn/start").length, 1);
  report.checks.push(
    "Multiple messages receive durable receipts while the first turn stays held; duplicate receipt does not duplicate delivery",
  );
  await assert.rejects(
    runCauseEffect(agents.steerQueuedMessage({ agentId: agent.id, deliveryId: secondId, expectedTurnId: turnId })),
  );
  const retained = mailbox.getDelivery(secondId)?.delivery;
  assert.equal(retained?.status, "queued");
  assert.equal(retained?.steerFallback, "steer-failed");
  assert.equal(retained?.error, null);
  report.checks.push("Rejected native steer retains the accepted message and exposes its queued fallback state");
  await assert.rejects(
    runCauseEffect(agents.steerQueuedMessage({ agentId: agent.id, deliveryId: thirdId, expectedTurnId: "old-turn" })),
  );
  assert.equal(mailbox.getDelivery(thirdId)?.delivery.steerFallback, undefined);
  report.checks.push("A stale-turn error is not mislabeled as provider fallback");
  await runCauseEffect(agents.reorderQueue({ agentId: agent.id, deliveryIds: [thirdId, secondId] }));
  assert.deepEqual(mailbox.queuedDeliveryIds(agent.id), [thirdId, secondId]);
  await writeFile(controlPath, JSON.stringify({ release: true }));
  await waitFor("both follow-ups to complete", () =>
    [secondId, thirdId].every((id) => mailbox.getDelivery(id)?.delivery.status === "completed"),
  );
  const starts = protocol().filter((entry) => entry.method === "turn/start");
  assert.equal(starts.length, 3);
  assert(starts[1]?.input.includes("FOLLOWUP-THIRD"));
  assert(starts[2]?.input.includes("FOLLOWUP-SECOND"));
  assert.equal(protocol().filter((entry) => entry.method === "turn/interrupt").length, 0);
  report.checks.push(
    "Send next changes queue order, preserves all messages, drains each once and never interrupts current work",
  );
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  // Machine-readable: the E2E report, without provider credentials or user content.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
