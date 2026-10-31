// End-to-end check of the browser client sign-in, send, stop, and sign-out path (#66).
// Start this worktree's dev stack with `bun run dev` (never `--shared`), then run
// `bun scripts/web-client-flow-e2e.ts --allow-mutations [--api=<url>] [--agent=<agent id>]
//  [--email=openbot-dev-host@example.com] [--browser-executable=<path>]`.
// When no Auth API is running, the script starts one with development codes exposed
// (`AUTH_EXPOSE_DEVELOPMENT_CODE=true`). The web app at `/app` connects to the host over WebRTC.
// It signs in, sends a message, reads the reply, stops a long turn, and signs out.
// The script never writes a code or a cookie to the log or the report.
// Writes .openbot-build/web-client-flow-e2e/report.json and screenshots.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { isAgentProvider } from "@openbot/contracts/agent-providers";
import type { AgentTask, AgentTasksSnapshot } from "@openbot/contracts/ipc";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import { chromium, type Page } from "playwright-core";
import { argument, connectChannelE2e, LONG_PROMPT, SHORT_PROMPT, waitFor, writeReport } from "./channel-e2e-support";
import { ensureBenchAuthApi } from "./dev-automation/bench-auth";

const NAME = "web-client-flow-e2e";
const OUT = resolve(import.meta.dirname, "../.openbot-build/web-client-flow-e2e");
mkdirSync(OUT, { recursive: true });
const UI_WAIT_MS = 30_000;
const english = translateFor("en");
const logger = createOpenBotLogger(NAME);
const agentArgument = argument("agent");
const email = argument("email") ?? "openbot-dev-host@example.com";
const browserExecutable = argument("browser-executable");
const apiArgument = argument("api")?.replace(/\/$/, "");

interface Report {
  agentId?: string;
  authApiStarted?: boolean;
  signIn?: { workspace: boolean };
  send?: { messageOnHost: boolean; replyInWeb: boolean };
  stop?: { buttonShown: boolean; taskIdle: boolean };
  signOut?: { loginForm: boolean };
  pageErrors: string[];
  screenshots: string[];
  passed: boolean;
}

const report: Report = { pageErrors: [], screenshots: [], passed: false };
let stopAuthApi: (() => Promise<void>) | undefined;

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Resolves the Auth API URL, starting a local worker when none is running. */
async function resolveAuthApi(): Promise<string> {
  if (apiArgument) return apiArgument;
  const auth = await ensureBenchAuthApi(resolve(process.cwd()), OUT, logger);
  stopAuthApi = auth.stop;
  report.authApiStarted = true;
  return auth.url;
}

/** Reads the development code from the sign-in page without logging it. */
async function readDevelopmentCode(page: Page): Promise<string> {
  const prefix = english("account.login.developmentCode", { code: "" });
  const notice = page.getByText(new RegExp(`^${literal(prefix)}`));
  await notice.waitFor({ timeout: UI_WAIT_MS });
  const code = (await notice.innerText()).slice(prefix.length).replaceAll("-", "").trim();
  assert.ok(code.length > 0, "The account service showed no development code.");
  return code;
}

/** Signs in to the web client with the development code shown on the page. */
async function signIn(page: Page, authApi: string): Promise<void> {
  await page.goto(`${authApi}/app`);
  await page.getByRole("textbox", { name: english("account.login.email"), exact: true }).fill(email);
  await page.getByRole("button", { name: english("account.login.sendCode"), exact: true }).click();
  const code = await readDevelopmentCode(page);
  await page.keyboard.type(code);
}

async function shot(page: Page, label: string): Promise<void> {
  const path = resolve(OUT, `${label}.png`);
  await page.screenshot({ path });
  report.screenshots.push(path);
}

const authApi = await resolveAuthApi();
const host = await connectChannelE2e(NAME);
const browser = await chromium.launch(
  browserExecutable ? { executablePath: browserExecutable } : { channel: "chrome" },
);
const web = await browser.newPage({ viewport: { width: 1280, height: 900 } });
for (const page of [host.page, web])
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));

let agentId = agentArgument ?? "";
let taskId: string | null = null;

function hostTasks(): Promise<AgentTasksSnapshot> {
  return host.page.evaluate((id) => window.openbot.agent.listTasks(id), agentId);
}

async function hostTask(): Promise<AgentTask | undefined> {
  return (await hostTasks()).tasks.find((task) => task.id === taskId);
}

