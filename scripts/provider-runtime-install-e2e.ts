// Downloads a provider runtime end to end on the real `ProviderRuntimeManager`, with a local HTTP
// server as the source, so the script needs no internet. Checks that a download whose bytes do not
// match the hash the lock names is refused and leaves nothing behind, that a good archive is
// unpacked, checked and installed, that the new runtime is activated, that a CLI the user pointed
// OpenBot at is left alone, and that an update over an installed version installs the newer one.
// `bun scripts/provider-runtime-install-e2e.ts`.
// Writes .openbot-build/provider-runtime-install-e2e/report.json.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProviderRuntimeSnapshot } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import lockValue from "../native-runtime.lock.json";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { RuntimeTarget } from "../src/main/provider-runtime-descriptors";
import { ProviderRuntimeManager, runtimeTarget } from "../src/main/provider-runtime-manager";
import { type AgentRuntimeLock, parseAgentRuntimeLock } from "./agent-runtime-lock";

const execFileAsync = promisify(execFile);
const OUT = resolve(import.meta.dirname, "../.openbot-build/provider-runtime-install-e2e");
/** The provider CLI the fixture installs. Pi ships one archive per target, as the others do. */
const PROVIDER = "pi";
/** The version the lock pins, and the newer one the release check finds. */
const PINNED_VERSION = "1.0.0";
const NEWER_VERSION = "1.1.0";
/** Where the release check reads the newest version, and where the block list lives. */
const RELEASE_URL = "https://api.github.com/repos/earendil-works/pi/releases/latest";
const BLOCKLIST_URL = "https://raw.githubusercontent.com/nightly-labs/openbot/main/provider-runtime-blocklist.json";

interface Report {
  passed: boolean;
  wrongHash?: {
    phase: string;
    message: string | null;
    installed: boolean;
    partialLeft: boolean;
    requests: number;
  };
  install?: {
    phase: string;
    version: string | null;
    executable: string | null;
    activated: string | null;
    readyEvent: boolean;
    requests: number;
  };
  ownCli?: { message: string; requests: number; offer: string | null; version: string | null };
  update?: {
    offer: string | null;
    phase: string;
    version: string | null;
    activated: string | null;
    versions: string[];
    record: boolean;
  };
}

/** The first status that `check` accepts, or a failure after the wait. */
function nextStatus(
  manager: ProviderRuntimeManager,
  label: string,
  check: (snapshot: ProviderRuntimeSnapshot) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 30_000);
    const listener = (snapshot: ProviderRuntimeSnapshot) => {
      if (!check(snapshot)) return;
      clearTimeout(timer);
      manager.off("status", listener);
      resolve();
    };
    manager.on("status", listener);
  });
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The CLI the fixture installs: a program that reports the version it was built for. */
function fakeCli(version: string): Buffer {
  return Buffer.from(`#!/bin/sh\necho "pi ${version}"\n`, "utf8");
}

/** The archive the provider publishes: the CLI in the folder the install expects. */
async function buildArchive(version: string): Promise<{ bytes: Buffer; sha256: string; binarySha256: string }> {
  const folder = join(fixture, `pi-${version}`);
  await mkdir(join(folder, "pi"), { recursive: true });
  const binary = fakeCli(version);
  await writeFile(join(folder, "pi", "pi"), binary, { mode: 0o755 });
  const archive = join(fixture, `pi-${version}.tar.gz`);
  await execFileAsync("tar", ["-czf", archive, "-C", folder, "pi"]);
  const bytes = await readFile(archive);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    binarySha256: createHash("sha256").update(binary).digest("hex"),
  };
}

/** The target the fixture installs for. */
function fixtureTarget(): RuntimeTarget {
  const value = runtimeTarget(process.platform, process.arch);
  assert.ok(value, "this platform has managed runtimes");
  assert.notEqual(value, "win32-x64", "the fixture installs the tarball of a POSIX target");
  return value;
}

const root = await mkdtemp(join(tmpdir(), "openbot-provider-runtime-install-e2e-"));
const fixture = join(root, "fixture");
const report: Report = { passed: false };
const target = fixtureTarget();
/** The archive name the provider publishes for this target. */
const ASSET = `pi-${target.replace("win32", "windows")}.tar.gz`;

/** The lock with the fixture's archive in place of the pinned one. */
function fixtureLock(input: {
  version: string;
  url: string;
  sha256: string;
  bytes: number;
  binarySha256: string;
}): AgentRuntimeLock {
  const real = parseAgentRuntimeLock(lockValue);
  return {
    ...real,
    pi: {
      ...real.pi,
      version: input.version,
      artifacts: {
        ...real.pi.artifacts,
        [target]: {
          ...real.pi.artifacts[target],
          url: input.url,
          assetSha256: input.sha256,
          downloadBytes: input.bytes,
          installedBytes: input.bytes,
          files: { "bin/pi": input.binarySha256 },
        },
      },
    },
  };
}

