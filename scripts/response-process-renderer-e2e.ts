// Runs the real desktop renderer against a fake Codex app-server: process notes stay visible while a
// turn runs and after an empty reasoning completion, and the header avatar shows its working mood.
// Needs a built app in `out/` (`bun run build`). On headless Linux run
// `ELECTRON_OVERRIDE_DIST_PATH=/opt/openbot-task-tools/electron-runtime xvfb-run -a bun scripts/response-process-renderer-e2e.ts`.
// Writes .openbot-build/response-process-renderer-e2e/report.json and one screenshot.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ConversationPage, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import type { Page } from "playwright-core";
import { chromium, type Page as PlaywrightPage } from "playwright-core";
import { developmentInstanceIdForWorktree, developmentUserDataName } from "../src/main/development-profile";
import { BENCH_ACCOUNT_EMAIL, type BenchAuthApi, signInBenchAccount } from "./dev-automation/bench-auth";
import { type BenchApp, launchBenchApp } from "./dev-automation/bench-launch";
import { verifyBrowserOwnership } from "./dev-automation/cdp-client";
import {
  type DevInstanceRecord,
  removeDevInstanceRecord,
  writeDevInstanceRecord,
} from "./dev-automation/instance-registry";
import { resolveDevelopmentAppDataRoot } from "./development-state-paths";
import { withoutElectronRuntimeFlags } from "./electron-spawn-env";
import {
  BLOCK_SUMMARY_TEXT,
  FAKE_CODEX_RESPONSE_PROCESS,
  FINAL_ANSWER_TEXT,
  STREAMED_NOTE_TEXT,
} from "./fake-codex-response-process-e2e";

declare global {
  interface Window {
    openbot: OpenBotDesktopApi;
  }
}

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/response-process-renderer-e2e");
const INSTANCE_ID = developmentInstanceIdForWorktree(`${ROOT}#response-process-renderer-e2e`);
const WAIT_MS = 120_000;
const APP_START_MS = 240_000;
const english = translateFor("en");
const PROCESS_RUNNING = english("chat.process.running");
const PROCESS_COMPLETED = english("chat.process.completed");
const PROMPT = "Run the response process renderer check.";
const AGENT_NAME = "Process renderer E2E";

interface Acceptance {
  appStarted: boolean;
  processNotesVisibleDuringTurn: boolean;
  processNotesNonEmptyDuringTurn: boolean;
  headerAvatarWorkingDuringTurn: boolean;
  processNotesReadableAfterCompletion: boolean;
  emptyCompletionKeptStreamedText: boolean;
  finalAnswerVisible: boolean;
}

interface Report {
  acceptance: Acceptance;
  screenshot: string | null;
  passed: boolean;
  error?: string;
}

const acceptance: Acceptance = {
  appStarted: false,
  processNotesVisibleDuringTurn: false,
  processNotesNonEmptyDuringTurn: false,
  headerAvatarWorkingDuringTurn: false,
  processNotesReadableAfterCompletion: false,
  emptyCompletionKeptStreamedText: false,
  finalAnswerVisible: false,
};

const report: Report = { acceptance, screenshot: null, passed: false };
const root = await mkdtemp(join(tmpdir(), "openbot-response-process-renderer-"));
const home = join(root, "home");
const fakeCodex = resolve(OUT, "fake-codex");
let benchApp: BenchApp | null = null;
let authApi: BenchAuthApi | null = null;
let devInstance: DevInstanceRecord | null = null;
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
let page: PlaywrightPage | null = null;

