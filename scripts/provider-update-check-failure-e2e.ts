// Starts ProviderRuntimeManager with no network, runs the hourly update check, and checks that the
// failure is logged and kept on the snapshot for provider rows.
// `bun scripts/provider-update-check-failure-e2e.ts`.
// Writes .openbot-build/provider-update-check-failure-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { teeLogLines } from "@openbot/logging";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { ProviderRuntimeManager } from "../src/main/provider-runtime-manager";

const OUT = resolve(import.meta.dirname, "../.openbot-build/provider-update-check-failure-e2e");
const WAIT_MS = 15_000;

interface Report {
  passed: boolean;
  updateCheckError?: string | null;
  logLine?: string;
}

const root = await mkdtemp(join(tmpdir(), "openbot-provider-update-check-failure-e2e-"));
const report: Report = { passed: false };
const lines: string[] = [];
const stopLog = teeLogLines(["provider-runtimes"], (line) => lines.push(line));

try {
  const manager = new ProviderRuntimeManager({
    root,
    availableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await runCauseEffect(manager.initialize());
  const failed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for update check failure.")), WAIT_MS);
    manager.on("status", (snapshot) => {
      if (snapshot.updateCheckError === null || snapshot.updateCheckError === undefined) return;
      clearTimeout(timer);
      resolve();
    });
  });
  manager.startUpdateChecks({ intervalMs: 60_000 });
  await failed;
  report.updateCheckError = manager.getStatus().updateCheckError ?? null;
  report.logLine = lines.find((line) => line.includes("Provider runtime update check failed."));
  assert.equal(
    report.updateCheckError,
    sourceText("error.provider.releaseSourcesUnreachable"),
    "the snapshot keeps the catalog reason",
  );
  assert.ok(report.logLine, "the failure is logged");
  assert.match(report.logLine ?? "", /release_sources_unreachable/u);
  await runCauseEffect(manager.stop());
  report.passed = true;
} finally {
  stopLog();
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
