// Runs the real `HostService` publish path against a local fake account service. It publishes a host,
// checks the account directory row and the owner membership, publishes again after an account change
// and checks that the previous account's owner membership is no longer active on this computer, and
// checks that a second account cannot publish the same host.
//
// Run: bun scripts/host-publish-e2e.ts
// It writes .openbot-build/host-publish-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { plugin } from "bun";
import { Effect, Result } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import { CentralAuthManager } from "../src/main/central-auth-manager";
import { toRemoteWorkflowError } from "../src/main/remote-service-effects";
import type { TeamApiBrowser } from "../src/main/team-api/dependencies";
import { TeamStore } from "../src/main/team-store";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "host-publish-e2e");
const MIGRATIONS = join(ROOT, "apps", "auth-api", "migrations");
const SERVER = join(ROOT, "apps", "auth-api", "scripts", "host-publish-server.ts");
const START_LIMIT_MS = 20_000;
const APP_VERSION = "0.0.0-e2e";

const checks: { name: string; passed: boolean; detail?: unknown }[] = [];
function check(name: string, passed: boolean, detail?: unknown) {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
}

/** Starts the account service over the database file and resolves with its port. */
function startAccountServer(databasePath: string): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, [SERVER, databasePath], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error("The account server did not start.")), START_LIMIT_MS);
    child.once("exit", (code) => reject(new Error(`The account server stopped with code ${code}.`)));
    if (!child.stdout) return reject(new Error("The account server has no output."));
    createInterface({ input: child.stdout }).once("line", (line) => {
      clearTimeout(timer);
      const port = Number(JSON.parse(line).port);
      if (!Number.isInteger(port)) return reject(new Error("The account server has no port."));
      resolvePort({ child, port });
    });
  });
}

/** Signs in with an email code and returns the signed-in user. */
async function signIn(
  auth: CentralAuthManager,
  email: string,
): Promise<{ id: string; email: string; name: string | null; avatarUrl: string | null }> {
  const sent = await runCauseEffect(auth.requestEmailCode(email));
  if (sent.status !== "code_sent" || !sent.developmentCode) throw new Error(`No sign-in code for ${email}.`);
  const signedIn = await runCauseEffect(auth.verifyEmailCode(sent.challengeId, sent.developmentCode));
  if (signedIn.status !== "signed_in") throw new Error(`Sign-in failed for ${email}.`);
  return signedIn.user;
}

function errorCode(error: unknown): string | null {
  if (!isDynamicRecord(error)) return null;
  const cause = error.cause;
  if (isDynamicRecord(cause) && isString(cause.code)) return cause.code;
  return null;
}

// Team API modules import Electron. Nothing here opens a window.
plugin({
  name: "host-publish-electron-boundary",
  setup(build) {
    class Inert {}
    build.module("electron", () => ({
      loader: "object",
      exports: {
        app: { getPath: () => tmpdir(), getVersion: () => APP_VERSION, isPackaged: false, on: () => undefined },
        BrowserWindow: class extends Inert {
          static getAllWindows() {
            return [];
          }
        },
        MessageChannelMain: class extends Inert {},
        Notification: class extends Inert {
          static isSupported() {
            return false;
          }
        },
        clipboard: {},
        desktopCapturer: {},
        dialog: {},
        ipcMain: { handle: () => undefined, removeHandler: () => undefined, on: () => undefined },
        nativeImage: {},
        net: {},
        powerMonitor: { on: () => undefined },
        safeStorage: { isEncryptionAvailable: () => false },
        screen: { getAllDisplays: () => [] },
        session: {},
        shell: { openExternal: async () => undefined },
        systemPreferences: {},
        webContents: { getAllWebContents: () => [] },
      },
    }));
  },
});

