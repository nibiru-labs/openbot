// Checks the real backend for the failures that were hidden: a tool call whose discovery failed
// names its cause, a usage read that failed is reported and the token budget reads again on the
// next report, and the hosted-site marker retry stops after a bounded number of attempts and
// leaves its row for the next start.
// The real AgentService, SQLite and a fake Codex process run the first two; the real
// HostedSiteCoordinator and SQLite run the third. No model or credentials.
// Run: `bun scripts/failure-reporting-e2e.ts`.
// Writes .openbot-build/failure-reporting-e2e/report.json.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent, type TokenBudgetPreference } from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { AgentClient } from "../src/backend/agent-client";
import { getString, isRecord } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/failure-reporting-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-failure-reporting-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const logPath = join(root, "protocol.jsonl");
const fakeCodex = join(root, "codex");

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.OPENBOT_CODEX_PATH = fakeCodex;
process.env.OPENBOT_FAKE_CODEX_LOG = logPath;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { ConversationRuntime } = await import("../src/backend/agent/conversation-runtime");
const { HostedSiteCoordinator } = await import("../src/backend/agent/hosted-site-coordinator");

/**
 * A turn whose input has TOKENS-n reports n times 400 tokens and finishes. A turn whose input has
 * TOOL-1 asks the host for a tool catalog with arguments that no tool takes, and finishes.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const log = (entry) => fs.appendFileSync(process.env.OPENBOT_FAKE_CODEX_LOG, JSON.stringify(entry) + "\\n");
const config = { config: { mcp_servers: {} }, layers: [] };
let buffer = "";
let threads = 0;
let turns = 0;
/** threadId -> cumulative counters, as Codex reports them. */
const totals = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (threadId, turnId) => {
  write({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" } } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
const reportUsage = (threadId, turnId) => {
  const total = totals.get(threadId) || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  total.inputTokens += 300;
  total.outputTokens += 100;
  totals.set(threadId, total);
  const usage = { total: { ...total, totalTokens: total.inputTokens + total.outputTokens }, last: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 100, totalTokens: 400 } };
  write({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { ...usage, modelContextWindow: 1000000 } } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null } } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-5.5", displayName: "GPT-5.5" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": {
      const threadId = "thread-" + (++threads);
      return write({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
    }
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + (++turns);
      const threadId = params.threadId;
      const input = JSON.stringify(params.input);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
      setTimeout(() => {
        if (input.includes("TOOL-1")) {
          write({ id: 900 + turns, method: "item/tool/call", params: { threadId, turnId, callId: "call-1", namespace: "openbot", tool: "tool_search", arguments: { queries: 42 } } });
          finish(threadId, turnId);
          return;
        }
        if (input.includes("TOKENS-")) reportUsage(threadId, turnId);
        finish(threadId, turnId);
      }, 60);
      return;
    }
    default: return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
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
        log({ response: message });
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

/** Every message the fake Codex read, oldest first. */
function protocol(): DynamicRecord[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => recordOf(JSON.parse(line)));
  } catch {
    return [];
  }
}

/** The answer the host gave the tool call of the fake Codex. */
function toolAnswer() {
  const answer = protocol().find((entry) => recordOf(entry.response).id === 901);
  return answer ? recordOf(answer.response) : null;
}

/** Waits for a state of the service or of the fake Codex. */
async function waitFor<T>(
  label: string,
  read: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** The client the coordinator answers: it only has to take the response of a marker. */
function markerClient(): AgentClient {
  const client = {
    provider: "codex" as const,
    running: true,
    start: () => {},
    stop: () => Effect.void,
    request: () => Effect.die(new Error("Not used by this check.")),
    notify: () => {},
    respond: () => {},
    respondError: () => {},
    on: () => client,
    once: () => client,
    off: () => client,
  };
  return client;
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
// The fake Codex is CommonJS. A temporary folder inside the repository has its package.json above
// it, and that one says that a file without an extension is an ES module.
await writeFile(join(root, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
let limits: TokenBudgetPreference = { perHour: 0, perTurn: 0 };
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  busyMessageMode: () => "queue",
  tokenBudget: () => limits,
});

const events: AgentEvent[] = [];
agents.on("event", (event) => events.push(event));
const errorCodes = () => events.filter((event) => event.type === "error").map((event) => event.code);
const pauses = () =>
  events.filter(
    (event): event is Extract<AgentEvent, { type: "agent-paused" }> =>
      event.type === "agent-paused" && event.reason === "hour-budget",
  );

const report: { passed: boolean; checks: string[]; error?: string } = { passed: false, checks: [] };
try {
  await runCauseEffect(agents.initialize());
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Failures",
      description: "Synthetic",
      avatarSeed: "failures",
      avatarHue: null,
      initialMessage: "TOOL-1",
    }),
  );
  const status = (deliveryId: string) => mailbox.getDelivery(deliveryId)?.delivery.status ?? null;

  // 1. A tool call whose discovery fails names its cause, and the agent still gets the sentence.
  const answer = await waitFor("the answer to the tool call", () => toolAnswer());
  const result = recordOf(answer.result);
  assert.equal(result.success, false, "the tool call did not fail");
  const items = Array.isArray(result.contentItems) ? result.contentItems : [];
  const text = getString(recordOf(items[0]), "text") ?? "";
  assert(text.includes("error"), `the tool answer has no error: ${text}`);
  await waitFor("the failure of the tool discovery", () => errorCodes().includes("tool_discovery_failed"));
  report.checks.push("A failed tool discovery reports its cause and answers the agent with the generic sentence");

  // 2. A usage read that fails is reported, and the next report reads the database again.
  limits = { perHour: 1_500, perTurn: 0 };
  const now = new Date().toISOString();
  database.connection
    .prepare(
      `INSERT INTO agent_usage_records
         (agent_id, record_id, session_id, turn_id, provider, model, occurred_at, tokens_json, estimated_cost_usd, rate_basis, recorded_at)
       VALUES (?, 'older-usage', 'session-old', 'turn-old', 'codex', 'gpt-5.5', ?, ?, NULL, NULL, ?)`,
    )
    .run(agent.id, now, JSON.stringify({ uncachedInput: 1_000, cachedInput: 0, cacheCreation: 0, output: 0 }), now);
  // A row whose tokens no decoder takes: the read of the window fails, the writes do not.
  database.connection
    .prepare(
      `INSERT INTO agent_usage_records
         (agent_id, record_id, session_id, turn_id, provider, model, occurred_at, tokens_json, estimated_cost_usd, rate_basis, recorded_at)
       VALUES (?, 'broken-usage', 'session-old', 'turn-old', 'codex', 'gpt-5.5', ?, '[]', NULL, NULL, ?)`,
    )
    .run(agent.id, now, now);

  let sends = 0;
  const send = async (text: string) => {
    const receipt = await runCauseEffect(
      agents.sendMessage({ agentId: agent.id, text, clientMessageId: `send-${++sends}` }),
    );
    const id = receipt.deliveries[0]?.id;
    assert(id, `no delivery for ${text}`);
    return id;
  };
  const first = await send("TOKENS-1");
  await waitFor("the first turn to end", () => status(first) === "completed");
  await waitFor("the failure of the usage read", () => errorCodes().includes("token_budget_read_failed"));
  assert.equal(pauses().length, 0, "the limit held on a count the database never gave");
  report.checks.push("A failed usage read is reported and the count of the window stays unknown");

  // The next report reads the database again, so the count holds the usage of the earlier session.
  database.connection.prepare("DELETE FROM agent_usage_records WHERE record_id = 'broken-usage'").run();
  const second = await send("TOKENS-2");
  await waitFor("the second turn to end", () => status(second) === "completed");
  const hold = await waitFor("the hourly hold", () => pauses()[0], 30_000);
  assert.equal(hold.reason, "hour-budget");
  report.checks.push("The next good read counts the usage of the database, so the hourly limit holds");

  // 3. The hosted-site marker retry is bounded, and the row waits for the next start.
  const siteData = join(root, "site-data");
  const siteHome = join(root, "site-home");
  mkdirSync(siteHome, { recursive: true });
  const siteDatabase = new OpenBotDatabase(siteData);
  await runCauseEffect(siteDatabase.initialize());
  const siteStore = new AgentStore(siteData, siteHome, siteDatabase);
  const siteConversation = new ConversationRuntime(
    siteStore,
    () => {},
    () => siteStore.list(),
  );
  const siteAgent = await runCauseEffect(
    siteStore.createAgent({
      name: "Site",
      description: "Synthetic",
      avatarSeed: "site",
      avatarHue: null,
    }),
  );
  const siteErrors: Array<{ code: string; message: string }> = [];
  const siteCoordinator = new HostedSiteCoordinator({
    store: siteStore,
    conversation: siteConversation,
    hostedSites: null,
    emitError: (code, error) => siteErrors.push({ code, message: String(error) }),
    isStopping: () => false,
  });
  // The marker write fails, the row of the pending event does not.
  siteDatabase.connection.exec(
    "CREATE TRIGGER blocked_marker BEFORE INSERT ON projection_thread_messages BEGIN SELECT RAISE(ABORT, 'marker blocked'); END;",
  );
  const operationId = randomUUID();
  const mutation = {
    agentId: siteAgent.id,
    operationId,
    action: "publish" as const,
    params: {
      threadId: siteStore.ensureThreadIdNow(siteAgent.id),
      turnId: "turn-1",
      callId: operationId,
      namespace: "openbot" as const,
      tool: "publish_site" as const,
      arguments: {},
    },
    eventDetails: { siteId: null, title: "Site", hostname: null, url: null },
  };
  const client = markerClient();
  await runCauseEffect(
    siteCoordinator.resolveApproval(mutation, { client, id: "request-1", agentId: siteAgent.id }, "decline"),
  );
  await waitFor("the failure of the marker write", () =>
    siteErrors.some((entry) => entry.code === "hosted_site_marker_persistence_failed"),
  );
  assert.equal(
    siteErrors.filter((entry) => entry.code === "hosted_site_marker_persistence_failed").length,
    1,
    "the failure was reported more than once",
  );
  await waitFor(
    "the end of the retries",
    () => siteErrors.some((entry) => entry.code === "hosted_site_marker_retry_exhausted"),
    60_000,
  );
  assert.equal(siteDatabase.pendingHostedSiteTerminalEvents().length, 1, "the row did not wait for the next start");
  report.checks.push(
    "The marker retry reports the failure once, stops after a bounded number of attempts and leaves its row",
  );

  // The next start writes the marker the failed writes left behind.
  siteDatabase.connection.exec("DROP TRIGGER blocked_marker");
  const restarted = new HostedSiteCoordinator({
    store: siteStore,
    conversation: siteConversation,
    hostedSites: null,
    emitError: (code, error) => siteErrors.push({ code, message: String(error) }),
    isStopping: () => false,
  });
  restarted.restore();
  assert.equal(siteDatabase.pendingHostedSiteTerminalEvents().length, 0, "the marker was not written");
  const page = siteDatabase.readConversationPage(siteAgent.id, mutation.params.threadId, { type: "latest" }, 50);
  assert(
    page.messages.some((message) => message.itemType === `hosted-site-event:publish:cancelled:${operationId}`),
    "the marker is not in the conversation",
  );
  report.checks.push("The next start writes the marker the bounded retries left behind");

  siteCoordinator.dispose();
  restarted.dispose();
  siteDatabase.close();
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