async function waitFor<T>(
  label: string,
  read: () => Promise<T | null | undefined | false>,
  timeoutMs = WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

const MOCK_SESSION_TOKEN = "e2e-session-token".padEnd(48, "x");
const MOCK_USER = {
  id: "00000000-0000-4000-8000-000000000001",
  email: BENCH_ACCOUNT_EMAIL,
  name: null,
  avatarUrl: null,
};

async function ensureMockAuthApi(
  logDirectory: string,
  logger: ReturnType<typeof createOpenBotLogger>,
): Promise<BenchAuthApi> {
  await mkdir(logDirectory, { recursive: true });
  let challengeCounter = 0;
  let server: Server | null = null;
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const answer = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/health/live") {
      answer(200, { status: "ok" });
      return;
    }
    if (url.pathname === "/v1/auth/email/start" && request.method === "POST") {
      challengeCounter += 1;
      answer(200, {
        challengeId: `challenge-${challengeCounter}`,
        expiresAt: Date.now() + 3_600_000,
        developmentCode: "123456",
      });
      return;
    }
    if (url.pathname === "/v1/auth/email/verify" && request.method === "POST") {
      answer(200, { sessionToken: MOCK_SESSION_TOKEN, user: MOCK_USER });
      return;
    }
    if (request.headers.authorization !== `Bearer ${MOCK_SESSION_TOKEN}`) {
      answer(401, { code: "unauthorized", message: "Sign in is required." });
      return;
    }
    if (url.pathname === "/v1/me") {
      answer(200, MOCK_USER);
      return;
    }
    if (url.pathname === "/v2/hosting/servers/") {
      answer(200, { available: false, lifecycleAvailable: false, servers: [], maxServers: 0 });
      return;
    }
    if (url.pathname === "/v2/hosting/plans") {
      answer(200, { plans: [] });
      return;
    }
    if (url.pathname === "/v2/remote/hosts/") {
      answer(200, { hosts: [] });
      return;
    }
    answer(404, { error: "not_found" });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server?.once("error", rejectListen);
    server?.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The mock Auth API did not bind a port.");
  const port = address.port;
  logger.info(`mock Auth API on :${port}`);
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise((resolveStop) => {
        server?.close(() => resolveStop());
      }),
  };
}

function seedProfileIfMissing(environment: NodeJS.ProcessEnv): void {
  const profile = resolve(
    resolveDevelopmentAppDataRoot(process.platform, environment, home),
    developmentUserDataName("app", INSTANCE_ID),
  );
  if (existsSync(profile)) return;
  execFileSync(process.execPath, ["run", "dev:seed", "--if-missing"], {
    cwd: ROOT,
    stdio: "inherit",
    env: withoutElectronRuntimeFlags(environment),
  });
}

async function launchDevApp(): Promise<void> {
  if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
    throw new Error("No built app in out/. Run `bun run build` before this check.");
  }
  const baseEnv = withoutElectronRuntimeFlags({
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    OPENBOT_CODEX_PATH: fakeCodex,
    OPENBOT_DEV_INSTANCE_ID: INSTANCE_ID,
    OPENBOT_DEV_REMOTE_ROLE: "none",
  });
  const benchEnvironment = Object.fromEntries(
    Object.entries(baseEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  seedProfileIfMissing(baseEnv);
  const logger = createOpenBotLogger("response-process-renderer-e2e");
  authApi = await ensureMockAuthApi(join(OUT, "logs"), logger);
  benchApp = await launchBenchApp({
    projectRoot: ROOT,
    instanceId: INSTANCE_ID,
    logger,
    environment: {
      ...benchEnvironment,
      OPENBOT_AUTH_API_URL: authApi.url,
      OPENBOT_CODEX_PATH: fakeCodex,
      CODEX_HOME: join(home, ".codex"),
    },
    logPath: join(OUT, "electron.log"),
  });
  devInstance = {
    service: "app",
    instanceId: INSTANCE_ID,
    profile: developmentUserDataName("app", INSTANCE_ID),
    projectRoot: ROOT,
    rendererPort: 0,
    remoteDebuggingPort: benchApp.remoteDebuggingPort,
    pid: benchApp.pid,
    startedAt: Date.now(),
  };
  writeDevInstanceRecord(devInstance);
}

function isAppWindowUrl(url: string): boolean {
  return url.startsWith("openbot-app://app/index.html") && !url.includes("surface=");
}

async function readCdpPageTargets(port: number): Promise<Array<{ type: string; url: string }>> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
  if (!response.ok) throw new Error(`CDP target list failed with ${response.status}.`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

async function attachAppBrowser(): Promise<PlaywrightPage | null> {
  assert.ok(benchApp);
  if (browser) await browser.close().catch(() => {});
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${benchApp.remoteDebuggingPort}`);
  if (!(await verifyBrowserOwnership(browser, benchApp.pid))) {
    await browser.close();
    browser = null;
    throw new Error(`The browser on :${benchApp.remoteDebuggingPort} is not this check's app.`);
  }
  for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
    if (!isAppWindowUrl(candidate.url())) continue;
    if ((await candidate.evaluate("typeof window.openbot").catch(() => "")) === "object") return candidate;
  }
  return null;
}

