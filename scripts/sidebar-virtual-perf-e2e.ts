// Measures how many sidebar chat rows and avatar engines mount with five hundred agents.
// Run: `bun scripts/sidebar-virtual-perf-e2e.ts --storybook=http://127.0.0.1:6006 [--runs=5]`
// Writes `.openbot-build/sidebar-virtual-perf-e2e/report.json`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { chromium, type Page } from "playwright-core";
import { type Spread, spread } from "./dev-automation/bench-stats";
import { startRenderRecording } from "./dev-automation/render-metrics";

const logger = createOpenBotLogger("sidebar-virtual-perf-e2e");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/sidebar-virtual-perf-e2e");
const STORY = "navigation-sidebar--perf-500-agents";
const CHAT_COUNT = 500;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const runs = Number(option("runs") ?? "5");
assert.ok(Number.isInteger(runs) && runs >= 1, "--runs takes a whole number, 1 or more.");
const storybook = option("storybook")?.replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> from a running Storybook (`bun run storybook`).");
const browserExecutable = option("browser-executable") ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

interface SidebarCounts {
  chatRows: number;
  avatarHosts: number;
}

interface RunSample {
  atTop: SidebarCounts;
  afterScroll: SidebarCounts;
  styleRecalcs: number;
  layouts: number;
}

interface Report {
  label: string;
  createdAt: string;
  commit: string;
  runs: number;
  chatCount: number;
  metrics: Record<string, Spread | null>;
  samples: RunSample[];
}

async function readSidebarCounts(page: Page): Promise<SidebarCounts> {
  return page.evaluate(() => {
    const nav = document.querySelector("nav.agent-list");
    const scope = nav ?? document;
    return {
      chatRows: scope.querySelectorAll("[data-chat-id]").length,
      avatarHosts: scope.querySelectorAll(".agent-avatar").length,
    };
  });
}

async function scrollSidebarToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const list = document.querySelector("nav.agent-list");
    if (!list) throw new Error("Sidebar nav.agent-list is missing.");
    list.scrollTop = list.scrollHeight;
  });
}

async function measureRun(page: Page): Promise<RunSample> {
  await page.goto(`${storybook}/iframe.html?id=${STORY}&viewMode=story`);
  await page.locator("nav.agent-list").waitFor({ timeout: 120_000 });
  await page.getByRole("button", { name: /^Agent 1\./ }).waitFor({ timeout: 60_000 });
  const atTop = await readSidebarCounts(page);
  const stop = await startRenderRecording(page, { frames: false, callCounts: false });
  await scrollSidebarToBottom(page);
  await page.getByRole("button", { name: /^Agent 500\./ }).waitFor({ timeout: 60_000 });
  const afterScroll = await readSidebarCounts(page);
  const { values } = await stop();
  return {
    atTop,
    afterScroll,
    styleRecalcs: values["render.styleRecalcs"] ?? 0,
    layouts: values["render.layouts"] ?? 0,
  };
}

const samples: RunSample[] = [];
for (let run = 0; run < runs; run++) {
  const browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    const sample = await measureRun(page);
    samples.push(sample);
    logger.info(
      `run ${run + 1}/${runs}: top rows=${sample.atTop.chatRows} avatars=${sample.atTop.avatarHosts}; ` +
        `scroll rows=${sample.afterScroll.chatRows} avatars=${sample.afterScroll.avatarHosts}`,
    );
  } finally {
    await page.close();
    await browser.close();
  }
}

const metricValues: Record<string, number[]> = {};
for (const sample of samples) {
  for (const [key, value] of Object.entries({
    "sidebar.chatRows.atTop": sample.atTop.chatRows,
    "sidebar.chatRows.afterScroll": sample.afterScroll.chatRows,
    "sidebar.avatars.atTop": sample.atTop.avatarHosts,
    "sidebar.avatars.afterScroll": sample.afterScroll.avatarHosts,
    "sidebar.scroll.styleRecalcs": sample.styleRecalcs,
    "sidebar.scroll.layouts": sample.layouts,
  })) {
    const bucket = metricValues[key] ?? [];
    bucket.push(value);
    metricValues[key] = bucket;
  }
}

const metrics = Object.fromEntries(Object.entries(metricValues).map(([key, values]) => [key, spread(values)]));
const report: Report = {
  label: "sidebar-virtual-perf-e2e",
  createdAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  runs,
  chatCount: CHAT_COUNT,
  metrics,
  samples,
};

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

const rowMedian = metrics["sidebar.chatRows.atTop"]?.median ?? Number.NaN;
const avatarMedian = metrics["sidebar.avatars.atTop"]?.median ?? Number.NaN;
assert.ok(
  rowMedian < CHAT_COUNT / 2,
  `Expected fewer than ${CHAT_COUNT / 2} mounted chat rows at top; median was ${rowMedian}.`,
);
assert.ok(
  avatarMedian < CHAT_COUNT / 2,
  `Expected fewer than ${CHAT_COUNT / 2} mounted avatar hosts at top; median was ${avatarMedian}.`,
);

logger.info(
  `median mounted chat rows at top: ${rowMedian} (min ${metrics["sidebar.chatRows.atTop"]?.min}, max ${metrics["sidebar.chatRows.atTop"]?.max})`,
);
logger.info(`report: ${resolve(OUT, "report.json")}`);
