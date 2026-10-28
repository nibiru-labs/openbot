// Checks backend reliability bounds for slow starts, configuration warnings, and MCP command lookup.
// Run: bun scripts/backend-reliability-bounds-e2e.ts
// Report: .openbot-build/backend-reliability-bounds-e2e/report.json
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { ProviderRuntime } from "../src/backend/agent/provider-runtime";
import { type AgentClient, RequestTimeoutError } from "../src/backend/agent-client";
import { AgentStore } from "../src/backend/agent-store";
import type { AgentCliInfo } from "../src/backend/cli";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { clearMcpCommandCache, mcpCommandCacheSize, usableMcpServer } from "../src/backend/mcp-provider-shapes";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import type { AppServerNotification, AppServerRequest, ResponseDecoder } from "../src/backend/protocol";
import { ProviderClientOperationError, providerSync } from "../src/backend/provider-client-effects";
import { BUILT_IN_PROVIDER_DRIVERS, NO_PROVIDER_CREDENTIALS } from "../src/backend/provider-drivers";

const OUT = resolve(import.meta.dirname, "../.openbot-build/backend-reliability-bounds-e2e");
const REQUEST_TIMEOUT_MS = 5_000;
const LONG_START_TIMEOUT_MS = 180_000;
/** Must match `REPORTED_CONFIG_WARNING_LIMIT` in provider-runtime.ts. */
const REPORTED_CONFIG_WARNING_LIMIT = 256;
/** Must match `MCP_COMMAND_CACHE_LIMIT` in mcp-provider-shapes.ts. */
const MCP_COMMAND_CACHE_LIMIT = 512;

interface Check {
  name: string;
  passed: boolean;
  detail?: unknown;
}

const report: { passed: boolean; checks: Check[] } = { passed: false, checks: [] };

function record(name: string, passed: boolean, detail?: unknown): void {
  report.checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
  assert.ok(passed, name);
}

function ignoredSummary(index: number): string {
  return `Codex is ignoring 1 unrecognized configuration setting\n  user (/tmp/openbot-e2e-${index}/config.toml): \`tools.e2e${index}\` is ignored.`;
}

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  diagnostic: [message: string];
  exit: [error: Error];
}

class CodexStandIn extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider = "codex" as const;
  readonly initializeCalls: Array<number | undefined> = [];
  /** When true, `initialize` fails on short timeouts to exercise slow-start recovery. */
  slowInitialize = false;
  #running = false;

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    this.#running = true;
  }

  stop() {
    return Effect.sync(() => {
      this.#running = false;
    });
  }

  request<T>(method: string, _params: unknown, decoder: ResponseDecoder<T>, timeoutMs?: number) {
    if (method === "initialize") {
      this.initializeCalls.push(timeoutMs);
      if (!this.slowInitialize || (timeoutMs !== undefined && timeoutMs > 10_000)) {
        return providerSync(() => decoder({}));
      }
      return Effect.fail(new ProviderClientOperationError({ cause: new RequestTimeoutError("Codex", method) }));
    }
    if (method === "account/read") {
      return providerSync(() => decoder({ account: { type: "chatgpt", email: "e2e@test.invalid" } }));
    }
    if (method === "account/rateLimits/read") {
      return providerSync(() => decoder({ rateLimits: null, rateLimitsByLimitId: null }));
    }
    if (method === "model/list") {
      return providerSync(() => decoder({ data: [{ model: "gpt-5.5", displayName: "GPT-5.5" }] }));
    }
    if (method === "plugin/list") {
      return providerSync(() => decoder({ marketplaces: [] }));
    }
    if (method === "config/read") {
      return providerSync(() => decoder({ config: { mcp_servers: {} }, layers: [] }));
    }
    return providerSync(() => decoder({}));
  }

  notify(): void {}
  respond(): void {}
  respondError(): void {}
}

const root = await mkdtemp(join(tmpdir(), "openbot-backend-reliability-bounds-e2e-"));
const codexCli = join(root, "codex.cjs");
await writeFile(
  codexCli,
  `#!${process.execPath}
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.164.0\\n");
  process.exit(0);
}
process.exit(2);
`,
);
await chmod(codexCli, 0o755);
process.env.OPENBOT_CODEX_PATH = codexCli;

const configWarnings: string[] = [];

function createRuntime(standIn: CodexStandIn, name: string): ProviderRuntime {
  const profile = join(root, name);
  const store = new AgentStore(profile, join(root, "home"), new OpenBotDatabase(profile));
  return new ProviderRuntime({
    offProviders: BUILT_IN_PROVIDER_DRIVERS.map((driver) => driver.id).filter((id) => id !== "codex"),
    conversation: new ConversationRuntime(
      store,
      () => undefined,
      () => store.list(),
    ),
    hooks: {
      bindClient: () => undefined,
      onProvidersReady: () => Effect.void,
      onProviderLost: () => undefined,
      onClientStopped: () => Effect.void,
      isStopping: () => false,
      isProviderBusy: () => false,
      isAgentBusy: () => false,
      isProviderAssigned: () => true,
      onAgentClientLost: () => Effect.void,
      sharedRoot: () => join(root, "shared"),
      onProviderResumed: () => undefined,
      onProviderActivated: () => Effect.void,
      captureConfigRevision: () => 0,
    },
    emit: () => undefined,
    emitError: (code) => {
      if (code === "codex_config_ignored") configWarnings.push(code);
    },
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    preferredProvider: "codex",
    clientFactory: (_provider, _cli: AgentCliInfo) => standIn,
    bundledExecutables: {},
    credentials: NO_PROVIDER_CREDENTIALS,
    redactMcp: (text) => text,
  });
}

