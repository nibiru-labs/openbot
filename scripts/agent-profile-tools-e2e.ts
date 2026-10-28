// Checks that an agent creates an agent and edits its profile with the `create_agent` and
// `update_profile` tools of the real tool router, that `read_agent` reads the profile back, and that
// the profile is still there after the agent store restarts. A request for an agent that does not
// exist and a request that widens what an agent may do are refused with the text of the error
// catalog, and a profile with an invalid avatar hue is refused with the field that is wrong.
// Runs the real agent service, tool router and agent store on a temporary profile with a fake Codex
// app-server. The fake calls the tools through `tool_call`, as a model does, and logs the result.
// `bun scripts/agent-profile-tools-e2e.ts`.
// Writes .openbot-build/agent-profile-tools-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { z } from "zod";
import type { createAgentToolSchema, updateProfileToolSchema } from "../src/backend/agent/profile-tools";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/agent-profile-tools-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-profile-tools-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");

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

/** The arguments the fake passes to a profile tool. */
type ProfileToolArgs = z.input<typeof updateProfileToolSchema> &
  Pick<z.input<typeof createAgentToolSchema>, "initialMessage">;

const CALL_MARK = "PROFILE-CALL";
const MODEL = "gpt-6-luna";
const CATALOG = [
  { model: MODEL, displayName: "GPT-6 Luna" },
  { model: "gpt-6-sol", displayName: "GPT-6 Sol" },
];

/** The profile the check writes with `create_agent` and then changes with `update_profile`. */
const PROFILE = {
  name: "Field Notes",
  title: "Field notes keeper",
  description: "Keeps the notes of every field visit and writes a short summary of each one.",
  avatarSeed: "field-notes",
  avatarHue: 185,
};
const EDITED_PROFILE = {
  name: "Field Notes Two",
  title: "Notes keeper",
  description: "Keeps the notes of every field visit and files them under the day they were made.",
  avatarSeed: "field-notes-two",
  avatarHue: 320,
};

/**
 * A Codex app-server with the methods that the service calls. A turn whose input has
 * `PROFILE-CALL <<ARGS{json}ARGS>>` calls the `__tool` that the JSON names with the other fields
 * through `tool_call`, logs the result, and ends. Other turns answer "Done.".
 */
const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
/** Tool request id -> the turn that waits for its result. */
const waiting = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const log = (entry) => appendFileSync(LOG, JSON.stringify(entry) + "\\n");
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
    case "model/list": return write({ id: message.id, result: { data: ${JSON.stringify(CATALOG)} } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + process.pid + "-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const match = text.includes(${JSON.stringify(CALL_MARK)}) ? /<<ARGS([\\s\\S]*?)ARGS>>/.exec(text) : null;
      if (!match) return setTimeout(() => finish(params.threadId, turnId), 20);
      const id = "tool-" + turnId;
      waiting.set(id, { threadId: params.threadId, turnId });
      const { __tool, ...args } = JSON.parse(match[1]);
      return write({
        id,
        method: "item/tool/call",
        params: {
          threadId: params.threadId,
          turnId,
          callId: "call-" + turnId,
          namespace: "openbot",
          tool: "tool_call",
          arguments: { name: "openbot." + __tool, arguments: args },
        },
      });
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
      if (message.method && message.id !== undefined) answer(message);
      else if (!message.method && waiting.has(message.id)) {
        const turn = waiting.get(message.id);
        waiting.delete(message.id);
        log({ turnId: turn.turnId, result: message.result ?? null, error: message.error ?? null });
        finish(turn.threadId, turn.turnId);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

interface ToolLog {
  turnId: string;
  result: { success: boolean; contentItems: { type: string; text: string }[] } | null;
  error: unknown;
}

/** The fields of a profile that the check reads. The router sends them as JSON text. */
interface ProfileBody {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  avatarSeed?: string;
  avatarHue?: number | null;
}

const report: {
  calls: { name: string; success: boolean; text: string }[];
  created?: ProfileBody;
  edited?: ProfileBody;
  afterRestart?: ProfileBody;
  checks: { name: string; passed: boolean }[];
  passed: boolean;
  error?: string;
} = { calls: [], checks: [], passed: false };

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

/** Waits for a state of the service or the fake's log. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function toolLogs(): ToolLog[] {
  let text = "";
  try {
    text = readFileSync(fakeLog, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The text of a tool failure. The router sends it as `{"error": "..."}`. */
function failureText(text: string): string {
  try {
    const parsed: { error?: unknown } = JSON.parse(text);
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // A failure that is plain text.
  }
  return text;
}

function pass(name: string, condition: boolean, detail?: string) {
  report.checks.push({ name, passed: condition });
  assert.ok(condition, detail ? `${name}: ${detail}` : name);
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
});

const idle = (agentId: string) =>
  agents
    .listQueue(agentId)
    .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status));