const pinned = await buildArchive(PINNED_VERSION);
const newer = await buildArchive(NEWER_VERSION);

/** The fixture server: the archive, the release that names it and the block list. */
const routes: Record<string, { body: Buffer; type: string }> = {
  "/releases/latest": {
    body: Buffer.from(
      JSON.stringify({
        tag_name: `v${NEWER_VERSION}`,
        assets: [{ name: ASSET, digest: `sha256:${newer.sha256}`, size: newer.bytes.length }],
      }),
      "utf8",
    ),
    type: "application/json",
  },
  "/blocklist": {
    body: Buffer.from(JSON.stringify({ schemaVersion: 1, blocked: {} }), "utf8"),
    type: "application/json",
  },
  [`/download/${ASSET}`]: { body: newer.bytes, type: "application/gzip" },
  "/download/pi-pinned.tar.gz": { body: pinned.bytes, type: "application/gzip" },
};
const requests: string[] = [];
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  requests.push(path);
  const route = routes[path];
  if (!route) {
    response.writeHead(404).end("not found");
    return;
  }
  const start = Number(/^bytes=(\d+)-$/u.exec(request.headers.range ?? "")?.[1] ?? Number.NaN);
  const body = Number.isSafeInteger(start) ? route.body.subarray(start) : route.body;
  const headers: Record<string, string> = {
    "content-type": route.type,
    "content-length": String(body.length),
    connection: "close",
  };
  if (body.length !== route.body.length) {
    headers["content-range"] = `bytes ${start}-${route.body.length - 1}/${route.body.length}`;
    response.writeHead(206, headers);
  } else {
    response.writeHead(200, headers);
  }
  response.end(body);
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address !== null && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;

/** The local path that serves an upstream URL, or `null` for a source the fixture does not have. */
function localPath(url: string): string | null {
  if (url.startsWith(base)) return url;
  if (url === RELEASE_URL) return `${base}/releases/latest`;
  if (url === BLOCKLIST_URL) return `${base}/blocklist`;
  const asset = /^https:\/\/github\.com\/earendil-works\/pi\/releases\/download\/[^/]+\/(.+)$/u.exec(url);
  return asset?.[1] ? `${base}/download/${asset[1]}` : null;
}

const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const local = localPath(url);
  if (!local) return new Response("not found", { status: 404 });
  return fetch(local, init);
};

const managers: ProviderRuntimeManager[] = [];
/** A manager over a store of its own, with the fixture lock and no network. */
function createManager(name: string, lock: AgentRuntimeLock, activations: string[]): ProviderRuntimeManager {
  const manager = new ProviderRuntimeManager({
    root: join(root, name, "store"),
    downloadRoot: join(root, name, "downloads"),
    isProviderOn: (provider) => provider === PROVIDER,
    availableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
    fetchImpl,
    lock,
    updateRuntime: (_runtime, install) =>
      Effect.gen(function* () {
        activations.push(yield* install());
      }),
  });
  managers.push(manager);
  return manager;
}