async function waitFor(label: string, check: () => boolean, waitMs = 30_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resume) => setTimeout(resume, 50));
  }
}

try {
  // Finding 12: a provider that timed out once uses the normal start budget again after initialize succeeds.
  const slowStandIn = new CodexStandIn();
  slowStandIn.slowInitialize = true;
  const slowStartRuntime = createRuntime(slowStandIn, "slow-start");
  runCauseEffect(slowStartRuntime.ensureProvider("codex")).catch(() => {});
  await waitFor("the first initialize attempt", () => slowStandIn.initializeCalls.length >= 1);
  await waitFor("the long-timeout retry", () => slowStandIn.initializeCalls.length >= 2, 20_000);
  await waitFor(
    "codex to connect",
    () => slowStartRuntime.status().providers?.find((row) => row.id === "codex")?.state === "available",
    20_000,
  );
  const firstTimeout = slowStandIn.initializeCalls[0];
  const retryTimeout = slowStandIn.initializeCalls[1];
  record("slow start: first initialize does not use the long start timeout", firstTimeout !== LONG_START_TIMEOUT_MS, {
    firstTimeout,
  });
  record("slow start: retry uses the long start timeout", retryTimeout === LONG_START_TIMEOUT_MS, { retryTimeout });
  slowStandIn.initializeCalls.length = 0;
  slowStandIn.emit("exit", new Error("e2e disconnect"));
  await new Promise((resume) => setTimeout(resume, 100));
  runCauseEffect(slowStartRuntime.refreshProvider("codex")).catch(() => {});
  await waitFor("refresh initialize", () => slowStandIn.initializeCalls.length >= 1, 20_000);
  const afterSuccess = slowStandIn.initializeCalls[0];
  record(
    "slow start: a later start does not use the long start timeout again",
    afterSuccess !== LONG_START_TIMEOUT_MS,
    { afterSuccess },
  );
  const handed = await runCauseEffect(slowStartRuntime.dispose());
  for (const client of handed) await runCauseEffect(client.stop());

  // Finding 13: shown configuration warnings stay bounded and drop the oldest entry.
  configWarnings.length = 0;
  const warningStandIn = new CodexStandIn();
  const warningRuntime = createRuntime(warningStandIn, "config-warnings");
  await runCauseEffect(warningRuntime.ensureProvider("codex"));
  for (let index = 0; index < REPORTED_CONFIG_WARNING_LIMIT; index += 1) {
    warningStandIn.emit("notification", { method: "configWarning", params: { summary: ignoredSummary(index) } });
  }
  record(
    "config warnings: each distinct warning is shown once",
    configWarnings.length === REPORTED_CONFIG_WARNING_LIMIT,
    {
      count: configWarnings.length,
    },
  );
  warningStandIn.emit("notification", { method: "configWarning", params: { summary: ignoredSummary(0) } });
  record(
    "config warnings: a warning still in the set is not shown again",
    configWarnings.length === REPORTED_CONFIG_WARNING_LIMIT,
  );
  warningStandIn.emit("notification", {
    method: "configWarning",
    params: { summary: ignoredSummary(REPORTED_CONFIG_WARNING_LIMIT) },
  });
  record(
    "config warnings: a new warning evicts the oldest",
    configWarnings.length === REPORTED_CONFIG_WARNING_LIMIT + 1,
    {
      count: configWarnings.length,
    },
  );
  configWarnings.length = 0;
  warningStandIn.emit("notification", { method: "configWarning", params: { summary: ignoredSummary(0) } });
  record("config warnings: an evicted warning can be shown again", configWarnings.length === 1);
  const warningHanded = await runCauseEffect(warningRuntime.dispose());
  for (const client of warningHanded) await runCauseEffect(client.stop());

  // Finding 14: MCP command lookup cache stays bounded.
  clearMcpCommandCache();
  record("mcp command cache: starts empty", mcpCommandCacheSize() === 0);
  const stdioBase = (): McpServerConfig => ({
    id: "e2e-cache",
    name: "e2e_cache",
    transport: "stdio",
    enabled: true,
    command: "node",
    args: [],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: "",
    headers: [],
  });
  for (let index = 0; index < MCP_COMMAND_CACHE_LIMIT + 16; index += 1) {
    const config = stdioBase();
    config.env = [{ key: "PATH", value: `/tmp/openbot-e2e-cache-${index}:/usr/local/bin` }];
    await runCauseEffect(usableMcpServer(config));
  }
  const cacheSize = mcpCommandCacheSize();
  record("mcp command cache: holds resolved lookups", cacheSize > 0, { cacheSize });
  record("mcp command cache: stays within the limit", cacheSize <= MCP_COMMAND_CACHE_LIMIT, { cacheSize });
  clearMcpCommandCache();

  report.passed = true;
} finally {
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  delete process.env.OPENBOT_CODEX_PATH;
  await rm(root, { recursive: true, force: true });
}

if (!report.passed) process.exitCode = 1;