/** Sends a chat message that makes the fake call the tool, and returns the tool result it logged. */
async function callTool(name: string, agentId: string, tool: string, args: Partial<ProfileToolArgs> = {}) {
  const receipt = await runCauseEffect(
    agents.sendMessage({ agentId, text: `${CALL_MARK} <<ARGS${JSON.stringify({ __tool: tool, ...args })}ARGS>>` }),
  );
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId, `${name}: no delivery`);
  const turnId = await waitFor(`${name} turn`, () => mailbox.getDelivery(deliveryId)?.delivery.turnId);
  const entry = await waitFor(`${name} tool result`, () => toolLogs().find((log) => log.turnId === turnId));
  await waitFor(`${name} turn end`, () => {
    const status = mailbox.getDelivery(deliveryId)?.delivery.status;
    return status === "completed" || status === "failed" || status === "interrupted";
  });
  const text = entry.result?.contentItems.map((item) => item.text).join("\n") ?? "";
  report.calls.push({ name, success: entry.result?.success === true, text });
  let body: ProfileBody | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A failure is plain text.
  }
  return { success: entry.result?.success === true, text, body };
}

const storedAgent = (agentId: string) => {
  const agent = store.list().find((candidate) => candidate.id === agentId);
  assert.ok(agent, "The agent is missing from the store.");
  return agent;
};

