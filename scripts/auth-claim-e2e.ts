// Proves that a self-hosted owner can sign a server claim and redeem it with a local account service
// only. It starts a second, throwaway instance of the account service on a free port, with its own
// state directory and its own development admin token. The live service on 127.0.0.1:3100 and the
// production keys are never used.
//
// Run: bun scripts/auth-claim-e2e.ts
// It writes .openbot-build/auth-claim-e2e.json and exits non-zero on a failure.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(import.meta.dirname, "..");
const AUTH_API_DIRECTORY = join(ROOT, "apps", "auth-api");
const REPORT_PATH = join(ROOT, ".openbot-build", "auth-claim-e2e.json");
const STATE_DIRECTORY = join(ROOT, ".openbot-build", "auth-claim-e2e", "state");
const OWNER_EMAIL = "owner@example.test";
const LIVE_SERVICE_PORT = 3100;
const REQUEST_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 240_000;
const PROBE_START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 20_000;
const MIGRATION_TIMEOUT_MS = 180_000;

/** The reply of the account service, with only the fields that the checks read. */
interface ApiReply {
  status: number;
  body: ApiBody;
}

interface ApiBody {
  claim?: string;
  expiresAt?: number;
  sessionToken?: string;
  email?: string;
  errorCode?: string;
}

/** A member of a reply body, such as the user of a session or the error of a failure. */
interface ApiMember {
  email?: string;
  code?: string;
}

/** The instance that the run used. */
interface InstanceReport {
  port: number;
  stateDirectory: string;
  adminToken: string;
  liveServicePort: number;
}

interface Check {
  name: string;
  passed: boolean;
  detail?: unknown;
}

const checks: Check[] = [];
function check(name: string, passed: boolean, detail?: unknown) {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
}

/** The environment of the throwaway instance. It holds no key of the developer or of production. */
function instanceEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...extra };
}

interface CommandResult {
  code: number | null;
  output: string;
}

/** Runs a command with a time limit and keeps the last lines of its output. */
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<CommandResult>((resolveResult) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-20_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveResult({ code, output });
    });
  });
}

/** A port that nothing listens on. The live service keeps its own port. */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const server = createServer();
      server.once("error", rejectPort);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const value = typeof address === "object" && address ? address.port : 0;
        server.close(() => (value > 0 ? resolvePort(value) : rejectPort(new Error("No free port."))));
      });
    });
    if (port !== LIVE_SERVICE_PORT) return port;
  }
  throw new Error("No free port for the throwaway account service.");
}

/** A parsed reply body. */
function isParsedObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

/** A string field of a parsed reply. */
function readString(value: unknown, name: string): string | undefined {
  if (!isParsedObject(value)) return undefined;
  const field = value[name];
  return typeof field === "string" ? field : undefined;
}

/** A number field of a parsed reply. */
function readNumber(value: unknown, name: string): number | undefined {
  if (!isParsedObject(value)) return undefined;
  const field = value[name];
  return typeof field === "number" ? field : undefined;
}

/** A member of a parsed reply. */
function readMember(value: unknown, name: string): ApiMember {
  const member: ApiMember = {};
  if (!isParsedObject(value)) return member;
  const email = readString(value[name], "email");
  if (email !== undefined) member.email = email;
  const code = readString(value[name], "code");
  if (code !== undefined) member.code = code;
  return member;
}

/** The body of a reply, with only the fields that the checks read. */
function parseApiBody(value: unknown): ApiBody {
  const body: ApiBody = {};
  const claim = readString(value, "claim");
  if (claim !== undefined) body.claim = claim;
  const expiresAt = readNumber(value, "expiresAt");
  if (expiresAt !== undefined) body.expiresAt = expiresAt;
  const sessionToken = readString(value, "sessionToken");
  if (sessionToken !== undefined) body.sessionToken = sessionToken;
  // The session reply holds the user in a member, the account reply holds it at the top.
  const email = readMember(value, "user").email ?? readString(value, "email");
  if (email !== undefined) body.email = email;
  const errorCode = readMember(value, "error").code;
  if (errorCode !== undefined) body.errorCode = errorCode;
  return body;
}

async function readBody(response: Response): Promise<ApiBody> {
  const text = await response.text();
  try {
    return parseApiBody(JSON.parse(text));
  } catch {
    return {};
  }
}

async function postJson(base: string, path: string, body: unknown, token?: string): Promise<ApiReply> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: await readBody(response) };
}