try {
  if (!agentId) {
    const agents = await host.page.evaluate(() => window.openbot.agent.listAgents());
    const candidate = agents.find((agent) => isAgentProvider(agent.provider));
    assert.ok(candidate, "This check needs one agent whose provider is signed in.");
    agentId = candidate.id;
  }
  report.agentId = agentId;

  const agentName = await host.page.evaluate(async (id) => {
    const found = (await window.openbot.agent.listAgents()).find((candidate) => candidate.id === id);
    if (!found) throw new Error(`Unknown agent: ${id}`);
    return found.name;
  }, agentId);

  // 1. Sign in and reach the workspace.
  await signIn(web, authApi);
  const agentButton = web
    .getByRole("navigation", { name: english("sidebar.nav.label") })
    .getByRole("button", { name: new RegExp(`^${literal(agentName)}[,.]`) })
    .first();
  await agentButton.waitFor({ timeout: UI_WAIT_MS * 4 });
  report.signIn = { workspace: true };
  await shot(web, "1-signed-in");

  // 2. Start a thread and send a short message; the host and the web client show the reply.
  await agentButton.click();
  await web
    .getByRole("button", { name: english("conversation.threads.new"), exact: true })
    .first()
    .click();
  const composer = web.getByRole("textbox", {
    name: english("conversation.threads.view.newPlaceholder", { name: agentName }),
  });
  await composer.waitFor({ timeout: UI_WAIT_MS });
  await composer.fill(SHORT_PROMPT);
  await composer.press("Enter");
  const started = await waitFor(host.page, "the host starts the thread", hostTasks, (snapshot) =>
    snapshot.tasks.some((task) => task.state === "running" || task.state === "idle"),
  );
  const task = started.tasks.at(-1);
  assert.ok(task);
  taskId = task.id;
  await waitFor(
    host.page,
    "the host has the web message",
    (): Promise<{ messages: { text: string }[] }> =>
      host.page.evaluate((value) => window.openbot.agent.readTask(value), { agentId, taskId: task.id }),
    (snapshot) => snapshot.messages.some((message) => message.text.includes(SHORT_PROMPT)),
  );
  const idleTask = await waitFor(host.page, "the short turn ends", hostTask, (current) => current?.state === "idle");
  assert.ok(idleTask);
  const replyRow = web
    .getByRole("main", { name: english("conversation.view.label") })
    .getByRole("article")
    .filter({ hasText: /\bready\b/i })
    .first();
  await replyRow.waitFor({ timeout: UI_WAIT_MS * 4 });
  report.send = { messageOnHost: true, replyInWeb: true };
  await shot(web, "2-reply");

  // 3. A long turn shows Stop, and Stop ends it on the host.
  const threadComposer = web.getByRole("textbox", {
    name: english("conversation.threads.view.placeholder", { name: agentName, title: idleTask.title }),
  });
  await threadComposer.fill(LONG_PROMPT);
  await threadComposer.press("Enter");
  const stopButton = web.getByRole("button", { name: english("composer.send.stop"), exact: true });
  await stopButton.waitFor({ timeout: UI_WAIT_MS * 2 });
  report.stop = { buttonShown: true, taskIdle: false };
  await stopButton.click();
  await waitFor(host.page, "Stop ends the turn", hostTask, (current) => current?.state === "idle");
  await stopButton.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  report.stop.taskIdle = true;
  await shot(web, "3-stopped");

  // 4. Sign out returns to the sign-in form.
  await web
    .getByRole("navigation", { name: english("app.rail.label") })
    .getByRole("button", { name: english("app.rail.settings"), exact: true })
    .click();
  await web.getByRole("button", { name: english("account.menu.signOut"), exact: true }).click();
  await web
    .getByRole("heading", { name: english("account.login.signInTitle"), exact: true })
    .waitFor({ timeout: UI_WAIT_MS });
  report.signOut = { loginForm: true };
  await shot(web, "4-signed-out");

  report.passed = true;
} catch (error) {
  await shot(web, "failure").catch(() => undefined);
  throw error;
} finally {
  if (taskId) {
    const id = taskId;
    await host.page
      .evaluate((value) => window.openbot.agent.stopTask(value), { agentId, taskId: id })
      .catch(() => undefined);
    await waitFor(host.page, "cleanup stop", hostTask, (current) => current?.state !== "running").catch(
      () => undefined,
    );
    await host.page
      .evaluate((value) => window.openbot.agent.deleteTask(value), { agentId, taskId: id })
      .catch(() => undefined);
  }
  writeReport(NAME, report);
  await browser.close();
  await host.close();
  await stopAuthApi?.();
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