try {
  await runCauseEffect(agents.initialize());
  const coordinator = await runCauseEffect(
    agents.createAgent({
      name: "Coordinator",
      description: "Coordinates the work of the other agents.",
      avatarSeed: "coordinator",
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor("the first chat turn to end", () => idle(coordinator.id));

  // 1. create_agent makes the agent with the profile the caller asked for.
  const created = await callTool("create agent", coordinator.id, "create_agent", {
    ...PROFILE,
    initialMessage: "Hello.",
  });
  pass("create_agent succeeds", created.success, created.text);
  report.created = {
    id: created.body?.id,
    name: created.body?.name,
    title: created.body?.title,
    description: created.body?.description,
    avatarSeed: created.body?.avatarSeed,
    avatarHue: created.body?.avatarHue ?? null,
  };
  pass(
    "create_agent returns the profile it was asked for",
    created.body?.name === PROFILE.name &&
      created.body?.title === PROFILE.title &&
      created.body?.description === PROFILE.description &&
      created.body?.avatarSeed === PROFILE.avatarSeed &&
      created.body?.avatarHue === PROFILE.avatarHue,
    created.text,
  );
  const createdId = created.body?.id;
  assert.ok(createdId, "create_agent returned no agent id.");
  const storedCreated = storedAgent(createdId);
  pass(
    "The store holds the new agent with that profile",
    storedCreated.name === PROFILE.name &&
      storedCreated.title === PROFILE.title &&
      storedCreated.description === PROFILE.description &&
      storedCreated.avatarSeed === PROFILE.avatarSeed &&
      storedCreated.avatarHue === PROFILE.avatarHue,
    JSON.stringify(storedCreated),
  );
  pass("The new agent has a workspace of its own", storedCreated.workspacePath.length > 0);

  // 2. read_agent reads the profile back.
  const read = await callTool("read agent", coordinator.id, "read_agent", { agentId: createdId });
  pass("read_agent succeeds", read.success, read.text);
  pass(
    "read_agent returns the profile of the new agent",
    read.body?.id === createdId &&
      read.body?.name === PROFILE.name &&
      read.body?.title === PROFILE.title &&
      read.body?.description === PROFILE.description,
    read.text,
  );

  // 3. update_profile changes the profile of that agent.
  await waitFor("the new agent to be idle", () => idle(createdId));
  const edited = await callTool("edit profile", coordinator.id, "update_profile", {
    agentId: createdId,
    ...EDITED_PROFILE,
  });
  pass("update_profile succeeds", edited.success, edited.text);
  report.edited = {
    id: edited.body?.id,
    name: edited.body?.name,
    title: edited.body?.title,
    description: edited.body?.description,
    avatarSeed: edited.body?.avatarSeed,
    avatarHue: edited.body?.avatarHue ?? null,
  };
  pass(
    "update_profile returns the profile it wrote",
    edited.body?.id === createdId &&
      edited.body?.name === EDITED_PROFILE.name &&
      edited.body?.title === EDITED_PROFILE.title &&
      edited.body?.description === EDITED_PROFILE.description &&
      edited.body?.avatarSeed === EDITED_PROFILE.avatarSeed &&
      edited.body?.avatarHue === EDITED_PROFILE.avatarHue,
    edited.text,
  );
  const storedEdited = storedAgent(createdId);
  pass(
    "The store holds the edited profile",
    storedEdited.name === EDITED_PROFILE.name &&
      storedEdited.title === EDITED_PROFILE.title &&
      storedEdited.description === EDITED_PROFILE.description &&
      storedEdited.avatarSeed === EDITED_PROFILE.avatarSeed &&
      storedEdited.avatarHue === EDITED_PROFILE.avatarHue,
    JSON.stringify(storedEdited),
  );
  const readEdited = await callTool("read the edited agent", coordinator.id, "read_agent", { agentId: createdId });
  pass(
    "read_agent returns the edited profile",
    readEdited.success &&
      readEdited.body?.name === EDITED_PROFILE.name &&
      readEdited.body?.title === EDITED_PROFILE.title &&
      readEdited.body?.description === EDITED_PROFILE.description,
    readEdited.text,
  );

  // 4. An agent that does not exist is refused with the text of the error catalog.
  const unknown = await callTool("unknown agent", coordinator.id, "update_profile", {
    agentId: "no-such-agent",
    name: "Nothing",
  });
  pass(
    "An unknown agent is refused with the text of the error catalog",
    !unknown.success && failureText(unknown.text) === sourceText("error.agent.unknown", { id: "no-such-agent" }),
    unknown.text,
  );
  pass(
    "The refused request changed nothing",
    storedAgent(createdId).name === EDITED_PROFILE.name &&
      storedAgent(createdId).description === EDITED_PROFILE.description,
    storedAgent(createdId).name,
  );

  // 5. An agent may not widen what another agent may do.
  const restricted = await callTool("restrict access", coordinator.id, "update_profile", {
    agentId: createdId,
    access: "workspace",
  });
  pass("A restriction of the access is allowed", restricted.success, restricted.text);
  const widened = await callTool("widen access", coordinator.id, "update_profile", {
    agentId: createdId,
    access: "full",
  });
  pass(
    "A widening of the access is refused with the text of the error catalog",
    !widened.success && failureText(widened.text) === sourceText("error.agent.onlyUserWidensSettings"),
    widened.text,
  );
  pass("The refused widening left the restriction", storedAgent(createdId).access === "workspace");

  // 6. A profile with a value that no agent may have is refused, and the profile stays as it is.
  const invalid = await callTool("invalid avatar hue", coordinator.id, "update_profile", {
    agentId: createdId,
    avatarHue: 7,
  });
  pass(
    "An invalid avatar hue is refused with the field that is wrong",
    !invalid.success &&
      failureText(invalid.text).includes("avatarHue") &&
      failureText(invalid.text).includes("Correct the arguments and retry."),
    invalid.text,
  );
  pass(
    "The refused profile changed nothing",
    storedAgent(createdId).avatarHue === EDITED_PROFILE.avatarHue,
    String(storedAgent(createdId).avatarHue),
  );

  // 7. The profile is still there after the agent store restarts.
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  const restartedDatabase = new OpenBotDatabase(userData);
  const restartedStore = new AgentStore(userData, home, restartedDatabase);
  await runCauseEffect(restartedStore.initialize());
  const afterRestart = restartedStore.list().find((candidate) => candidate.id === createdId);
  assert.ok(afterRestart, "The agent is missing after the restart of the store.");
  report.afterRestart = {
    id: afterRestart.id,
    name: afterRestart.name,
    title: afterRestart.title,
    description: afterRestart.description,
    avatarSeed: afterRestart.avatarSeed,
    avatarHue: afterRestart.avatarHue,
  };
  pass(
    "The edited profile survives the restart of the agent store",
    afterRestart.name === EDITED_PROFILE.name &&
      afterRestart.title === EDITED_PROFILE.title &&
      afterRestart.description === EDITED_PROFILE.description &&
      afterRestart.avatarSeed === EDITED_PROFILE.avatarSeed &&
      afterRestart.avatarHue === EDITED_PROFILE.avatarHue &&
      afterRestart.access === "workspace",
    JSON.stringify(afterRestart),
  );
  pass("The other agents are still there after the restart", restartedStore.list().length === 2);
  restartedDatabase.close();
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
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
