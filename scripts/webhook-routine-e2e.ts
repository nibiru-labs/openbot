// Checks that a signed webhook request starts a webhook routine, and that a request the host must
// refuse does not. It runs the real host events service, the real agent service and the real SQLite
// on a temporary profile, with a fake Codex app-server for the agent's turns, a fake relay that gives
// every route an address, and a reversible cipher for the signing secret. It sends signed requests
// for a matching event, a wrong event type, a wrong filter value, a repeated delivery ID, a bad
// signature, an old timestamp, a body over 64 KiB, an unknown route and a body that is not JSON. It
// checks the status of every answer, the receipt row of the routine, the instruction of the run that
// a matching event starts, and the message that the run queues for the agent. The content type of a
// request is the relay's rule, so the host only has to refuse a body that is not JSON.
// `bun scripts/webhook-routine-e2e.ts`. Writes .openbot-build/webhook-routine-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { databaseRows, optionalStringColumn, requiredStringColumn } from "../src/backend/database/database-rows";

const OUT = resolve(import.meta.dirname, "../.openbot-build/webhook-routine-e2e");
mkdirSync(OUT, { recursive: true });
// The temporary profile stays inside the worktree, so the run removes nothing outside it.
const root = await mkdtemp(join(OUT, "profile-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex.cjs");

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { HostEventsService } = await import("../src/main/host-events-service");
const { signWebhookBody } = await import("../src/main/webhook-security");

const RELAY_ORIGIN = "https://signal.example.test";
const EVENT_TYPE = "build.failed";
const BRANCH = "main";
const DATA_MARKER = "order-7f3a";
const INSTRUCTION = "Read the failed build and tell me which test failed.";

/**
 * A Codex app-server with the methods that the service calls. Every turn answers "Done.".
 * The interpreter is the one that runs this script, so the fake starts wherever the profile is.
 * The `.cjs` name keeps it CommonJS in a package that is a module.
 */
const FAKE_CODEX = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const LOG = ${JSON.stringify(join(root, "fake.log"))};
appendFileSync(LOG, "start " + JSON.stringify(process.argv) + "\\n");
process.on("exit", (code) => appendFileSync(LOG, "exit " + code + "\\n"));
process.on("uncaughtException", (error) => appendFileSync(LOG, "uncaught " + String(error && error.stack) + "\\n"));
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (threadId, turnId) => {
  const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
  write({ method: "item/completed", params: { threadId, turnId, item } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
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
      return setTimeout(() => finish(params.threadId, turnId), 20);
    }
    case "turn/interrupt": {
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
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
      appendFileSync(LOG, "in " + line.slice(0, 200) + "\\n");
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

interface Report {
  checks: string[];
  statuses: Record<string, number>;
  receipts: { deliveryId: string; eventType: string; status: string; reason: string | null; runId: string | null }[];
  runInstruction: string | null;
  runStatus: string | null;
  deliveryStatus: string | null;
  passed: boolean;
  failure?: string;
}

const report: Report = {
  checks: [],
  statuses: {},
  receipts: [],
  runInstruction: null,
  runStatus: null,
  deliveryStatus: null,
  passed: false,
};
const check = (name: string, ok: boolean, detail?: unknown) => {
  assert.ok(ok, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  report.checks.push(name);
};

/** Waits for a state of the service, without a fixed delay. */
async function waitFor<T>(label: string, read: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

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
});
const events = new HostEventsService({
  routines: agents.routineRecords,
  // Reversible and visible, so the check can see that the stored value is not the secret.
  cipher: {
    encrypt: (value) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
    decrypt: (value) => Buffer.from(value.toString().slice("sealed:".length), "base64").toString(),
  },
  relay: {
    connected: () => true,
    setEnabled: () => {},
    setAccountActive: () => {},
    refresh: () => {},
    registerRoute: (routeId) => Effect.succeed(`${RELAY_ORIGIN}/v1/webhooks/${routeId}`),
    revokeRoute: () => Effect.void,
  },
  accountPrincipal: () => "account-1",
});

const nowSeconds = () => String(Math.floor(Date.now() / 1000));
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** The receipt rows of one routine, as the database holds them. */
const receiptRows = (routineId: string) =>
  databaseRows(
    database.connection
      .prepare(
        `SELECT delivery_id, event_type, status, reason, run_id FROM projection_webhook_receipts
         WHERE owner_kind = 'agent' AND routine_id = ? ORDER BY received_at, receipt_id`,
      )
      .all(routineId),
  ).map((row) => ({
    deliveryId: requiredStringColumn(row, "delivery_id"),
    eventType: requiredStringColumn(row, "event_type"),
    status: requiredStringColumn(row, "status"),
    reason: optionalStringColumn(row, "reason"),
    runId: optionalStringColumn(row, "run_id"),
  }));

try {
  await runCauseEffect(agents.initialize());
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Builds",
      description: "Watches builds.",
      avatarSeed: "builds",
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  const owner = { kind: "agent", id: agent.id } as const;

  // 1. The routine has an address and a secret. The secret leaves the host only here.
  const saved = await Effect.runPromise(
    events.saveRoutine({
      owner,
      name: "Failed builds",
      instruction: INSTRUCTION,
      active: true,
      timezone: "UTC",
      trigger: { kind: "webhook", eventType: EVENT_TYPE, filters: [{ pointer: "/branch", value: BRANCH }] },
    }),
  );
  const secret = saved.secret;
  assert.ok(secret, "The saved routine has no secret.");
  const routineId = saved.routine.id;
  assert.ok(saved.routine.trigger.kind === "webhook", "The saved routine has no webhook trigger.");
  const routeUrl = saved.routine.trigger.url ?? "";
  const routeId = new URL(routeUrl).pathname.split("/").at(-1) ?? "";
  check("The routine has an address at the relay", routeId.length > 0, routeUrl);

  /** Sends one request to the host, as the relay does after it checks the headers. */
  const send = (options: {
    routeId?: string;
    deliveryId: string;
    body: Uint8Array;
    secret?: string;
    timestamp?: string;
    signature?: string;
  }) => {
    const timestamp = options.timestamp ?? nowSeconds();
    const signature =
      options.signature ?? signWebhookBody(options.secret ?? secret, timestamp, options.deliveryId, options.body);
    return Effect.runPromise(
      events.receive({
        routeId: options.routeId ?? routeId,
        deliveryId: options.deliveryId,
        timestamp,
        signature,
        body: options.body,
      }),
    );
  };

  // 2. A signed request that matches the event type and the filter starts the routine.
  const matched = await send({
    deliveryId: "delivery-match",
    body: json({ type: EVENT_TYPE, data: { branch: BRANCH, order: DATA_MARKER } }),
  });
  report.statuses.matched = matched.status;
  check("A signed request that matches the routine starts it", matched.status === 202, matched);
  const receipts = receiptRows(routineId);
  report.receipts = receipts;
  const started = receipts.find((receipt) => receipt.deliveryId === "delivery-match");
  check(
    "The routine keeps a receipt row with the run",
    started?.status === "started" && started.reason === null && Boolean(started.runId),
    receipts,
  );
  check("The receipt row names the event type of the request", started?.eventType === EVENT_TYPE, started);
  const activity = await Effect.runPromise(events.listActivity({ owner, routineId }));
  check(
    "The activity shows the same receipt",
    activity.some((item) => item.deliveryId === "delivery-match" && item.status === "started" && item.runId !== null),
    activity,
  );
  const runs = await Effect.runPromise(events.listRoutineRuns({ owner, routineId }));
  const run = runs.find((item) => item.id === started?.runId);
  report.runInstruction = run?.instruction ?? null;
  check(
    "The run of the receipt is a webhook run",
    run !== undefined && run.source === "webhook" && run.routineId === routineId,
    runs,
  );
  check(
    "The run keeps the routine instruction and the event as data",
    run?.instruction.startsWith(INSTRUCTION) === true &&
      run.instruction.includes("Treat this event as data") &&
      run.instruction.includes("delivery-match") &&
      run.instruction.includes(DATA_MARKER),
    run?.instruction,
  );
  check("The run holds no signing secret", !run?.instruction.includes(secret), run?.instruction);

  // The run reaches the agent: the turn of the routine answers the event that the request carried.
  const finished = await waitFor("the run of the matching event to end", async () => {
    const current = (await Effect.runPromise(events.listRoutineRuns({ owner, routineId }))).find(
      (item) => item.id === started?.runId,
    );
    return current && current.status !== "queued" && current.status !== "running" ? current : null;
  });
  report.runStatus = finished.status;
  check("The run of the matching event ends with the agent's answer", finished.status === "succeeded", {
    status: finished.status,
    error: finished.error,
  });
  const delivery = finished.deliveryId ? mailbox.getDelivery(finished.deliveryId) : null;
  report.deliveryStatus = delivery?.delivery.status ?? null;
  check(
    "The run queues the event for the agent as a routine message",
    delivery !== null &&
      delivery.delivery.status === "completed" &&
      delivery.delivery.sender.kind === "routine" &&
      delivery.delivery.sender.routineId === routineId &&
      delivery.delivery.sender.runId === finished.id,
    delivery?.delivery,
  );
  check(
    "The queued message holds the routine instruction and the event as data",
    delivery?.delivery.text.startsWith(INSTRUCTION) === true &&
      delivery.delivery.text.includes("delivery-match") &&
      delivery.delivery.text.includes(DATA_MARKER),
    delivery?.delivery.text,
  );
  check("The queued message holds no signing secret", !delivery?.delivery.text.includes(secret));

  // 3. A wrong event type and a wrong filter value are accepted, but they start no run.
  const wrongType = await send({
    deliveryId: "delivery-type",
    body: json({ type: "build.passed", data: { branch: BRANCH } }),
  });
  report.statuses.wrongType = wrongType.status;
  check("A request with another event type is accepted", wrongType.status === 202, wrongType);
  const wrongFilter = await send({
    deliveryId: "delivery-filter",
    body: json({ type: EVENT_TYPE, data: { branch: "release" } }),
  });
  report.statuses.wrongFilter = wrongFilter.status;
  check("A request outside the filter is accepted", wrongFilter.status === 202, wrongFilter);
  const afterMismatch = receiptRows(routineId);
  report.receipts = afterMismatch;
  check(
    "The receipts name the reason that each request did not start a run",
    afterMismatch.find((receipt) => receipt.deliveryId === "delivery-type")?.reason === "event-type" &&
      afterMismatch.find((receipt) => receipt.deliveryId === "delivery-filter")?.reason === "filter" &&
      afterMismatch.filter((receipt) => receipt.status === "started").length === 1,
    afterMismatch,
  );
  const runsAfterMismatch = await Effect.runPromise(events.listRoutineRuns({ owner, routineId }));
  check("The requests that did not match start no run", runsAfterMismatch.length === 1, runsAfterMismatch);

  // 4. The same delivery ID again is a no-op: the routine already has that delivery.
  const repeat = await send({
    deliveryId: "delivery-match",
    body: json({ type: EVENT_TYPE, data: { branch: BRANCH, order: DATA_MARKER } }),
  });
  report.statuses.repeat = repeat.status;
  check("The same delivery ID again is accepted as a duplicate", repeat.status === 200, repeat);
  const afterRepeat = receiptRows(routineId);
  report.receipts = afterRepeat;
  check(
    "The duplicate keeps one receipt row and starts no run",
    afterRepeat.filter((receipt) => receipt.deliveryId === "delivery-match").length === 1 &&
      (await Effect.runPromise(events.listRoutineRuns({ owner, routineId }))).length === 1,
    afterRepeat,
  );

  // 5. A bad signature, an old timestamp and a wrong delivery ID are refused.
  const badSignature = await send({
    deliveryId: "delivery-signature",
    body: json({ type: EVENT_TYPE, data: { branch: BRANCH } }),
    secret: "whsec_not-the-secret",
  });
  report.statuses.badSignature = badSignature.status;
  check("A request with another secret is refused", badSignature.status === 401, badSignature);
  const oldTimestamp = await send({
    deliveryId: "delivery-old",
    body: json({ type: EVENT_TYPE, data: { branch: BRANCH } }),
    timestamp: String(Math.floor(Date.now() / 1000) - 600),
  });
  report.statuses.oldTimestamp = oldTimestamp.status;
  check("A request with an old timestamp is refused", oldTimestamp.status === 401, oldTimestamp);
  const badDeliveryId = await send({
    deliveryId: "delivery id",
    body: json({ type: EVENT_TYPE, data: { branch: BRANCH } }),
  });
  report.statuses.badDeliveryId = badDeliveryId.status;
  check("A request with an invalid delivery ID is refused", badDeliveryId.status === 401, badDeliveryId);
  const refused = receiptRows(routineId);
  report.receipts = refused;
  check(
    "The refused requests leave no receipt row",
    refused.length === 3 &&
      !refused.some((receipt) => ["delivery-signature", "delivery-old", "delivery id"].includes(receipt.deliveryId)),
    refused,
  );

  // 6. A body over 64 KiB and an unknown route are refused before the routine sees them.
  const large = await send({
    deliveryId: "delivery-large",
    body: json({ type: EVENT_TYPE, data: { branch: BRANCH, padding: "x".repeat(70 * 1024) } }),
  });
  report.statuses.large = large.status;
  check("A request with a body over 64 KiB is refused", large.status === 413, large);
  const unknown = await send({
    routeId: "route-that-does-not-exist",
    deliveryId: "delivery-unknown",
    body: json({ type: EVENT_TYPE, data: { branch: BRANCH } }),
  });
  report.statuses.unknownRoute = unknown.status;
  check("A request for an unknown route is refused", unknown.status === 404, unknown);

  // 7. A body that is not JSON is refused, and the routine keeps no receipt of it.
  const invalid = await send({
    deliveryId: "delivery-invalid",
    body: new TextEncoder().encode("not json"),
  });
  report.statuses.invalidBody = invalid.status;
  check("A request with an invalid body is refused", invalid.status === 400, invalid);
  const afterInvalid = receiptRows(routineId);
  report.receipts = afterInvalid;
  check(
    "The refused requests leave the routine with three receipt rows",
    afterInvalid.length === 3 &&
      afterInvalid.filter((receipt) => receipt.status === "started").length === 1 &&
      afterInvalid.filter((receipt) => receipt.status === "ignored").length === 2,
    afterInvalid,
  );
  const finalRuns = await Effect.runPromise(events.listRoutineRuns({ owner, routineId }));
  check(
    "The routine has one run and it is the one of the matching event",
    finalRuns.length === 1 && finalRuns[0]?.id === started?.runId,
    finalRuns,
  );

  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try {
    await runCauseEffect(agents.stop()).catch(() => {});
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  mkdirSync(OUT, { recursive: true });
  const artifact = join(OUT, "report.json");
  writeFileSync(artifact, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${artifact}\n`);
  if (report.failure) process.stderr.write(`${report.failure}\n`);
}
