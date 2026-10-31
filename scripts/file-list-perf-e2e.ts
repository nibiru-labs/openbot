// Measures how many file rows the list draws for 5,000 files and how long the first paint takes.
// Pass the URL that `bun run storybook` reports:
// `bun scripts/file-list-perf-e2e.ts --storybook=http://localhost:6006 [--runs=5] [--compare=report.json]`.
// Writes `.openbot-build/file-list-perf-e2e/report.json`. With `--compare`, fails when the median
// rendered row count or mount time is not clearly lower than the baseline.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDynamicRecord, isNumber } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { chromium, type Page } from "playwright-core";
import { type Spread, spread } from "./dev-automation/bench-stats";

const logger = createOpenBotLogger("file-list-perf-e2e");
const OUT = resolve(import.meta.dirname, "../.openbot-build/file-list-perf-e2e");
const STORY = "files-storage--list-large";
const FILE_COUNT = 5000;
const SUMMARY = ".file-list-summary";
const ROW = ".file-row";
const VIRTUAL = ".file-list-rows[data-virtualized='true']";

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const storybook = option("storybook")?.replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");
const runs = Number(option("runs") ?? "5");
assert.ok(Number.isInteger(runs) && runs >= 5, "--runs takes a whole number, 5 or more.");
const comparePath = option("compare");
const browserExecutable =
  option("browser-executable") ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

interface Sample {
  mountMs: number;
  rowDomCount: number;
  virtualized: boolean;
}

interface Report {
  label: string;
  createdAt: string;
  story: string;
  fileCount: number;
  runs: number;
  metrics: {
    mountMs: Spread;
    rowDomCount: Spread;
  };
  samples: Sample[];
}

async function measure(page: Page): Promise<Sample> {
  const started = Date.now();
  await page.goto(`${storybook}/iframe.html?id=${STORY}&viewMode=story`, { waitUntil: "networkidle" });
  await page.locator(SUMMARY).waitFor({ state: "visible" });
  const mountMs = Date.now() - started;
  const rowDomCount = await page.locator(ROW).count();
  const virtualized = (await page.locator(VIRTUAL).count()) > 0;
  return { mountMs, rowDomCount, virtualized };
}

function parseReport(path: string): Report {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(isDynamicRecord(parsed) && isDynamicRecord(parsed.metrics), `${path} is not a file-list perf report.`);
  const metrics = parsed.metrics;
  const mount = metrics.mountMs;
  const rows = metrics.rowDomCount;
  assert.ok(isDynamicRecord(mount) && isNumber(mount.median), "The compare report has no mountMs median.");
  assert.ok(isDynamicRecord(rows) && isNumber(rows.median), "The compare report has no rowDomCount median.");
  return {
    label: String(parsed.label ?? path),
    createdAt: String(parsed.createdAt ?? ""),
    story: String(parsed.story ?? STORY),
    fileCount: isNumber(parsed.fileCount) ? parsed.fileCount : FILE_COUNT,
    runs: isNumber(parsed.runs) ? parsed.runs : 0,
    metrics: {
      mountMs: { median: mount.median, min: Number(mount.min), max: Number(mount.max) },
      rowDomCount: { median: rows.median, min: Number(rows.min), max: Number(rows.max) },
    },
    samples: [],
  };
}

const samples: Sample[] = [];
const browser = await chromium.launch(
  browserExecutable
    ? { executablePath: browserExecutable, headless: true, args: ["--no-sandbox"] }
    : { headless: true },
);
const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
page.setDefaultTimeout(120_000);
try {
  for (let index = 0; index < runs; index += 1) samples.push(await measure(page));
} finally {
  await browser.close();
}

assert.ok(
  samples.every((sample) => sample.virtualized),
  "The large story did not virtualize the file list.",
);
const mountSpread = spread(samples.map((sample) => sample.mountMs));
const rowSpread = spread(samples.map((sample) => sample.rowDomCount));
assert.ok(mountSpread && rowSpread, "The measurement produced no samples.");

const report: Report = {
  label: "file-list-perf-e2e",
  createdAt: new Date().toISOString(),
  story: STORY,
  fileCount: FILE_COUNT,
  runs,
  metrics: { mountMs: mountSpread, rowDomCount: rowSpread },
  samples,
};

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

const lines = [
  `mountMs: ${mountSpread.median} (${mountSpread.min}–${mountSpread.max})`,
  `rowDomCount: ${rowSpread.median} (${rowSpread.min}–${rowSpread.max}) of ${FILE_COUNT} files`,
  `virtualized: ${samples.every((sample) => sample.virtualized)}`,
];
logger.info(`${resolve(OUT, "report.json")}\n${lines.join("\n")}`);

if (comparePath) {
  assert.ok(statSync(comparePath).isFile(), `--compare: ${comparePath} is not a file.`);
  const baseline = parseReport(comparePath);
  const mountBefore = baseline.metrics.mountMs.median;
  const rowsBefore = baseline.metrics.rowDomCount.median;
  const mountAfter = mountSpread.median;
  const rowsAfter = rowSpread.median;
  assert.ok(
    rowsAfter < rowsBefore * 0.5,
    `Rendered row count did not drop enough: ${rowsAfter} vs baseline ${rowsBefore}.`,
  );
  assert.ok(
    mountAfter < mountBefore * 0.85,
    `Mount time did not improve enough: ${mountAfter} ms vs baseline ${mountBefore} ms.`,
  );
  logger.info(
    `compare: rowDomCount ${rowsBefore} -> ${rowsAfter}, mountMs ${mountBefore} -> ${mountAfter}, medians over ${runs} runs`,
  );
}