const { HostService } = await import("../src/main/host-service");

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
const teamBrowser: TeamApiBrowser = {
  listTabs: () => [],
  getControlState: () => ({ sessions: [] }),
  open: unused,
  activate: unused,
  navigate: unused,
  reload: unused,
  stop: unused,
  takeUserControl: unused,
  releaseUserControl: () => {},
  releaseUserControlHeldBy: () => {},
  close: unused,
  capturePreview: unused,
  setVisible: unused,
  getDisplayState: () => ({ tabs: [], activeTabId: null }),
  loadUrl: unused,
  isPrivate: () => false,
  startView: unused,
  dispatchViewInput: unused,
  copyViewSelection: unused,
  importSignIn: unused,
};

function hostRow(database: DatabaseSync, hostId: string) {
  const row = database
    .prepare("SELECT owner_user_id, device_public_key, name FROM remote_hosts WHERE host_id = ?")
    .get(hostId);
  if (!isDynamicRecord(row) || !isString(row.owner_user_id) || !isString(row.name)) return undefined;
  return {
    owner_user_id: row.owner_user_id,
    device_public_key: row.device_public_key === null || isString(row.device_public_key) ? row.device_public_key : null,
    name: row.name,
  };
}

function ownerMembership(database: DatabaseSync, hostId: string, userId: string) {
  const row = database
    .prepare(
      "SELECT membership_id, status FROM remote_memberships WHERE host_id = ? AND user_id = ? AND role = 'owner'",
    )
    .get(hostId, userId);
  if (!isDynamicRecord(row) || !isString(row.membership_id) || !isString(row.status)) return undefined;
  return { membership_id: row.membership_id, status: row.status };
}

const root = await mkdtemp(join(tmpdir(), "openbot-host-publish-"));
const databasePath = join(root, "auth.db");
const userData = join(root, "user-data");
const database = new DatabaseSync(databasePath);
database.exec("PRAGMA foreign_keys = ON");
for (const name of (await readdir(MIGRATIONS)).sort()) database.exec(await readFile(join(MIGRATIONS, name), "utf8"));

