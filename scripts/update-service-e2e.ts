// Runs the real `UpdateService` with a fake updater that reads a local update feed served in this
// script. No external network. Checks: a check with no update, a check with an update, a download
// that fails, a download that succeeds, a relaunch that waits for an idle agent, and a cancel of a
// running download. The relaunch path asserts `quitAndInstall`; it does not restart this process.
// `bun scripts/update-service-e2e.ts`.
// Writes `.openbot-build/update-service-e2e/report.json`.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { IdleRestart } from "../src/main/idle-restart";
import type { RestartReadiness } from "../src/main/update-readiness";
import {
  type UpdateAdapter,
  type UpdateCancellationToken,
  type UpdateCheckOutcome,
  UpdateService,
} from "../src/main/update-service";

const OUT = resolve(import.meta.dirname, "../.openbot-build/update-service-e2e");
const CURRENT = "1.0.0";
const NEWER = "1.1.0";
const WAIT_MS = 15_000;

interface Report {
  passed: boolean;
  checkNoUpdate?: { phase: string; availableVersion: string | null };
  checkWithUpdate?: { phase: string; availableVersion: string | null };
  downloadFailed?: { phase: string; errorCode: string | null };
  downloadSucceeded?: { phase: string; progress: number | null };
  idleRestart?: {
    waitedFor: string[];
    installRequested: boolean;
    quitAndInstallCalls: number;
  };
  cancelDownload?: { phase: string; errorCode: string | null; tokenCancelled: boolean };
  error?: string;
}

const report: Report = { passed: false };

class FeedCancellation implements UpdateCancellationToken {
  cancelled = false;
  cancel(): void {
    this.cancelled = true;
  }
}

/** The release the local feed serves. The fake updater reads it over loopback. */
interface LocalUpdateFeed {
  version: string | null;
  downloadBehavior: "success" | "fail" | "slow";
}

/** A listener of any updater event. Each event passes at most one of these values, or none. */
type UpdateListener = (value: ProgressInfo & UpdateInfo & Error) => void;

function readFeedBody(value: unknown): { version: string | null } {
  assert.ok(isDynamicRecord(value), "the feed body is not an object.");
  const version = value.version;
  if (version === null) return { version: null };
  assert.ok(isString(version), "the feed version is not a string.");
  return { version };
}

class FakeUpdateAdapter implements UpdateAdapter {
  allowPrerelease = false;
  autoDownload = false;
  autoInstallOnAppQuit = false;
  readonly #events = new EventEmitter();
  readonly #feedUrl: string;
  readonly #currentVersion: string;
  #feed: LocalUpdateFeed;
  quitAndInstallCalls = 0;
  lastQuitAndInstall: { isSilent?: boolean; isForceRunAfter?: boolean } | null = null;

  constructor(feedUrl: string, currentVersion: string, feed: LocalUpdateFeed) {
    this.#feedUrl = feedUrl;
    this.#currentVersion = currentVersion;
    this.#feed = feed;
  }

  setFeed(feed: LocalUpdateFeed): void {
    this.#feed = feed;
  }

  on(event: string, listener: UpdateListener): this {
    this.#events.on(event, listener);
    return this;
  }

  async checkForUpdates(): Promise<UpdateCheckOutcome | null> {
    const response = await fetch(`${this.#feedUrl}/feed`);
    assert.equal(response.status, 200, "the local feed did not answer.");
    const body = readFeedBody(await response.json());
    const version = body.version ?? this.#currentVersion;
    if (!body.version || !isNewer(body.version, this.#currentVersion)) {
      return { isUpdateAvailable: false, updateInfo: { version } };
    }
    return {
      isUpdateAvailable: true,
      updateInfo: { version: body.version },
      cancellationToken: new FeedCancellation(),
    };
  }

  async downloadUpdate(cancellationToken?: UpdateCancellationToken): Promise<unknown> {
    const response = await fetch(`${this.#feedUrl}/feed`);
    const body = readFeedBody(await response.json());
    const version = body.version;
    assert.ok(version, "the feed has no version to download.");
    if (this.#feed.downloadBehavior === "fail") {
      throw new Error("download failed");
    }
    const steps = this.#feed.downloadBehavior === "slow" ? 4 : 2;
    for (let step = 1; step <= steps; step += 1) {
      await delay(25);
      if (cancellationToken?.cancelled) throw new Error("download cancelled");
      this.#events.emit("download-progress", {
        percent: Math.round((step / steps) * 100),
        total: 100,
        transferred: step,
        delta: 1,
        bytesPerSecond: 10,
      } satisfies ProgressInfo);
    }
    if (cancellationToken?.cancelled) throw new Error("download cancelled");
    this.#events.emit("update-downloaded", { version });
    return [];
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.quitAndInstallCalls += 1;
    this.lastQuitAndInstall = {
      ...(isSilent === undefined ? {} : { isSilent }),
      ...(isForceRunAfter === undefined ? {} : { isForceRunAfter }),
    };
  }
}