async function getJson(base: string, path: string, token?: string): Promise<ApiReply> {
  const response = await fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: await readBody(response) };
}

/** Options for a throwaway instance start. Probes override the command and the readiness deadline. */
interface StartInstanceOptions {
  startTimeoutMs?: number;
  command?: string;
  args?: string[];
}

/** Whether anything is left in the process group a detached child leads. */
function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** The cleanup state after a failed start attempt. */
interface FailedStartCleanup {
  stopped: boolean;
  portClosed: boolean;
  groupAlive: boolean;
}

type StartAttemptResult =
  | { ready: true; child: ChildProcess; base: string }
  | { ready: false; error: string; cleanup: FailedStartCleanup };

/** Starts the account service and waits until it answers, or reports cleanup after a failure. */
async function attemptStartInstance(
  port: number,
  adminToken: string,
  options: StartInstanceOptions = {},
): Promise<StartAttemptResult> {
  const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const command = options.command ?? join(ROOT, "node_modules", ".bin", "vite");
  const args = options.args ?? ["dev"];
  const child = spawn(command, args, {
    cwd: AUTH_API_DIRECTORY,
    env: instanceEnvironment({
      NODE_ENV: "development",
      // The instance uses its local bindings only. It never asks Cloudflare for anything.
      CLOUDFLARE_VITE_FORCE_LOCAL: "true",
      OPENBOT_API_PORT: String(port),
      OPENBOT_API_STATE_DIR: STATE_DIRECTORY,
      SERVER_CLAIMS_ADMIN_TOKEN: adminToken,
      // `wrangler.jsonc` sets four of the five mail settings, and the account service refuses that
      // half configuration. Blank settings turn the delivery off, so the instance sends no mail.
      EMAIL_SMTP_HOST: "",
      EMAIL_SMTP_PORT: "",
      EMAIL_SMTP_USERNAME: "",
      EMAIL_SMTP_PASSWORD: "",
      EMAIL_FROM: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
    // The instance leads its own group, so the stop below reaches the Worker runtime too.
    detached: true,
  });
  let output = "";
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-20_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const cleanup = await cleanupFailedStart(child, port);
      return {
        ready: false,
        error: `The account service stopped before it became ready.\n${output}`,
        cleanup,
      };
    }
    try {
      const response = await fetch(`${base}/health/live`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return { ready: true, child, base };
    } catch {
      // The service refuses connections while Vite and the Worker runtime start.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  const cleanup = await cleanupFailedStart(child, port);
  return {
    ready: false,
    error: `The account service did not become ready on port ${port}.\n${output}`,
    cleanup,
  };
}

/** Starts the account service and waits until it answers. */
async function startInstance(port: number, adminToken: string, options: StartInstanceOptions = {}) {
  const result = await attemptStartInstance(port, adminToken, options);
  if (result.ready) return { child: result.child, base: result.base };
  throw new Error(result.error);
}

/** Stops the instance group and waits for its port to close. */
async function stopInstance(child: ChildProcess, port: number): Promise<boolean> {
  const group = child.pid;
  if (group === undefined) return false;

  for (const [signal, timeout] of [
    ["SIGTERM", STOP_TIMEOUT_MS],
    ["SIGKILL", 5_000],
  ] as const) {
    try {
      process.kill(-group, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((await portClosed(port)) && !isProcessGroupAlive(group)) return true;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  return (await portClosed(port)) && !isProcessGroupAlive(group);
}

/** Whether nothing listens on the port of the instance any more. */
function portClosed(port: number) {
  return new Promise<boolean>((resolveClosed) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolveClosed(false);
    });
    socket.once("error", () => resolveClosed(true));
    socket.setTimeout(2_000, () => {
      socket.destroy();
      resolveClosed(false);
    });
  });
}

/** Stops a failed start, then reports whether the process group and port are clear. */
async function cleanupFailedStart(child: ChildProcess, port: number): Promise<FailedStartCleanup> {
  const stopped = await stopInstance(child, port);
  const groupPid = child.pid;
  return {
    stopped,
    portClosed: await portClosed(port),
    groupAlive: groupPid !== undefined && isProcessGroupAlive(groupPid),
  };
}

/** Proves that failed startup paths stop the detached group and free the port before state removal. */
async function proveFailedStartupCleanup(adminToken: string) {
  const timeoutPort = await freePort();
  const timeout = await attemptStartInstance(timeoutPort, adminToken, {
    startTimeoutMs: PROBE_START_TIMEOUT_MS,
    command: process.execPath,
    args: [
      "-e",
      "require('http').createServer((_, response) => response.writeHead(503).end()).listen(Number(process.env.OPENBOT_API_PORT))",
    ],
  });
  check("a readiness timeout stops the detached process group", !timeout.ready && timeout.cleanup.stopped, {
    port: timeoutPort,
    stopped: timeout.ready ? null : timeout.cleanup.stopped,
  });
  check("a readiness timeout frees the port", !timeout.ready && timeout.cleanup.portClosed, {
    port: timeoutPort,
    portClosed: timeout.ready ? null : timeout.cleanup.portClosed,
  });
  check("a readiness timeout leaves no process group", !timeout.ready && !timeout.cleanup.groupAlive, {
    port: timeoutPort,
    groupAlive: timeout.ready ? null : timeout.cleanup.groupAlive,
  });

  const orphanPort = await freePort();
  const orphan = await attemptStartInstance(orphanPort, adminToken, {
    command: process.execPath,
    args: [
      "-e",
      `const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "require('node:http').createServer((_, response) => response.writeHead(503).end()).listen(Number(process.env.OPENBOT_API_PORT), '127.0.0.1', () => process.stdout.write('ready'))"], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.once('data', () => process.exit(0));`,
    ],
  });
  check(
    "an exited parent does not leave its listening grandchild",
    !orphan.ready &&
      orphan.error.includes("stopped before it became ready") &&
      orphan.cleanup.stopped &&
      orphan.cleanup.portClosed,
    {
      port: orphanPort,
      stopped: orphan.ready ? null : orphan.cleanup.stopped,
      portClosed: orphan.ready ? null : orphan.cleanup.portClosed,
    },
  );

  const earlyPort = await freePort();
  const early = await attemptStartInstance(earlyPort, adminToken, {
    command: process.execPath,
    args: ["-e", "process.exit(1)"],
  });
  check("an early child exit stops the detached process group", !early.ready && early.cleanup.stopped, {
    port: earlyPort,
    stopped: early.ready ? null : early.cleanup.stopped,
  });
  check("an early child exit frees the port", !early.ready && early.cleanup.portClosed, {
    port: earlyPort,
    portClosed: early.ready ? null : early.cleanup.portClosed,
  });
  check("an early child exit leaves no process group", !early.ready && !early.cleanup.groupAlive, {
    port: earlyPort,
    groupAlive: early.ready ? null : early.cleanup.groupAlive,
  });
}

/** The stored claim of the instance. The service keeps only the hash of a claim. */
async function storedClaims(): Promise<{ claimHash: string; redeemed: boolean }[]> {
  const directory = join(STATE_DIRECTORY, "v3", "d1", "miniflare-D1DatabaseObject");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  const [name] = names;
  if (name === undefined) throw new Error("The instance kept no database.");
  const database = new DatabaseSync(join(directory, name), { readOnly: true });
  try {
    const rows = database.prepare("SELECT claim_hash, redeemed_at FROM server_claims").all();
    return rows.map((row) => {
      const redeemedAt = readNumber(row, "redeemed_at");
      return {
        claimHash: readString(row, "claim_hash") ?? "",
        redeemed: redeemedAt !== undefined && redeemedAt !== null,
      };
    });
  } finally {
    database.close();
  }
}

/** The state directory of the throwaway instance. It stays inside the worktree. */
function insideWorktree(path: string): boolean {
  return path.startsWith(`${ROOT}/`);
}

const adminToken = randomBytes(32).toString("base64url");
let instance: { child: ChildProcess; base: string } | null = null;
let port = 0;

await proveFailedStartupCleanup(adminToken);

try {
  if (!insideWorktree(STATE_DIRECTORY)) throw new Error("The state directory is outside the worktree.");
  await rm(STATE_DIRECTORY, { recursive: true, force: true });
  await mkdir(STATE_DIRECTORY, { recursive: true });

  const migration = await run(
    join(ROOT, "node_modules", ".bin", "wrangler"),
    ["d1", "migrations", "apply", "openbot-auth", "--local", "--persist-to", STATE_DIRECTORY],
    AUTH_API_DIRECTORY,
    instanceEnvironment({}),
    MIGRATION_TIMEOUT_MS,
  );
  check(
    "the throwaway instance gets its own migrated database",
    migration.code === 0,
    migration.code === 0 ? { database: "openbot-auth" } : { code: migration.code, output: migration.output },
  );
  if (migration.code !== 0) throw new Error("The migrations of the throwaway instance failed.");

  port = await freePort();
  instance = await startInstance(port, adminToken);
  check("the throwaway instance answers on its own port", true, { port, stateDirectory: STATE_DIRECTORY });

  const withoutToken = await postJson(instance.base, "/v2/admin/server-claims", { email: OWNER_EMAIL });
  check(
    "the admin route refuses a caller without the admin token",
    withoutToken.status === 401 && withoutToken.body.errorCode === "unauthorized",
    { status: withoutToken.status, code: withoutToken.body.errorCode },
  );

  const withWrongToken = await postJson(
    instance.base,
    "/v2/admin/server-claims",
    { email: OWNER_EMAIL },
    "wrong-token",
  );
  check(
    "the admin route refuses a caller with the wrong admin token",
    withWrongToken.status === 401 && withWrongToken.body.errorCode === "unauthorized",
    { status: withWrongToken.status, code: withWrongToken.body.errorCode },
  );

  const signed = await postJson(instance.base, "/v2/admin/server-claims", { email: OWNER_EMAIL }, adminToken);
  const claim = signed.body.claim;
  const expiresAt = signed.body.expiresAt;
  check(
    "the admin route signs a claim for the owner's email",
    signed.status === 200 && typeof claim === "string" && claim.length >= 16 && typeof expiresAt === "number",
    { status: signed.status, claimLength: claim?.length ?? 0 },
  );
  check(
    "the claim expires in 15 minutes",
    typeof expiresAt === "number" && expiresAt - Date.now() > 14 * 60 * 1000 && expiresAt - Date.now() < 16 * 60 * 1000,
    { minutes: typeof expiresAt === "number" ? Math.round((expiresAt - Date.now()) / 60_000) : null },
  );

  const redeemed = await postJson(instance.base, "/v2/server-claims/redeem", { claim });
  const sessionToken = redeemed.body.sessionToken;
  check(
    "the server redeems the claim for a session of the owner",
    redeemed.status === 200 && typeof sessionToken === "string" && redeemed.body.email === OWNER_EMAIL,
    { status: redeemed.status, email: redeemed.body.email },
  );

  const account = await getJson(instance.base, "/v1/me", sessionToken);
  check(
    "the session of the claim opens the account of the owner",
    account.status === 200 && account.body.email === OWNER_EMAIL,
    { status: account.status, email: account.body.email },
  );

  const again = await postJson(instance.base, "/v2/server-claims/redeem", { claim });
  check("the claim works only once", again.status === 401 && again.body.errorCode === "server_claim_invalid", {
    status: again.status,
    code: again.body.errorCode,
  });

  const unknown = await postJson(instance.base, "/v2/server-claims/redeem", {
    claim: randomBytes(32).toString("base64url"),
  });
  check(
    "a claim that was never signed is refused",
    unknown.status === 401 && unknown.body.errorCode === "server_claim_invalid",
    { status: unknown.status, code: unknown.body.errorCode },
  );

  const stored = await storedClaims();
  check(
    "the account service keeps only the hash of the claim",
    stored.length === 1 &&
      typeof claim === "string" &&
      stored[0]?.claimHash !== claim &&
      /^[A-Za-z0-9_-]{43}$/u.test(stored[0]?.claimHash ?? ""),
    { rows: stored.length, hashLength: stored[0]?.claimHash.length ?? 0 },
  );
  check("the stored claim is spent", stored[0]?.redeemed === true, { redeemed: stored[0]?.redeemed ?? null });
} catch (error) {
  check("the throwaway instance runs the claim flow", false, {
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  if (instance) {
    const stopped = await stopInstance(instance.child, port);
    check("the throwaway instance stops", stopped, { port });
    check("the port of the throwaway instance is free", await portClosed(port), { port });
  }
  if (insideWorktree(STATE_DIRECTORY)) await rm(STATE_DIRECTORY, { recursive: true, force: true });
}

const instanceReport: InstanceReport = {
  port,
  stateDirectory: STATE_DIRECTORY,
  adminToken: "generated for this run",
  liveServicePort: LIVE_SERVICE_PORT,
};
const report = {
  generatedAt: new Date().toISOString(),
  passed: checks.every((entry) => entry.passed),
  checks,
  instance: instanceReport,
};
await mkdir(join(ROOT, ".openbot-build"), { recursive: true });
await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
for (const entry of checks) process.stdout.write(`${entry.passed ? "PASS" : "FAIL"} ${entry.name}\n`);
process.stdout.write(`Report: ${REPORT_PATH}\n`);
if (!report.passed) process.exitCode = 1;