async function connectApp(logger: ReturnType<typeof createOpenBotLogger>): Promise<PlaywrightPage> {
  assert.ok(benchApp);
  const remoteDebuggingPort = benchApp.remoteDebuggingPort;
  await waitFor(
    `CDP on :${remoteDebuggingPort}`,
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/version`, {
          signal: AbortSignal.timeout(1_000),
        });
        return response.ok ? true : null;
      } catch {
        return null;
      }
    },
    APP_START_MS,
  );
  await waitFor(
    `the app renderer target on :${remoteDebuggingPort}`,
    async () => {
      try {
        const targets = await readCdpPageTargets(remoteDebuggingPort);
        return targets.some((target) => target.type === "page" && isAppWindowUrl(String(target.url ?? "")))
          ? true
          : null;
      } catch {
        return null;
      }
    },
    APP_START_MS,
  );
  const connected = await waitFor("the app window", attachAppBrowser, APP_START_MS);
  const agentCount = await waitFor(
    "the agent list",
    () => connected.evaluate<number>("window.openbot.agent.listAgents().then((agents) => agents.length)"),
    APP_START_MS,
  );
  await signInBenchAccount(connected, logger);
  if (agentCount > 0) {
    await connected.locator("[data-chat-id]").first().waitFor({ state: "attached", timeout: APP_START_MS });
  }
  await waitFor(
    "the fake Codex model",
    async () => {
      const models = await connected.evaluate(() => window.openbot.agent.listModels());
      return models.some((model) => model.provider === "codex" && model.id === "gpt-5.5") ? true : null;
    },
    APP_START_MS,
  );
  return connected;
}

async function openAgentConversation(page: PlaywrightPage, agentId: string): Promise<void> {
  await page.locator(`[data-chat-id="${agentId}"]`).click();
  await page.getByRole("heading", { name: AGENT_NAME, level: 1 }).waitFor();
}

async function stopDevApp(): Promise<void> {
  if (browser) await browser.close().catch(() => {});
  browser = null;
  page = null;
  if (devInstance) removeDevInstanceRecord(devInstance);
  devInstance = null;
  if (benchApp) await benchApp.stop().catch(() => {});
  benchApp = null;
  if (authApi) await authApi.stop().catch(() => {});
  authApi = null;
}

function readConversation(page: Page, agentId: string): Promise<ConversationPage> {
  return page.evaluate((id) => window.openbot.agent.readConversationPage({ agentId: id, limit: 100 }), agentId);
}

async function headerAvatarMood(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const avatar = document.querySelector(".conversation-header [data-mood]");
    return avatar?.getAttribute("data-mood") ?? null;
  });
}

function processNoteText(messages: ConversationPage["messages"], turnId?: string | null): string {
  return messages
    .filter((message) => turnId === undefined || turnId === null || message.turnId === turnId)
    .map((message) => message.text)
    .join("\n");
}

async function expandProcessDisclosure(page: Page, label: string): Promise<void> {
  const toggle = page.getByRole("button", { name: label, exact: true }).last();
  await toggle.waitFor({ state: "visible" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

async function processNotesText(page: Page, label: string): Promise<string> {
  return page.getByRole("region", { name: label, exact: true }).last().innerText();
}

async function captureDuringTurn(page: Page, agentId: string): Promise<void> {
  await waitFor("the running turn", async () => {
    const conversation = await readConversation(page, agentId);
    return conversation.activeTurnId ? conversation.activeTurnId : null;
  });
  await waitFor("the working header avatar", async () => {
    const conversation = await readConversation(page, agentId);
    if (!conversation.activeTurnId) return null;
    return (await headerAvatarMood(page)) === "working" ? true : null;
  });
  acceptance.headerAvatarWorkingDuringTurn = true;
  const noteText = await waitFor("streaming process notes", async () => {
    const conversation = await readConversation(page, agentId);
    const turnText = processNoteText(conversation.messages, conversation.activeTurnId);
    if (turnText.includes(STREAMED_NOTE_TEXT) && turnText.includes(BLOCK_SUMMARY_TEXT)) {
      return turnText;
    }
    return null;
  });
  acceptance.processNotesVisibleDuringTurn = true;
  const runningToggle = page.getByRole("button", { name: PROCESS_RUNNING, exact: true }).last();
  const duringText = (await runningToggle.isVisible().catch(() => false))
    ? await (async () => {
        await expandProcessDisclosure(page, PROCESS_RUNNING);
        return processNotesText(page, PROCESS_RUNNING);
      })()
    : noteText;
  acceptance.processNotesNonEmptyDuringTurn =
    duringText.includes(STREAMED_NOTE_TEXT) && duringText.includes(BLOCK_SUMMARY_TEXT);
}

async function captureAfterCompletion(page: Page, agentId: string): Promise<void> {
  await waitFor("the turn to finish", async () => {
    const conversation = await readConversation(page, agentId);
    const note = conversation.messages.find((message) => message.text === STREAMED_NOTE_TEXT);
    const answer = conversation.messages.find((message) => message.text === FINAL_ANSWER_TEXT);
    const pending = conversation.messages.some((message) => message.status === "streaming");
    return note?.status === "completed" && answer?.status === "completed" && !conversation.activeTurnId && !pending
      ? conversation
      : null;
  });
  await page.waitForFunction((completedLabel) => {
    const buttons = [...document.querySelectorAll("button")];
    return buttons.some((button) => button.textContent?.trim() === completedLabel);
  }, PROCESS_COMPLETED);
  await expandProcessDisclosure(page, PROCESS_COMPLETED);
  const afterText = await processNotesText(page, PROCESS_COMPLETED);
  acceptance.processNotesReadableAfterCompletion =
    afterText.includes(STREAMED_NOTE_TEXT) && afterText.includes(BLOCK_SUMMARY_TEXT);
  acceptance.emptyCompletionKeptStreamedText = acceptance.processNotesReadableAfterCompletion;
  acceptance.finalAnswerVisible = await page
    .locator(".conversation-scroll")
    .getByText(FINAL_ANSWER_TEXT, { exact: true })
    .last()
    .isVisible();
}

try {
  await mkdir(OUT, { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(fakeCodex, FAKE_CODEX_RESPONSE_PROCESS, { mode: 0o755 });
  assert.ok(existsSync(fakeCodex), `The fake Codex CLI is missing at ${fakeCodex}.`);
  process.env.OPENBOT_CODEX_PATH = fakeCodex;
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.HOME = home;

  await launchDevApp();
  acceptance.appStarted = true;
  const logger = createOpenBotLogger("response-process-renderer-e2e");
  page = await connectApp(logger);
  page.setDefaultTimeout(WAIT_MS);

  const agent = await page.evaluate(async (name) => {
    return window.openbot.agent.createAgent({
      name,
      description: "Checks response process notes in the renderer.",
      avatarSeed: "process-renderer-e2e",
      avatarHue: null,
      initialMessage: "Ready for the response process check.",
      provider: "codex",
      model: "gpt-5.5",
    });
  }, AGENT_NAME);
  await openAgentConversation(page, agent.id);
  await Promise.all([
    captureDuringTurn(page, agent.id),
    page.evaluate(
      ({ id, text }) => window.openbot.agent.sendMessage({ agentId: id, text, clientMessageId: crypto.randomUUID() }),
      { id: agent.id, text: PROMPT },
    ),
  ]);
  await captureAfterCompletion(page, agent.id);

  const screenshotPath = join(OUT, "conversation.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  report.screenshot = screenshotPath;

  report.passed = Object.values(acceptance).every(Boolean);
  assert.ok(report.passed, `Acceptance failed: ${JSON.stringify(acceptance)}`);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  if (page) {
    try {
      const agentId = await page.evaluate(async () => {
        const agents = await window.openbot.agent.listAgents();
        return agents.find((agent) => agent.name === "Process renderer E2E")?.id ?? null;
      });
      if (agentId) {
        const conversation = await readConversation(page, agentId);
        report.error = `${report.error}\nLast messages: ${JSON.stringify(conversation.messages.map((message) => ({ text: message.text, itemType: message.itemType, status: message.status, turnId: message.turnId })))}`;
      }
    } catch {
      // The window may already be gone.
    }
  }
  if (page && !report.screenshot) {
    try {
      const screenshotPath = join(OUT, "failure.png");
      await page.screenshot({ path: screenshotPath, fullPage: true });
      report.screenshot = screenshotPath;
    } catch {
      // The window may already be gone.
    }
  }
} finally {
  await stopDevApp();
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ passed: report.passed, acceptance, screenshot: report.screenshot })}\n`);
process.exit(report.passed ? 0 : 1);