function isNewer(candidate: string, current: string): boolean {
  const parse = (version: string) => version.split(/[-+]/u, 1)[0]?.split(".").map(Number) ?? [];
  const [left, right] = [parse(candidate), parse(current)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function createService(adapter: FakeUpdateAdapter, autoDownload = false): UpdateService {
  const service = new UpdateService(adapter, {
    currentVersion: CURRENT,
    enabled: true,
    autoDownload,
    beforeInstall: async () => undefined,
    initialCheckDelayMs: 60_000,
    checkIntervalMs: 60_000,
    checkTimeoutMs: 5_000,
    downloadStallTimeoutMs: 5_000,
    installTimeoutMs: 5_000,
  });
  service.start(false);
  return service;
}

async function waitFor(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await delay(20);
  }
}

async function waitForPhase(service: UpdateService, phase: string): Promise<void> {
  await waitFor(`phase ${phase}`, () => service.getStatus().phase === phase);
}

let feed: LocalUpdateFeed = { version: null, downloadBehavior: "success" };
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    return Response.json({ version: feed.version });
  },
});
const feedUrl = `http://${server.hostname}:${server.port}`;

try {
  // 1. Check with no update.
  feed = { version: CURRENT, downloadBehavior: "success" };
  const noUpdateAdapter = new FakeUpdateAdapter(feedUrl, CURRENT, feed);
  const noUpdateService = createService(noUpdateAdapter);
  const noUpdateStatus = await runCauseEffect(noUpdateService.checkForUpdates());
  report.checkNoUpdate = {
    phase: noUpdateStatus.phase,
    availableVersion: noUpdateStatus.availableVersion,
  };
  assert.equal(noUpdateStatus.phase, "up-to-date", "no update leaves the app up to date.");
  assert.equal(noUpdateStatus.availableVersion, null, "no update clears the available version.");

  // 2. Check with an update.
  feed = { version: NEWER, downloadBehavior: "success" };
  const withUpdateAdapter = new FakeUpdateAdapter(feedUrl, CURRENT, feed);
  const withUpdateService = createService(withUpdateAdapter);
  const availableStatus = await runCauseEffect(withUpdateService.checkForUpdates());
  report.checkWithUpdate = {
    phase: availableStatus.phase,
    availableVersion: availableStatus.availableVersion,
  };
  assert.equal(availableStatus.phase, "available", "a newer release is offered.");
  assert.equal(availableStatus.availableVersion, NEWER, "the offered version matches the feed.");

  // 3. Download that fails.
  feed = { version: NEWER, downloadBehavior: "fail" };
  const failAdapter = new FakeUpdateAdapter(feedUrl, CURRENT, feed);
  const failService = createService(failAdapter);
  await runCauseEffect(failService.checkForUpdates());
  await runCauseEffect(failService.downloadUpdate());
  await waitForPhase(failService, "error");
  const failedStatus = failService.getStatus();
  report.downloadFailed = { phase: failedStatus.phase, errorCode: failedStatus.errorCode };
  assert.equal(failedStatus.phase, "error", "a failed download ends in error.");
  assert.equal(failedStatus.errorCode, "download_failed", "a failed download sets download_failed.");

  // 4. Download that succeeds.
  feed = { version: NEWER, downloadBehavior: "success" };
  const successAdapter = new FakeUpdateAdapter(feedUrl, CURRENT, feed);
  const successService = createService(successAdapter);
  await runCauseEffect(successService.checkForUpdates());
  const downloadStarted = runCauseEffect(successService.downloadUpdate());
  await waitForPhase(successService, "ready");
  await downloadStarted;
  const readyStatus = successService.getStatus();
  report.downloadSucceeded = { phase: readyStatus.phase, progress: readyStatus.progress };
  assert.equal(readyStatus.phase, "ready", "a successful download is ready to restart.");
  assert.equal(readyStatus.progress, 100, "a successful download reports full progress.");

  // 5. Relaunch waits for an idle agent, then requests install without quitting this process.
  feed = { version: NEWER, downloadBehavior: "success" };
  const idleAdapter = new FakeUpdateAdapter(feedUrl, CURRENT, feed);
  let readiness: RestartReadiness = { safeToRestart: false, reasons: ["agent-turn"] };
  let beforeInstallCalls = 0;
  const installService = new UpdateService(idleAdapter, {
    currentVersion: CURRENT,
    enabled: true,
    autoDownload: false,
    beforeInstall: async () => {
      beforeInstallCalls += 1;
    },
    initialCheckDelayMs: 60_000,
    checkIntervalMs: 60_000,
    checkTimeoutMs: 5_000,
    downloadStallTimeoutMs: 5_000,
    installTimeoutMs: 5_000,
  });
  installService.start(false);
  await runCauseEffect(installService.checkForUpdates());
  await runCauseEffect(installService.downloadUpdate());
  await waitForPhase(installService, "ready");
  const idle = new IdleRestart({
    updater: installService,
    describeReadiness: () => readiness,
    holdRoutines: () => undefined,
    releaseRoutines: () => undefined,
    recordHold: () => undefined,
    relaunch: () => {
      throw new Error("relaunch must not run in this check.");
    },
    log: () => undefined,
    pollMs: 30,
  });
  idle.request("update");
  await waitFor("the idle restart to wait for the agent", () => {
    const status = installService.getStatus().idleRestart;
    return Boolean(status && status.waitingFor.length > 0);
  });
  const waitingFor = [...(installService.getStatus().idleRestart?.waitingFor ?? [])];
  readiness = { safeToRestart: true, reasons: [] };
  await waitFor("install to be requested", () => beforeInstallCalls > 0 && idleAdapter.quitAndInstallCalls > 0);
  report.idleRestart = {
    waitedFor: waitingFor,
    installRequested: beforeInstallCalls > 0,
    quitAndInstallCalls: idleAdapter.quitAndInstallCalls,
  };
  assert.deepEqual(waitingFor, ["agent-turn"], "the restart waits for the running agent.");
  assert.equal(beforeInstallCalls, 1, "shutdown preparation runs once.");
  assert.equal(idleAdapter.quitAndInstallCalls, 1, "quitAndInstall is requested instead of relaunching here.");
  assert.equal(idleAdapter.lastQuitAndInstall?.isSilent, true, "the install is silent.");
  assert.equal(idleAdapter.lastQuitAndInstall?.isForceRunAfter, true, "the install asks to run after.");
  idle.dispose();

  // 6. Cancel a running download.
  feed = { version: NEWER, downloadBehavior: "slow" };
  const cancelAdapter = new FakeUpdateAdapter(feedUrl, CURRENT, feed);
  const tokens: { active: UpdateCancellationToken | null } = { active: null };
  const originalCheck = cancelAdapter.checkForUpdates.bind(cancelAdapter);
  cancelAdapter.checkForUpdates = async () => {
    const result = await originalCheck();
    tokens.active = result?.cancellationToken ?? null;
    return result;
  };
  const cancelService = createService(cancelAdapter);
  await runCauseEffect(cancelService.checkForUpdates());
  const downloadPromise = runCauseEffect(cancelService.downloadUpdate());
  await waitFor("the download to start", () => cancelService.getStatus().phase === "downloading");
  const token = tokens.active;
  assert.ok(token, "the check mints a cancellation token.");
  token.cancel();
  await waitForPhase(cancelService, "error");
  await downloadPromise.catch(() => undefined);
  const cancelledStatus = cancelService.getStatus();
  report.cancelDownload = {
    phase: cancelledStatus.phase,
    errorCode: cancelledStatus.errorCode,
    tokenCancelled: token.cancelled,
  };
  assert.equal(cancelledStatus.phase, "error", "a cancelled download ends in error.");
  assert.equal(cancelledStatus.errorCode, "download_failed", "a cancelled download sets download_failed.");
  assert.equal(token.cancelled, true, "the cancellation token was spent.");

  report.passed = true;
} catch (cause) {
  report.error = cause instanceof Error ? cause.message : String(cause);
  process.exitCode = 1;
} finally {
  server.stop();
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