const ownCliEnv = `OPENBOT_${PROVIDER.toUpperCase()}_PATH`;
try {
  // 1. A download whose bytes do not match the hash the lock names is refused, and nothing is
  // installed: the user is told the download failed rather than left with a broken CLI.
  const wrong = createManager(
    "wrong-hash",
    fixtureLock({
      version: PINNED_VERSION,
      url: `${base}/download/pi-pinned.tar.gz`,
      sha256: createHash("sha256").update("not the archive").digest("hex"),
      bytes: pinned.bytes.length,
      binarySha256: pinned.binarySha256,
    }),
    [],
  );
  await runCauseEffect(wrong.initialize());
  const failed = nextStatus(
    wrong,
    "the download to fail",
    (snapshot) => snapshot.providers.pi.phase === "download-error",
  );
  await runCauseEffect(wrong.download(PROVIDER));
  await failed;
  const wrongStatus = wrong.getStatus().providers.pi;
  const wrongStore = join(root, "wrong-hash", "store", "pi", target);
  report.wrongHash = {
    phase: wrongStatus.phase,
    message: wrongStatus.message,
    installed: (await readdir(wrongStore).catch(() => [])).length > 0,
    partialLeft: (await readdir(join(root, "wrong-hash", "downloads")).catch(() => [])).length > 0,
    requests: requests.length,
  };
  assert.equal(report.wrongHash.phase, "download-error", "the download fails");
  assert.equal(report.wrongHash.message, sourceText("error.provider.downloadIntegrity"), "the row says why");
  assert.equal(report.wrongHash.installed, false, "nothing is installed");
  assert.equal(report.wrongHash.partialLeft, false, "the partial download is removed");

  // 2. The same download with the right hash installs the archive and activates the runtime.
  const activations: string[] = [];
  const manager = createManager(
    "install",
    fixtureLock({
      version: PINNED_VERSION,
      url: `${base}/download/pi-pinned.tar.gz`,
      sha256: pinned.sha256,
      bytes: pinned.bytes.length,
      binarySha256: pinned.binarySha256,
    }),
    activations,
  );
  let readyEvent = false;
  manager.on("ready", (runtime) => {
    if (runtime === PROVIDER) readyEvent = true;
  });
  await runCauseEffect(manager.initialize());
  const ready = nextStatus(manager, "the runtime to be ready", (snapshot) => snapshot.providers.pi.phase === "ready");
  await runCauseEffect(manager.download(PROVIDER));
  await ready;
  const installed = manager.getStatus().providers.pi;
  const executable = join(root, "install", "store", "pi", target, PINNED_VERSION, "bin", "pi");
  report.install = {
    phase: installed.phase,
    version: installed.version,
    executable: (await exists(executable)) ? executable : null,
    activated: activations[0] ?? null,
    readyEvent,
    requests: requests.length,
  };
  assert.equal(report.install.phase, "ready", "the runtime is ready");
  assert.equal(report.install.version, PINNED_VERSION, "the pinned version is installed");
  assert.ok(report.install.executable, "the CLI is in the store");
  assert.equal(report.install.activated, executable, "the agent service is handed the new CLI");
  assert.ok(report.install.readyEvent, "the app is told the runtime is ready");

  // 3. The release check finds a newer version, and the app offers it.
  await runCauseEffect(manager.checkForUpdates());
  const offer = manager.getStatus().providers.pi.availableVersion ?? null;
  assert.equal(offer, NEWER_VERSION, "the newer version is offered");

  // 4. A CLI the user pointed OpenBot at is left alone: nothing is downloaded for it.
  process.env[ownCliEnv] = join(root, "own-cli", "pi");
  const beforeOwnCli = requests.length;
  const refusal = await runCauseEffect(manager.download(PROVIDER)).then(
    () => null,
    (failure: unknown) => failure,
  );
  report.ownCli = {
    message: refusal instanceof Error ? refusal.message : "",
    requests: requests.length - beforeOwnCli,
    offer: manager.getStatus().providers.pi.availableVersion ?? null,
    version: manager.getStatus().providers.pi.version,
  };
  assert.ok(refusal instanceof Error, "the download is refused");
  assert.equal(report.ownCli.message, sourceText("error.provider.cliOverride"), "the row says why");
  assert.equal(report.ownCli.requests, 0, "nothing is downloaded");
  assert.equal(report.ownCli.offer, null, "no update is offered");
  assert.equal(report.ownCli.version, PINNED_VERSION, "the installed version stays");
  delete process.env[ownCliEnv];

  // 5. The update path: the download installs the newer version and hands it over.
  const updated = nextStatus(
    manager,
    "the update to be ready",
    (snapshot) => snapshot.providers.pi.phase === "ready" && snapshot.providers.pi.version === NEWER_VERSION,
  );
  await runCauseEffect(manager.download(PROVIDER));
  await updated;
  const targetStore = join(root, "install", "store", "pi", target);
  report.update = {
    offer,
    phase: manager.getStatus().providers.pi.phase,
    version: manager.getStatus().providers.pi.version,
    activated: activations[1] ?? null,
    versions: (await readdir(targetStore)).sort(),
    record: await exists(join(targetStore, NEWER_VERSION, "openbot-install.json")),
  };
  assert.equal(report.update.offer, NEWER_VERSION, "the newer version was offered");
  assert.equal(report.update.phase, "ready", "the update ends with a ready runtime");
  assert.equal(report.update.version, NEWER_VERSION, "the newer version is the one that runs");
  assert.equal(report.update.activated, join(targetStore, NEWER_VERSION, "bin", "pi"), "the new CLI is handed over");
  assert.deepEqual(
    report.update.versions,
    [PINNED_VERSION, NEWER_VERSION].sort(),
    "the old version stays as a fallback",
  );
  assert.ok(report.update.record, "the install of an upstream release is recorded");

  report.passed = true;
} finally {
  for (const manager of managers) await runCauseEffect(manager.stop()).catch(() => undefined);
  await new Promise<void>((done) => server.close(() => done()));
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
