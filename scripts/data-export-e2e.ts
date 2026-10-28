// Checks the local data export of the account menu: the ZIP that `exportOpenBotData` writes on a
// real profile, and the diagnostics report of the same profile. The profile holds two agents, a
// memory, a queued request with an attachment, a running request and a failed request.
// The check unpacks the ZIP and holds that the manifest names the schema version a reader needs,
// that it holds the agent list without the workspace of an agent, that it holds the memory, the
// conversation and the queue rows of every agent, and that the archive holds the attachment file
// with its bytes.
// The profile also holds the secrets that the manifest promises to leave out: an agent API key,
// the header of an MCP server, the key of a custom provider, the environment value of a custom
// agent, a browser cookie and a file in the workspace of an agent. The check holds that no exported
// file names one of them, that no exported file is a file of the profile, and that the exported
// agents hold no path at all.
// A last step calls the real `exportDiagnostics` on the same profile and holds that the report it
// writes holds no conversation text, no file path, no token and no raw error message.
// Run: `bun scripts/data-export-e2e.ts`.
// Writes .openbot-build/data-export-e2e/report.json.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserControlSession, BrowserTab } from "@openbot/contracts/ipc";
import { translateFor } from "@openbot/i18n";
import { plugin } from "bun";
import { Effect } from "effect";
import { strFromU8, unzipSync } from "fflate";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentApiKeys } from "../src/backend/agent-api-keys";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import { StatementTimings } from "../src/main/resource-summary";
import { TraceFile } from "../src/main/trace-file";
import { createDisabledUpdateAdapter, UpdateService } from "../src/main/update-service";

const OUT = resolve(import.meta.dirname, "../.openbot-build/data-export-e2e");
const HOST_VERSION = "0.0.0-e2e";
/** The save dialog answers with the path in this variable. The Electron stub reads it. */
const SAVE_PATH_ENV = "OPENBOT_E2E_SAVE_PATH";
/** The name the manifest of a backup has inside the archive. */
const MANIFEST_NAME = "OpenBot Backup/openbot-data.json";
/** The folder the archive holds every file below. */
const BACKUP_FOLDER = "OpenBot Backup/";

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { passed: boolean; steps: Step[] } = { passed: false, steps: [] };