let server: ChildProcess | undefined;
let error: string | undefined;
try {
  const started = await startAccountServer(databasePath);
  server = started.child;
  const apiUrl = `http://127.0.0.1:${started.port}`;
  const auth = new CentralAuthManager({
    apiUrl,
    storagePath: join(root, "session.bin"),
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString(),
  });
  const team = new TeamStore(join(userData, "openbot-team-server-v2.json"));
  const openbotDatabase = new OpenBotDatabase(userData);
  const agentStore = new AgentStore(userData, join(root, "home"), openbotDatabase);
  const mailbox = new MailboxStore(userData, agentStore.sharedRoot, agentStore.database);
  const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
  const agents = new AgentService({ store: agentStore, mailbox, browser: agentBrowser, sidebarLayout: sidebar });
  const host = new HostService({
    appVersion: APP_VERSION,
    store: team,
    agents,
    agentsReady: () => Effect.void,
    skills: { listInstalledForChatTags: () => Effect.succeed([]) },
    sidebarLayout: sidebar,
    mailbox,
    browser: teamBrowser,
    getSignedInUser: () => auth.getSignedInUser(),
    redeemCentralTicket: () => Effect.succeed(null),
    sendTeamInviteEmail: unused,
    registerRemoteHost: (input) => auth.registerRemoteHost(input).pipe(toRemoteWorkflowError),
    listRemoteMembers: (hostId) => auth.listRemoteMembers(hostId).pipe(toRemoteWorkflowError),
    remoteControlPlaneUrl: auth.resolveApiUrl("/"),
  });

  try {
    await runCauseEffect(auth.initialize());
    await runCauseEffect(sidebar.initialize());
    await runCauseEffect(agentStore.initialize());
    await runCauseEffect(mailbox.initialize());
    await runCauseEffect(team.initialize());

    const userA = await signIn(auth, "owner-a@example.test");
    await runCauseEffect(host.applySignedInAccount(userA));
    const configuredA = await runCauseEffect(host.configure({ serverName: "Studio A" }));
    const identityA = team.getIdentity();
    assert.ok(identityA, "Account A must have a host identity.");
    check("the first publish finishes without error", configuredA.phase !== "error", {
      phase: configuredA.phase,
      message: configuredA.message,
    });

    const rowA = hostRow(database, identityA.serverId);
    const membershipA = ownerMembership(database, identityA.serverId, userA.id);
    check(
      "the account directory holds the host row and the device key",
      rowA?.owner_user_id === userA.id && rowA.device_public_key === identityA.publicKey && rowA.name === "Studio A",
      { row: rowA ?? null },
    );
    check(
      "the account directory holds an active owner membership",
      membershipA?.status === "active" && membershipA.membership_id === team.getOwnerMemberId(),
      { membership: membershipA ?? null, localOwnerId: team.getOwnerMemberId() },
    );

    const membersAfterPublish = await runCauseEffect(host.listMembers());
    check(
      "the member list matches the account directory after publish",
      membersAfterPublish.length === 1 &&
        membersAfterPublish[0]?.email === userA.email &&
        membersAfterPublish[0]?.id === membershipA?.membership_id,
      membersAfterPublish,
    );

    const userB = await signIn(auth, "owner-b@example.test");
    host.unbindChangedAccount(userB);
    await runCauseEffect(host.applySignedInAccount(userB));
    const configuredB = await runCauseEffect(host.configure({ serverName: "Studio B" }));
    const identityB = team.getIdentity();
    assert.ok(identityB, "Account B must have a host identity.");
    check("the second account publishes its own host", configuredB.phase !== "error", {
      phase: configuredB.phase,
      message: configuredB.message,
    });
    check("the active host changes with the account", identityB.serverId !== identityA.serverId, {
      hostA: identityA.serverId,
      hostB: identityB.serverId,
    });

    const membershipB = ownerMembership(database, identityB.serverId, userB.id);
    const membersAfterSwitch = await runCauseEffect(host.listMembers());
    check(
      "after an account change the computer lists only the new account's owner membership",
      membersAfterSwitch.length === 1 &&
        membersAfterSwitch[0]?.email === userB.email &&
        membersAfterSwitch[0]?.id === membershipB?.membership_id &&
        membersAfterSwitch[0]?.id !== membershipA?.membership_id,
      { members: membersAfterSwitch, previousOwnerMembershipId: membershipA?.membership_id ?? null },
    );
    check(
      "the previous account's owner membership is not active on this computer",
      team.getOwnerMemberId() === membershipB?.membership_id && team.getOwnerMemberId() !== membershipA?.membership_id,
      { activeOwnerId: team.getOwnerMemberId(), previousOwnerId: membershipA?.membership_id ?? null },
    );

    const blocked = await runCauseEffect(
      Effect.result(
        auth
          .registerRemoteHost({
            hostId: identityA.serverId,
            name: "Stolen",
            ownerMembershipId: randomUUID(),
            devicePublicKey: identityB.publicKey,
          })
          .pipe(toRemoteWorkflowError),
      ),
    );
    check(
      "the second account cannot publish the same host",
      Result.isFailure(blocked) && errorCode(blocked.failure) === "host_owner_mismatch",
      Result.isFailure(blocked) ? { code: errorCode(blocked.failure) } : blocked.success,
    );
  } finally {
    await runCauseEffect(auth.dispose());
  }
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
} finally {
  if (server && server.exitCode === null) {
    const stopped = new Promise((done) => server?.once("exit", done));
    server.kill("SIGTERM");
    await stopped;
  }
  database.close();
  await rm(root, { recursive: true, force: true });
}

const passed = !error && checks.length > 0 && checks.every((item) => item.passed);
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.json"), `${JSON.stringify({ passed, checks, error }, null, 2)}\n`);
for (const item of checks) process.stdout.write(`${item.passed ? "PASS" : "FAIL"} ${item.name}\n`);
process.stdout.write(
  `${passed ? "PASS" : "FAIL"}${error ? `: ${error}` : ""}: report in ${join(OUT, "report.json")}\n`,
);
if (!passed) process.exitCode = 1;