async function step<T>(
  name: string,
  run: () => Promise<T>,
  summarize: (value: T) => unknown = (value) => value,
): Promise<T> {
  process.stdout.write(`- ${name}\n`);
  try {
    const value = await run();
    report.steps.push({ name, passed: true, detail: summarize(value) });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** A value that `JSON.parse` gives. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isRecord(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, label: string): { [key: string]: Json } {
  assert.ok(isRecord(value), `${label} is not an object.`);
  return value;
}

function member(value: { [key: string]: Json }, key: string, label: string): Json {
  const found = value[key];
  assert.ok(found !== undefined, `${label} has no ${key}.`);
  return found;
}

function list(value: unknown, label: string): Json[] {
  assert.ok(Array.isArray(value), `${label} is not a list.`);
  return value;
}

/** A marker value that the export must never name. Each one names the field it stands for. */
const marker = (label: string): string => `datae2e-${label}-${randomBytes(6).toString("hex")}`;

/** The values the profile holds and the export must leave out. */
const SECRET = {
  apiKey: marker("apikey"),
  mcpToken: marker("mcptoken"),
  providerKey: marker("providerkey"),
  agentEnv: marker("agentenv"),
  cookie: marker("cookie"),
  workspaceFile: marker("workspace"),
};

/** The values the profile holds and the export must keep. */
const KEPT = {
  agentName: marker("name"),
  agentDescription: marker("description"),
  memory: marker("memory"),
  message: marker("message"),
  attachment: marker("attachment"),
};

/** The request the user sent. It holds the text of the conversation. */
const MESSAGE_TEXT = `The first request of the profile ${KEPT.message}`;
/** The text of the file the request carries. */
const ATTACHMENT_TEXT = `The attachment of the profile ${KEPT.attachment}`;
/** The text of the failure of the request that failed. */
const FAILURE_TEXT = `The provider refused the request ${marker("failure")}`;

/** The names of the secrets that an exported file holds. The scan reports the field, not the value. */
function leaks(text: string): string[] {
  return Object.entries(SECRET)
    .filter(([, value]) => text.includes(value))
    .map(([label]) => label);
}

// The main process imports Electron for its windows and its dialogs. No check here opens a window:
// the save dialog answers with the path of the temporary profile, and the browser host of the
// report is a stand-in that counts one tab.
plugin({
  name: "data-export-electron-boundary",
  setup(build) {
    class Inert {}
    build.module("electron", () => ({
      loader: "object",
      exports: {
        app: {
          getPath: () => tmpdir(),
          getVersion: () => HOST_VERSION,
          isPackaged: false,
          on: () => undefined,
          off: () => undefined,
        },
        BrowserWindow: Object.assign(class extends Inert {}, { getAllWindows: () => [] }),
        clipboard: {},
        dialog: {
          showSaveDialog: () => {
            const path = process.env[SAVE_PATH_ENV];
            if (!path) throw new Error(`The save dialog needs ${SAVE_PATH_ENV}.`);
            return { canceled: false, filePath: path };
          },
        },
        Menu: { buildFromTemplate: () => ({}) },
        powerMonitor: { on: () => undefined, off: () => undefined },
        session: { fromPartition: () => ({}) },
        WebContentsView: class extends Inert {},
        webContents: { getAllWebContents: () => [] },
      },
    }));
  },
});

// The modules below import Electron, so they load after the stub above.
const { BrowserHost } = await import("../src/backend/browser-host");
const { exportDiagnostics, exportOpenBotData } = await import("../src/main/maintenance-service");
const { ResourceMonitor } = await import("../src/main/resource-monitor");
const { CustomAgentStore } = await import("../src/main/custom-agent-store");
const { CustomProviderStore } = await import("../src/main/custom-provider-store");

const unused = () => Effect.die(new Error("Not used by this check."));
const agentBrowser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

/** The tab of the browser. The report counts it, and the address of a tab stays in the tab. */
const TABS: BrowserTab[] = [
  {
    id: "tab-e2e-1",
    title: "A tab",
    url: "https://example.invalid/tab",
    loading: false,
    ownerThreadId: null,
    ownerAgentId: null,
  },
];

/** The one session that controls a tab. The report counts the sessions, it holds none of them. */
const CONTROL_SESSIONS: BrowserControlSession[] = [
  {
    id: "control-e2e-1",
    threadId: "thread-e2e-1",
    turnId: "turn-e2e-1",
    callId: "call-e2e-1",
    tabId: "tab-e2e-1",
    action: "click",
    phase: "acting",
    startedAt: new Date().toISOString(),
  },
];

/**
 * The cipher of the custom provider and the custom agent of the profile. The real one is the
 * keychain of the computer; this one keeps the value in the file of the profile, so the check can
 * read it back and hold that the export does not carry it.
 */
const cipher = {
  canPersist: () => true,
  encrypt: (value: string) => Buffer.from(value, "utf8"),
  decrypt: (value: Buffer) => value.toString("utf8"),
};

const root = await mkdtemp(join(tmpdir(), "openbot-data-export-e2e-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const backupPath = join(root, "backup.zip");
const diagnosticsPath = join(root, "diagnostics.json");
const attachmentPath = join(root, "attachment.txt");
process.env[SAVE_PATH_ENV] = backupPath;

interface Host {
  agents: AgentService;
  mailbox: MailboxStore;
  database: OpenBotDatabase;
  apiKeys: AgentApiKeys;
  /** The ids of the two agents of the profile, in the order they were created. */
  agentIds: string[];
  /** The workspace of the first agent, where the file of the agent lives. */
  workspacePath: string;
}

let host: Host | null = null;

/** The running profile of this check. */
function current(): Host {
  assert.ok(host, "The profile is not running.");
  return host;
}

/** The id of the agent at this place in the profile. */
function agentId(index: number): string {
  const id = current().agentIds[index];
  assert.ok(id, `The profile holds no agent at ${index}.`);
  return id;
}

/** Stops the agent service and closes the database of the profile. */
async function stopHost(): Promise<void> {
  if (!host) return;
  await runCauseEffect(host.agents.stop()).catch(() => undefined);
  host.database.close();
}

try {
  await step("the profile holds two agents, a memory, three requests and an attachment", async () => {
    await mkdir(userData, { recursive: true, mode: 0o700 });
    await writeFile(attachmentPath, `${ATTACHMENT_TEXT}\n`, "utf8");
    const database = new OpenBotDatabase(userData);
    const store = new AgentStore(userData, home, database);
    const mailbox = new MailboxStore(userData, store.sharedRoot, database);
    const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
    await runCauseEffect(sidebar.initialize());
    await runCauseEffect(store.initialize());
    await runCauseEffect(mailbox.initialize());
    const apiKeys = new AgentApiKeys(join(userData, "agent-api-keys"));
    const agents = new AgentService({
      store,
      mailbox,
      browser: agentBrowser,
      sidebarLayout: sidebar,
      agentApiKeys: apiKeys,
    });
    host = { agents, mailbox, database, apiKeys, agentIds: [], workspacePath: "" };

    const first = await runCauseEffect(
      agents.createAgentProfile({
        name: KEPT.agentName,
        description: KEPT.agentDescription,
        avatarSeed: "data-export-a",
        avatarHue: null,
      }),
    );
    const second = await runCauseEffect(
      agents.createAgentProfile({
        name: "Second agent",
        description: "A second agent for the queues and the conversations",
        avatarSeed: "data-export-b",
        avatarHue: null,
      }),
    );
    host.agentIds = [first.id, second.id];
    host.workspacePath = first.workspacePath;

    agents.createMemory({ agentId: first.id, text: `The first agent keeps the note ${KEPT.memory}` });

    const queued = await runCauseEffect(
      mailbox.enqueue({
        sender: { kind: "user" },
        recipientAgentIds: [first.id],
        text: MESSAGE_TEXT,
        sourcePaths: [attachmentPath],
      }),
    );
    const running = await runCauseEffect(
      mailbox.enqueue({ sender: { kind: "user" }, recipientAgentIds: [first.id], text: "A second request" }),
    );
    const failed = await runCauseEffect(
      mailbox.enqueue({ sender: { kind: "user" }, recipientAgentIds: [first.id], text: "A third request" }),
    );
    const queuedId = queued.deliveries[0]?.id;
    const runningId = running.deliveries[0]?.id;
    const failedId = failed.deliveries[0]?.id;
    assert.ok(queuedId && runningId && failedId, "Each request has a delivery.");
    await runCauseEffect(mailbox.markStarting(runningId));
    await runCauseEffect(mailbox.markRunning(runningId, "turn-e2e-1"));
    await runCauseEffect(mailbox.markStarting(failedId));
    await runCauseEffect(mailbox.markRunning(failedId, "turn-e2e-2"));
    await runCauseEffect(mailbox.markTerminal(failedId, "failed", FAILURE_TEXT));
    await runCauseEffect(
      mailbox.enqueue({
        sender: { kind: "user" },
        recipientAgentIds: [second.id],
        text: "A request of the second agent",
      }),
    );
    return { agents: host.agentIds.length };
  });

  await step("the profile holds every secret the manifest leaves out", async () => {
    const service = current().agents;
    await runCauseEffect(current().apiKeys.save(agentId(0), "OPENBOT_E2E", SECRET.apiKey));
    await runCauseEffect(
      service.saveMcpServer({
        config: {
          id: "",
          name: "An MCP server",
          transport: "http",
          enabled: true,
          command: "",
          args: [],
          env: [],
          envPassthrough: [],
          workingDirectory: "",
          url: "https://example.invalid/mcp",
          headers: [{ key: "Authorization", value: `Bearer ${SECRET.mcpToken}` }],
        },
      }),
    );
    const providers = new CustomProviderStore({ path: join(userData, "custom-providers.json"), cipher });
    await runCauseEffect(providers.load());
    await runCauseEffect(
      providers.save({
        id: "provider-e2e",
        name: "A custom endpoint",
        baseUrl: "https://example.invalid/v1",
        apiKey: SECRET.providerKey,
        models: [{ id: "model-e2e", name: "A model" }],
        headers: [],
      }),
    );
    const customAgents = new CustomAgentStore({ path: join(userData, "custom-agents.json"), cipher });
    await runCauseEffect(customAgents.load());
    await runCauseEffect(
      customAgents.save({
        id: "agent-e2e",
        name: "A custom agent",
        command: "a-command",
        args: [],
        env: [{ name: "OPENBOT_E2E", value: SECRET.agentEnv }],
        usagePrompt: null,
      }),
    );
    // The browser data of the profile, where the cookies of the user live.
    const cookies = join(userData, "Partitions", "openbot-browser");
    await mkdir(cookies, { recursive: true, mode: 0o700 });
    await writeFile(join(cookies, "Cookies"), `cookie=${SECRET.cookie}\n`, "utf8");
    // The workspace of the agent, where the files of the agent live.
    await mkdir(current().workspacePath, { recursive: true, mode: 0o700 });
    await writeFile(join(current().workspacePath, "note.txt"), `${SECRET.workspaceFile}\n`, "utf8");

    // The profile holds every one of them, so the scan of the export cannot pass because the
    // profile holds nothing.
    const key = await readFile(join(userData, "agent-api-keys", agentId(0), "OPENBOT_E2E"), "utf8");
    assert.equal(key, SECRET.apiKey, "The profile holds no API key of the agent.");
    const servers = service.listMcpServers();
    assert.ok(
      servers.some((server) => server.headers.some((header) => header.value.includes(SECRET.mcpToken))),
      "The profile holds no header of an MCP server.",
    );
    const provider = providers.configs()[0];
    assert.equal(provider?.apiKey, SECRET.providerKey, "The profile holds no key of a custom endpoint.");
    const custom = customAgents.configs()[0];
    assert.equal(
      custom?.env.find((entry) => entry.name === "OPENBOT_E2E")?.value,
      SECRET.agentEnv,
      "The profile holds no environment value of a custom agent.",
    );
    assert.ok(
      (await readFile(join(cookies, "Cookies"), "utf8")).includes(SECRET.cookie),
      "The profile holds no cookie of the browser.",
    );
    assert.ok(
      (await readFile(join(current().workspacePath, "note.txt"), "utf8")).includes(SECRET.workspaceFile),
      "The profile holds no file of the workspace of the agent.",
    );
    return { secrets: Object.keys(SECRET).length };
  });

  const archive = await step(
    "the export writes the archive where the save dialog chose",
    async () => {
      const result = await runCauseEffect(
        exportOpenBotData({
          service: current().agents,
          mailbox: current().mailbox,
          parentWindow: null,
          translate: translateFor("en"),
        }),
      );
      assert.equal(result.saved, true, "The export saved nothing.");
      const mode = statSync(backupPath).mode & 0o777;
      assert.equal(mode, 0o600, `The archive is readable by others: ${mode.toString(8)}.`);
      const bytes = new Uint8Array(await readFile(backupPath));
      const entries = unzipSync(bytes);
      const manifestEntry = entries[MANIFEST_NAME];
      assert.ok(manifestEntry, `The archive holds no ${MANIFEST_NAME}.`);
      return { bytes: bytes.byteLength, entries, manifestText: strFromU8(manifestEntry) };
    },
    (value) => ({ bytes: value.bytes, entries: Object.keys(value.entries).length }),
  );

  const manifestText = archive.manifestText;
  const manifest = object(JSON.parse(manifestText), "The manifest of the archive");

  await step("the manifest names the schema version and the scope", async () => {
    assert.equal(member(manifest, "schemaVersion", "The manifest"), 4, "The manifest has another schema version.");
    const application = object(member(manifest, "application", "The manifest"), "The application of the manifest");
    assert.equal(member(application, "name", "The application"), "OpenBot");
    assert.equal(member(application, "version", "The application"), HOST_VERSION);
    const scope = object(member(manifest, "scope", "The manifest"), "The scope of the manifest");
    const includes = list(member(scope, "includes", "The scope"), "The includes of the scope").map(String);
    for (const category of ["agent profiles", "agent memories", "conversation snapshots", "queues", "attachments"]) {
      assert.ok(includes.includes(category), `The scope does not name ${category}.`);
    }
    const excludes = list(member(scope, "excludes", "The scope"), "The excludes of the scope").map(String);
    for (const category of ["credentials", "API keys", "environment values", "browser cookies", "workspace files"]) {
      assert.ok(
        excludes.some((entry) => entry.includes(category)),
        `The scope does not leave out ${category}.`,
      );
    }
    return { includes: includes.length, excludes: excludes.length };
  });

  await step("the manifest holds the agent list without the workspace of an agent", async () => {
    const agents = list(member(manifest, "agents", "The manifest"), "The agents of the manifest");
    assert.equal(agents.length, 2, "The manifest counts another number of agents.");
    const rows = agents.map((agent) => object(agent, "An agent of the manifest"));
    const first = rows.find((agent) => member(agent, "id", "An agent") === agentId(0));
    assert.ok(first, "The manifest holds no agent of the first agent.");
    assert.equal(member(first, "name", "The agent"), KEPT.agentName, "The agent does not hold its name.");
    assert.equal(
      member(first, "description", "The agent"),
      KEPT.agentDescription,
      "The agent does not hold its description.",
    );
    assert.ok(member(first, "provider", "The agent"), "The agent holds no provider.");
    assert.ok(member(first, "model", "The agent"), "The agent holds no model.");
    // The workspace of an agent is a path of the computer of the user, so the export leaves it out.
    for (const agent of rows) {
      assert.ok(!("workspacePath" in agent), "An agent of the manifest holds its workspace.");
    }
    assert.ok(!manifestText.includes(current().workspacePath), "The manifest names the workspace of an agent.");
    return { agents: rows.length };
  });

  await step("the manifest holds the memory, the conversations and the queues", async () => {
    const memories = list(member(manifest, "memories", "The manifest"), "The memories of the manifest");
    assert.equal(memories.length, 1, "The manifest counts another number of memories.");
    const memory = object(memories[0], "A memory of the manifest");
    assert.equal(member(memory, "text", "The memory"), `The first agent keeps the note ${KEPT.memory}`);
    assert.equal(member(memory, "agentId", "The memory"), agentId(0));

    const conversations = list(member(manifest, "conversations", "The manifest"), "The conversations of the manifest");
    assert.equal(conversations.length, 2, "The manifest counts another number of conversations.");
    const snapshots = conversations.map((conversation) => object(conversation, "A conversation of the manifest"));
    const first = snapshots.find((conversation) => member(conversation, "agentId", "A conversation") === agentId(0));
    assert.ok(first, "The manifest holds no conversation of the first agent.");
    const messages = list(member(first, "messages", "The conversation"), "The messages of the conversation");
    const texts = messages.map((message) => String(member(object(message, "A message"), "text", "A message")));
    assert.ok(texts.includes(MESSAGE_TEXT), "The conversation holds no text of the request.");
    const second = snapshots.find((conversation) => member(conversation, "agentId", "A conversation") === agentId(1));
    assert.ok(second, "The manifest holds no conversation of the second agent.");
    const otherTexts = list(member(second, "messages", "The conversation"), "The messages of the conversation").map(
      (message) => String(member(object(message, "A message"), "text", "A message")),
    );
    assert.ok(
      otherTexts.includes("A request of the second agent"),
      "The conversation holds no text of the second agent.",
    );
    assert.ok(
      !otherTexts.includes(MESSAGE_TEXT),
      "The conversation of the second agent holds the text of the first agent.",
    );

    const queues = list(member(manifest, "queues", "The manifest"), "The queues of the manifest");
    assert.equal(queues.length, 2, "The manifest counts another number of queues.");
    const rows = queues.map((queue) => object(queue, "A queue of the manifest"));
    const busy = rows.find((queue) => member(queue, "agentId", "A queue") === agentId(0));
    assert.ok(busy, "The manifest holds no queue of the first agent.");
    const deliveries = list(member(busy, "deliveries", "The queue"), "The deliveries of the queue");
    assert.equal(deliveries.length, 3, "The queue holds another number of rows.");
    const statuses = deliveries.map((delivery) =>
      String(member(object(delivery, "A delivery"), "status", "A delivery")),
    );
    assert.deepEqual(statuses.sort(), ["failed", "queued", "running"], "The queue holds another state of its rows.");
    const failed = deliveries.find(
      (delivery) => member(object(delivery, "A delivery"), "status", "A delivery") === "failed",
    );
    assert.ok(failed, "The queue holds no failed row.");
    assert.equal(
      member(object(failed, "A delivery"), "error", "A delivery"),
      FAILURE_TEXT,
      "The failed row holds no error of the provider.",
    );
    return { memories: memories.length, conversations: conversations.length, queues: queues.length };
  });

  await step("the archive holds the attachment file with its bytes", async () => {
    const names = Object.keys(archive.entries).filter((name) => name !== MANIFEST_NAME);
    assert.equal(names.length, 1, `The archive holds another number of attachments: ${names.join(", ")}.`);
    const name = names[0];
    assert.ok(name, "The archive holds no attachment.");
    assert.ok(
      name.startsWith(`${BACKUP_FOLDER}attachments/`),
      `The attachment is in no folder of the backup: ${name}.`,
    );
    assert.ok(name.endsWith("-attachment.txt"), `The attachment holds another name: ${name}.`);
    const bytes = archive.entries[name];
    assert.ok(bytes, `The archive holds no ${name}.`);
    assert.equal(strFromU8(bytes), `${ATTACHMENT_TEXT}\n`, "The attachment holds another text.");
    return { attachment: name };
  });

  await step("no exported file names a secret of the profile", async () => {
    const exported = Object.entries(archive.entries)
      .map(([name, bytes]) => `${name}\n${strFromU8(bytes)}`)
      .join("\n");
    const found = leaks(exported);
    assert.deepEqual(found, [], `The export names ${found.join(", ")}.`);
    // The export names no path of the computer of the user either.
    assert.ok(!exported.includes(root), "The export names the path of the profile.");
    assert.ok(!exported.includes(userData), "The export names the path of the data of the profile.");
    assert.ok(!exported.includes(home), "The export names the path of the home folder.");
    return { secrets: Object.keys(SECRET).length };
  });

  await step("the archive holds no file of the profile", async () => {
    const names = Object.keys(archive.entries);
    assert.deepEqual(
      names.filter((name) => !name.startsWith(BACKUP_FOLDER)),
      [],
      "The archive holds a file outside the backup folder.",
    );
    const files = names.filter((name) => name !== MANIFEST_NAME);
    for (const file of files) {
      assert.ok(file.startsWith(`${BACKUP_FOLDER}attachments/`), `The archive holds a file of the profile: ${file}.`);
    }
    return { files: names.length };
  });

  await step("the diagnostics report holds no conversation, no path, no token and no error", async () => {
    process.env[SAVE_PATH_ENV] = diagnosticsPath;
    const trace = new TraceFile({ directory: userData });
    trace.record({ kind: "ipc", name: "maintenance:export-diagnostics", durationMs: 12, outcome: "ok" });
    const resources = new ResourceMonitor({
      userDataPath: userData,
      server: false,
      trace,
      statementTimings: new StatementTimings(),
      tabProcessIds: () => [],
    });
    const updater = new UpdateService(createDisabledUpdateAdapter(), {
      currentVersion: HOST_VERSION,
      enabled: true,
      autoDownload: false,
      beforeInstall: async () => undefined,
    });
    const browser: InstanceType<typeof BrowserHost> = Object.create(BrowserHost.prototype);
    browser.listTabs = () => TABS;
    browser.getControlState = () => ({ sessions: CONTROL_SESSIONS });
    const result = await runCauseEffect(
      exportDiagnostics({
        service: current().agents,
        browser,
        updater,
        trace,
        resources,
        parentWindow: null,
        translate: translateFor("en"),
      }),
    );
    assert.equal(result.saved, true, "The export saved nothing.");
    const text = await readFile(diagnosticsPath, "utf8");
    assert.ok(!text.includes(MESSAGE_TEXT), "The report holds the text of a conversation.");
    assert.ok(!text.includes(FAILURE_TEXT), "The report holds the error of a failed request.");
    assert.ok(!text.includes(root), "The report holds the path of the profile.");
    assert.ok(!text.includes(current().workspacePath), "The report holds the workspace of an agent.");
    assert.ok(!text.includes(attachmentPath), "The report holds the path of the attachment.");
    assert.deepEqual(leaks(text), [], "The report names a secret of the profile.");
    return { bytes: text.length };
  });

  await step("the scan finds a secret that an exported file holds", async () => {
    // The control: the same scan must fail when an exported file holds a secret, so the step above
    // cannot pass because the scan looks for nothing.
    const doctored = `${manifestText}\n${SECRET.apiKey}`;
    assert.deepEqual(leaks(doctored), ["apiKey"], "The scan did not find the secret of the copy.");
    return { found: ["apiKey"] };
  });

  report.passed = true;
} finally {
  await stopHost();
  await rm(root, { recursive: true, force: true });
  delete process.env[SAVE_PATH_ENV];
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
}
