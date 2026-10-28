// The 1Password and the GitHub connectors of this computer, against local fakes: a fake `op` CLI
// and a fake GitHub server on the loopback interface. No real account, no network, and no real
// secret.
//
// The 1Password part runs the real service and the real CLI runner. Only the fake `op` binary
// answers. The GitHub part runs the real device flow, the real token refresh, and the real bot
// token renewal against the fake server.
//
// Run: bun scripts/connector-e2e.ts
// It writes .openbot-build/connector-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { teeLogLines } from "@openbot/logging";
import { Effect } from "effect";
import { z } from "zod";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { GitHubConnectorService } from "../src/main/github-connector-service";
import { GitHubConnectorStore } from "../src/main/github-connector-store";
import type { GitHubFetch } from "../src/main/github-device-flow";
import { type OnePasswordClient, OnePasswordConnectorService } from "../src/main/onepassword-connector-service";
import { OnePasswordConnectorStore } from "../src/main/onepassword-connector-store";
import type { SecretCipher } from "../src/main/provider-credential-store";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "connector-e2e");
const BIN = join(OUT, "bin");

/** Every secret of this script is a fixture. None of them is a credential of a real account. */
const ONEPASSWORD_SERVICE_TOKEN = "ops_fixture_service_account_token_0001";
const ONEPASSWORD_PASTED_TOKEN = "ops_fixture_pasted_service_account_token_0002";
const ONEPASSWORD_ITEM_PASSWORD = "fixture_1password_item_password_0003";
const GITHUB_ACCESS_TOKEN = "fixture_github_access_token_0000000000000004";
const GITHUB_REFRESH_TOKEN = "fixture_github_refresh_token_0000000000000005";
const GITHUB_REFRESHED_ACCESS_TOKEN = "fixture_github_access_token_0000000000000006";
const GITHUB_REFRESHED_REFRESH_TOKEN = "fixture_github_refresh_token_0000000000000007";
const GITHUB_BOT_TOKEN = "fixture_github_bot_token_00000000000000008";

/** The secrets that must not reach a log line or the report. */
const SECRETS = [
  ONEPASSWORD_SERVICE_TOKEN,
  ONEPASSWORD_PASTED_TOKEN,
  ONEPASSWORD_ITEM_PASSWORD,
  GITHUB_ACCESS_TOKEN,
  GITHUB_REFRESH_TOKEN,
  GITHUB_REFRESHED_ACCESS_TOKEN,
  GITHUB_REFRESHED_REFRESH_TOKEN,
  GITHUB_BOT_TOKEN,
];

const GITHUB_CLIENT_ID = "fixture-github-client-id";
const GITHUB_USER_CODE = "FIXTURE-CODE";
const GITHUB_VERIFICATION_URI = "https://github.com/login/device";
const GITHUB_DEVICE_CODE = "fixture-github-device-code";
const GITHUB_LOGIN = "fixture-github-user";
const GITHUB_REPOSITORY = "fixture-owner/fixture-repo";

/** The state of the fake `op` CLI. The service account token is the only secret in it. */
const fakeOpStateSchema = z.object({
  version: z.string(),
  accountId: z.string(),
  accountEmail: z.string(),
  vaultId: z.string(),
  vaults: z.array(z.object({ id: z.string(), name: z.string() })),
  token: z.string(),
});
type FakeOpState = z.infer<typeof fakeOpStateSchema>;

/** One call of the fake `op` CLI. The service account token is never an argument. */
const fakeOpCallSchema = z.object({
  args: z.array(z.string()),
  opServiceAccountToken: z.string().nullable(),
  opConnectToken: z.string().nullable(),
  opConnectHost: z.string().nullable(),
});

/**
 * The fake `op` CLI. It answers the commands that the connector runs and writes down every call,
 * so the test can see what the connector handed to the child process.
 *
 * The script runs under the same runtime as this test. `process.getBuiltinModule` needs no import,
 * so the file works as a module of any type.
 */
function fakeOpSource(statePath: string, logPath: string): string {
  return `#!${process.execPath}
const fs = process.getBuiltinModule("node:fs");
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(
  logPath,
  JSON.stringify({
    args: args,
    opServiceAccountToken: process.env.OP_SERVICE_ACCOUNT_TOKEN ?? null,
    opConnectToken: process.env.OP_CONNECT_TOKEN ?? null,
    opConnectHost: process.env.OP_CONNECT_HOST ?? null,
  }) + "\\n",
);
function write(value) {
  process.stdout.write(value + "\\n");
}
const command = args[0];
const action = args[1];
if (command === "--version") {
  write(state.version);
  process.exit(0);
}
if (command === "account" && action === "list") {
  write(JSON.stringify([{ account_uuid: state.accountId, email: state.accountEmail, url: "https://example.test" }]));
  process.exit(0);
}
if (command === "vault" && action === "list") {
  write(JSON.stringify(state.vaults));
  process.exit(0);
}
if (command === "vault" && action === "create") {
  const vault = { id: state.vaultId, name: args[2] };
  state.vaults.push(vault);
  fs.writeFileSync(statePath, JSON.stringify(state));
  write(JSON.stringify(vault));
  process.exit(0);
}
if (command === "service-account" && action === "create") {
  write(state.token);
  process.exit(0);
}
process.stderr.write("The fake op CLI does not know this command.\\n");
process.exit(1);
`;
}

/**
 * The cipher of the two connection files. The app uses the secret storage of the operating system;
 * this one keeps the fixtures out of the report in the same way.
 */
const cipherKey = createHash("sha256").update("openbot-connector-e2e-fixture-key").digest();
const fixtureCipher: SecretCipher = {
  encrypt: (value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", cipherKey, iv);
    return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
  },
  decrypt: (value) => {
    const decipher = createDecipheriv("aes-256-gcm", cipherKey, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(value.length - 16));
    return Buffer.concat([decipher.update(value.subarray(12, value.length - 16)), decipher.final()]).toString("utf8");
  },
};

/** Waits for a state, not for a fixed time. */
async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The mode of a file, as the three permission bits. */
async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

/**
 * Runs the git credential helper of the connector, as git runs it: `sh` reads the helper, the
 * operation is the first argument, and the fields of the request come on the standard input.
 */
function runCredentialHelper(helper: string, request: string): Promise<string> {
  // Git drops the `!` that marks the helper as a shell command.
  const command = helper.startsWith("!") ? helper.slice(1) : helper;
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", `${command} "$@"`, command, "get"], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`The credential helper failed: ${Buffer.concat(errors).toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(`${request}\n`);
  });
}

/**
 * The parts that hold a server or a background read. They stop when the test ends, also when a
 * check fails, so the script never waits for a server that nobody closes.
 */
const cleanups: Array<() => Promise<void>> = [];

/** The 1Password part: the fake CLI, the real service, and the files that the service writes. */
async function runOnePassword(root: string, checks: string[], results: Record<string, string>): Promise<void> {
  const fixtureDirectory = join(root, "onepassword-fixture");
  const statePath = join(fixtureDirectory, "op-state.json");
  const logPath = join(fixtureDirectory, "op-calls.jsonl");
  const oldStatePath = join(fixtureDirectory, "op-state-old.json");
  const cliPath = join(BIN, "op");
  const oldCliPath = join(BIN, "op-old");
  await mkdir(fixtureDirectory, { recursive: true });
  const state: FakeOpState = {
    version: "2.18.0",
    accountId: "fixture-account-uuid",
    accountEmail: "fixture@example.test",
    vaultId: "fixture-vault-uuid",
    vaults: [],
    token: ONEPASSWORD_SERVICE_TOKEN,
  };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(oldStatePath, JSON.stringify({ ...state, version: "2.17.9" }));
  await writeFile(cliPath, fakeOpSource(statePath, logPath));
  await chmod(cliPath, 0o755);
  await writeFile(oldCliPath, fakeOpSource(oldStatePath, logPath));
  await chmod(oldCliPath, 0o755);

  // The connector must not give the CLI another identity.
  process.env.OP_SERVICE_ACCOUNT_TOKEN = "fixture_other_identity_token";

  const storePath = join(root, "onepassword", "connector.json");
  const store = new OnePasswordConnectorStore(storePath, fixtureCipher);
  const client: OnePasswordClient = {
    vaults: { list: async () => [{ id: state.vaultId, title: "Shared with OpenBot" }] },
    items: {
      list: async () => [
        {
          id: "fixture-item-id",
          title: "Fixture Login",
          category: "Login",
          websites: [{ url: "https://example.test", autofillBehavior: "ExactDomain" }],
        },
      ],
      get: async () => ({
        fields: [
          { id: "username", fieldType: "STRING", value: state.accountEmail },
          { id: "password", fieldType: "CONCEALED", value: ONEPASSWORD_ITEM_PASSWORD },
        ],
        websites: [{ url: "https://example.test", autofillBehavior: "ExactDomain" }],
      }),
    },
  };
  const connector = new OnePasswordConnectorService({
    store,
    hostName: "fixture-host",
    appVersion: "0.0.0-fixture",
    cliInstall: null,
    openExternal: async () => undefined,
    findCli: () => Effect.succeed([cliPath]),
    createClient: async () => client,
  });
  cleanups.push(async () => {
    await runCauseEffect(connector.dispose()).catch(() => undefined);
  });

  // The setup check finds the CLI of 2.18 or later and the app integration.
  const setup = await runCauseEffect(connector.checkSetup());
  results.onePasswordCli = setup.setup.cli;
  results.onePasswordCliVersion = setup.setup.cliVersion ?? "none";
  results.onePasswordAppIntegration = String(setup.setup.appIntegration);
  assert.equal(setup.setup.cli, "ready", "the setup check must find the CLI");
  assert.equal(setup.setup.cliVersion, "2.18.0", "the setup check must read the version");
  assert.equal(setup.setup.appIntegration, true, "the setup check must ask the CLI for its accounts");
  assert.equal(setup.setup.canInstall, false, "this build has no CLI to install");
  checks.push("the setup check finds the CLI and the app integration");

  // A CLI of 2.17 or older cannot run the service account command.
  const oldConnector = new OnePasswordConnectorService({
    store: new OnePasswordConnectorStore(join(root, "onepassword-old", "connector.json"), fixtureCipher),
    hostName: "fixture-host",
    appVersion: "0.0.0-fixture",
    cliInstall: null,
    openExternal: async () => undefined,
    findCli: () => Effect.succeed([oldCliPath]),
    createClient: async () => client,
  });
  const oldSetup = await runCauseEffect(oldConnector.checkSetup());
  results.onePasswordOldCli = oldSetup.setup.cli;
  assert.equal(oldSetup.setup.cli, "missing", "a CLI of 2.17 or older must not be ready");
  assert.equal(oldSetup.setup.appIntegration, null, "an old CLI is not asked for its accounts");
  checks.push("a CLI of 2.17 or older is not ready");

  // Connect runs the CLI, creates the shared vault, and stores the service account token.
  const connected = await runCauseEffect(connector.connect({ accountId: null }));
  results.onePasswordState = connected.state;
  assert.equal(connected.state, "connected", "the connection must finish");
  assert.equal(connected.error, null, "the connection must not fail");
  assert.deepEqual(connected.vaultNames, ["Shared with OpenBot"], "the shared vault must be the only vault");
  checks.push("the CLI creates the shared vault and the service account");

  // The connection file holds the token only in the cipher, and only the user can read it.
  results.onePasswordFileMode = (await modeOf(storePath)).toString(8);
  results.onePasswordDirectoryMode = (await modeOf(join(root, "onepassword"))).toString(8);
  assert.equal(await modeOf(storePath), 0o600, "the connection file must be readable by the user only");
  assert.equal(
    await modeOf(join(root, "onepassword")),
    0o700,
    "the connection folder must be readable by the user only",
  );
  const stored = await readFile(storePath, "utf8");
  assert.ok(!stored.includes(ONEPASSWORD_SERVICE_TOKEN), "the connection file must not hold the token in clear");
  assert.ok(
    !stored.includes(Buffer.from(ONEPASSWORD_SERVICE_TOKEN).toString("base64")),
    "the connection file must not hold the token in a readable form",
  );
  checks.push("the connection file holds no token and only the user can read it");

  // The CLI runs with the user's own session, without a shell, and never holds the token.
  const calls = (await readFile(logPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => fakeOpCallSchema.parse(JSON.parse(line)));
  results.onePasswordCliCalls = calls.length.toString();
  assert.ok(calls.length >= 4, "the connector must run the CLI");
  for (const call of calls) {
    assert.equal(call.opServiceAccountToken, null, "the CLI must not run as another identity");
    assert.equal(call.opConnectToken, null, "the CLI must not run as another identity");
    assert.equal(call.opConnectHost, null, "the CLI must not run as another identity");
    assert.ok(
      call.args.every((argument) => !argument.includes(ONEPASSWORD_SERVICE_TOKEN)),
      "the token must not be an argument of the CLI",
    );
  }
  // The name of the vault holds a space. It arrives as one argument, so no shell ran the CLI.
  const createCall = calls.find((call) => call.args[0] === "vault" && call.args[1] === "create");
  assert.ok(createCall, "the connector must create the shared vault");
  assert.equal(createCall.args[2], "Shared with OpenBot", "the name of the vault must be one argument");
  const serviceAccountCall = calls.find((call) => call.args[0] === "service-account");
  assert.ok(serviceAccountCall, "the connector must create the service account");
  assert.ok(serviceAccountCall.args.includes("--raw"), "the service account must be read as a token");
  assert.ok(
    serviceAccountCall.args.includes(`${state.vaultId}:read_items`),
    "the service account must read only the shared vault",
  );
  checks.push("the CLI runs without a shell, without the token, and as the user's own session");

  // The agents see the title and the username of a login, never its password.
  const logins = await runCauseEffect(connector.loginsFor("https://example.test"));
  results.onePasswordLogins = logins?.length.toString() ?? "none";
  assert.equal(logins?.length, 1, "the login of the site must be listed");
  assert.ok(!JSON.stringify(logins).includes(ONEPASSWORD_ITEM_PASSWORD), "the login must not hold the password");
  const secret = await runCauseEffect(connector.secretFor(logins?.[0]?.id ?? "", "https://example.test", "password"));
  assert.equal(secret, ONEPASSWORD_ITEM_PASSWORD, "the browser must get the password");
  checks.push("the login list holds no password and the browser gets the password");

  // A failure that names the token must not show it to the user or write it to the log.
  const failing = new OnePasswordConnectorService({
    store: new OnePasswordConnectorStore(join(root, "onepassword-failing", "connector.json"), fixtureCipher),
    hostName: "fixture-host",
    appVersion: "0.0.0-fixture",
    cliInstall: null,
    openExternal: async () => undefined,
    findCli: () => Effect.succeed([cliPath]),
    createClient: async () => {
      throw new Error(`1Password refused the service account token ${ONEPASSWORD_SERVICE_TOKEN}.`);
    },
  });
  const failed = await runCauseEffect(failing.connect({ accountId: null }));
  results.onePasswordFailure = failed.state;
  assert.equal(failed.state, "disconnected", "a failed connection must not be connected");
  assert.ok(failed.error, "a failed connection must name the failure");
  assert.ok(!failed.error.includes(ONEPASSWORD_SERVICE_TOKEN), "the failure must not show the token");
  assert.ok(failed.error.includes("[redacted]"), "the failure must hide the token");
  checks.push("a failure that names the token shows it to nobody");

  // Disconnect forgets the token file.
  await runCauseEffect(connector.disconnect());
  results.onePasswordAfterDisconnect = connector.status().state;
  assert.equal(connector.status().state, "disconnected", "the connection must be gone");
  await assert.rejects(stat(storePath), { code: "ENOENT" }, "the connection file must be gone");
  checks.push("Disconnect removes the connection file");

  // A pasted token is stored like a token that the CLI created.
  const pasted = await runCauseEffect(connector.connectWithToken(ONEPASSWORD_PASTED_TOKEN));
  results.onePasswordPasted = pasted.state;
  assert.equal(pasted.state, "connected", "a pasted token must connect");
  assert.equal(await modeOf(storePath), 0o600, "the connection file must be readable by the user only");
  const pastedFile = await readFile(storePath, "utf8");
  assert.ok(!pastedFile.includes(ONEPASSWORD_PASTED_TOKEN), "the connection file must not hold the token in clear");
  await runCauseEffect(connector.disconnect());
  delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
}

/** One request of the fake GitHub server. */
interface FakeGitHubRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: string;
}

/** The GitHub part: the device flow, the bot token renewal, and the git credential helper. */
async function runGitHub(root: string, checks: string[], results: Record<string, string>): Promise<void> {
  const requests: FakeGitHubRequest[] = [];
  const opened: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      requests.push({
        method: request.method ?? "GET",
        path,
        authorization: request.headers.authorization ?? null,
        body,
      });
      answerGitHub(response, path, body);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object", "the fake GitHub server must have a port");
  const origin = `http://127.0.0.1:${address.port}`;

  // Every request of the connector goes to the fake server, so the test reaches no network.
  const localFetch: GitHubFetch = async (url, init) => {
    const target = new URL(url);
    return fetch(`${origin}${target.pathname}${target.search}`, init);
  };

  const toolDirectory = join(root, "github", "tools");
  const storePath = join(root, "github", "connector.json");
  let clock = Date.now();
  const connector = new GitHubConnectorService({
    app: { clientId: GITHUB_CLIENT_ID, slug: "fixture-github-app" },
    store: new GitHubConnectorStore(storePath, fixtureCipher),
    toolDirectory,
    apiUrl: origin,
    openExternal: async (url) => {
      opened.push(url);
    },
    fetch: localFetch,
    now: () => clock,
  });
  cleanups.push(async () => {
    await runCauseEffect(connector.dispose()).catch(() => undefined);
    server.close();
  });
  await runCauseEffect(connector.load());

  // The device flow asks for a code and opens the page of the user.
  const started = await runCauseEffect(connector.connect(true));
  results.githubState = started.state;
  results.githubUserCode = started.userCode ?? "none";
  assert.equal(started.state, "pending", "the sign-in must wait for the user");
  assert.equal(started.userCode, GITHUB_USER_CODE, "the sign-in must show the code of GitHub");
  assert.equal(started.verificationUri, GITHUB_VERIFICATION_URI, "the sign-in must show the page of GitHub");
  await waitFor(() => opened.includes(GITHUB_VERIFICATION_URI), "the sign-in must open the page of GitHub");
  checks.push("the device flow asks for a code and opens the page of GitHub");

  // The fake server answers the token request, and the connection finishes.
  await waitFor(() => connector.status().state === "connected", "the GitHub sign-in must finish");
  results.githubLogin = connector.status().login ?? "none";
  assert.equal(connector.status().login, GITHUB_LOGIN, "the sign-in must show the account of the user");
  const deviceRequest = requests.find((request) => request.path === "/login/device/code");
  assert.ok(deviceRequest, "the connector must ask for a device code");
  assert.ok(deviceRequest.body.includes(GITHUB_CLIENT_ID), "the device code request must name the app");
  checks.push("the sign-in stores the account of the user");

  // The files of `gh` and `git` hold the token, and only the user can read them.
  const tokenFile = join(toolDirectory, "token");
  const hostsFile = join(toolDirectory, "gh", "hosts.yml");
  const repositoriesFile = join(toolDirectory, "repositories");
  results.githubTokenMode = (await modeOf(tokenFile)).toString(8);
  results.githubHostsMode = (await modeOf(hostsFile)).toString(8);
  assert.equal(await modeOf(tokenFile), 0o600, "the token file must be readable by the user only");
  assert.equal(await modeOf(hostsFile), 0o600, "the hosts file must be readable by the user only");
  assert.equal(await modeOf(join(toolDirectory, "gh")), 0o700, "the gh folder must be readable by the user only");
  assert.equal(await modeOf(toolDirectory), 0o700, "the tool folder must be readable by the user only");
  assert.equal(await readFile(tokenFile, "utf8"), GITHUB_ACCESS_TOKEN, "the token file must hold the user token");
  checks.push("the token files hold the token and only the user can read them");

  // The bot token of the repository is renewed and written for the git helper.
  await waitFor(
    async () => (await readFile(repositoriesFile, "utf8").catch(() => "")).includes(GITHUB_BOT_TOKEN),
    "the bot token must be written for the git helper",
  );
  results.githubRepositoriesMode = (await modeOf(repositoriesFile)).toString(8);
  assert.equal(await modeOf(repositoriesFile), 0o600, "the repositories file must be readable by the user only");
  assert.equal(
    await readFile(repositoriesFile, "utf8"),
    `${GITHUB_REPOSITORY}\t${GITHUB_BOT_TOKEN}\n`,
    "the repositories file must hold the bot token of the repository",
  );
  const botRequest = requests.find((request) => request.path === "/v1/github/installation-tokens");
  assert.ok(botRequest, "the connector must ask the OpenBot API for a bot token");
  assert.equal(
    botRequest.authorization,
    `Bearer ${GITHUB_ACCESS_TOKEN}`,
    "the OpenBot API must get the user token as its bearer",
  );
  checks.push("the bot token is renewed and written for the git helper");

  // The environment of the agents names the gh folder and the helper of git.
  const environment = connector.agentEnvironment({});
  results.githubConfigDir = environment.GH_CONFIG_DIR ?? "none";
  results.githubConfigCount = environment.GIT_CONFIG_COUNT ?? "none";
  assert.equal(environment.GH_CONFIG_DIR, join(toolDirectory, "gh"), "the gh folder must be the config folder");
  assert.equal(environment.GIT_CONFIG_COUNT, "3", "the helper of git must clear the helper of the user");
  assert.equal(environment.GIT_CONFIG_KEY_0, "credential.https://github.com.helper");
  assert.equal(environment.GIT_CONFIG_VALUE_0, "");
  assert.equal(environment.GIT_CONFIG_KEY_1, "credential.https://github.com.helper");
  assert.equal(environment.GIT_CONFIG_KEY_2, "credential.https://github.com.useHttpPath");
  assert.equal(environment.GIT_CONFIG_VALUE_2, "true");
  const helper = environment.GIT_CONFIG_VALUE_1 ?? "";
  assert.ok(helper.length > 0, "the helper of git must be set");
  assert.ok(
    !JSON.stringify(environment).includes(GITHUB_ACCESS_TOKEN),
    "the environment of the agents must hold no token",
  );
  const withBotToken = await runCredentialHelper(helper, `path=${GITHUB_REPOSITORY}.git`);
  const withUserToken = await runCredentialHelper(helper, "protocol=https\nhost=github.com");
  results.githubHelperBotToken = String(withBotToken.split("\n")[1]?.replace("password=", "") === GITHUB_BOT_TOKEN);
  results.githubHelperUserToken = String(
    withUserToken.split("\n")[1]?.replace("password=", "") === GITHUB_ACCESS_TOKEN,
  );
  assert.equal(
    withBotToken,
    `username=x-access-token\npassword=${GITHUB_BOT_TOKEN}\n`,
    "the helper must give the bot token",
  );
  assert.equal(
    withUserToken,
    `username=x-access-token\npassword=${GITHUB_ACCESS_TOKEN}\n`,
    "the helper must give the user token",
  );
  checks.push("the git credential helper gives the bot token of the repository and the user token elsewhere");

  // A token that is near its end is refreshed, and the files hold the new token.
  clock += 55 * 60_000;
  const refreshed = await runCauseEffect(connector.accessToken());
  await waitFor(
    async () => (await readFile(tokenFile, "utf8").catch(() => "")) === GITHUB_REFRESHED_ACCESS_TOKEN,
    "the refreshed token must reach the token file",
  );
  results.githubRefreshed = String(refreshed === GITHUB_REFRESHED_ACCESS_TOKEN);
  assert.equal(refreshed, GITHUB_REFRESHED_ACCESS_TOKEN, "the connector must give the refreshed token");
  assert.equal(await readFile(tokenFile, "utf8"), GITHUB_REFRESHED_ACCESS_TOKEN);
  assert.ok((await readFile(hostsFile, "utf8")).includes(GITHUB_REFRESHED_ACCESS_TOKEN));
  const refreshRequest = requests.find(
    (request) => request.path === "/login/oauth/access_token" && request.body.includes("grant_type=refresh_token"),
  );
  assert.ok(refreshRequest, "the connector must refresh the token");
  assert.ok(
    refreshRequest.body.includes(`refresh_token=${GITHUB_REFRESH_TOKEN}`),
    "the refresh must send the refresh token",
  );
  checks.push("a token that is near its end is refreshed and the files follow");

  // No request body holds a token, and every request that needs one names it in its header.
  for (const request of requests) {
    assert.ok(!request.body.includes(GITHUB_ACCESS_TOKEN), "a request body must not hold a token");
    assert.ok(!request.body.includes(GITHUB_BOT_TOKEN), "a request body must not hold a token");
  }
  const userRequest = requests.find((request) => request.path === "/user");
  assert.ok(userRequest, "the connector must read the account of the user");
  assert.equal(userRequest.authorization, `Bearer ${GITHUB_ACCESS_TOKEN}`);
  checks.push("the token reaches GitHub in its header only");

  // Disconnect removes the files of `gh` and `git`.
  await runCauseEffect(connector.disconnect(false));
  results.githubAfterDisconnect = connector.status().state;
  assert.equal(connector.status().state, "disconnected", "the connection must be gone");
  await assert.rejects(stat(toolDirectory), { code: "ENOENT" }, "the tool folder must be gone");
  assert.deepEqual(connector.agentEnvironment({}), {}, "the agents must not get the helper of git");
}

/** The fake GitHub server. It answers the device flow, the API, and the OpenBot API. */
function answerGitHub(response: ServerResponse, path: string, body: string): void {
  const json = (status: number, value: string): void => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(value);
  };
  if (path === "/login/device/code") {
    json(
      200,
      JSON.stringify({
        device_code: GITHUB_DEVICE_CODE,
        user_code: GITHUB_USER_CODE,
        verification_uri: GITHUB_VERIFICATION_URI,
        expires_in: 900,
        interval: 0,
      }),
    );
    return;
  }
  if (path === "/login/oauth/access_token") {
    const fields = new URLSearchParams(body);
    if (fields.get("grant_type") === "refresh_token") {
      if (fields.get("refresh_token") !== GITHUB_REFRESH_TOKEN) {
        json(200, JSON.stringify({ error: "bad_refresh_token" }));
        return;
      }
      json(
        200,
        JSON.stringify({
          access_token: GITHUB_REFRESHED_ACCESS_TOKEN,
          refresh_token: GITHUB_REFRESHED_REFRESH_TOKEN,
          expires_in: 3600,
          refresh_token_expires_in: 28_800,
        }),
      );
      return;
    }
    if (fields.get("device_code") !== GITHUB_DEVICE_CODE) {
      json(200, JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    json(
      200,
      JSON.stringify({
        access_token: GITHUB_ACCESS_TOKEN,
        refresh_token: GITHUB_REFRESH_TOKEN,
        expires_in: 3600,
        refresh_token_expires_in: 28_800,
      }),
    );
    return;
  }
  if (path === "/user") {
    json(200, JSON.stringify({ login: GITHUB_LOGIN, id: 4242, avatar_url: null }));
    return;
  }
  if (path === "/user/installations") {
    json(200, JSON.stringify({ installations: [{ id: 1 }] }));
    return;
  }
  if (path === "/user/installations/1/repositories") {
    json(200, JSON.stringify({ total_count: 1, repositories: [{ full_name: GITHUB_REPOSITORY, private: false }] }));
    return;
  }
  if (path === "/v1/github/installation-tokens") {
    json(
      200,
      JSON.stringify({
        installations: [
          {
            installationId: 1,
            account: "fixture-owner",
            token: GITHUB_BOT_TOKEN,
            expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            repositories: [GITHUB_REPOSITORY],
          },
        ],
      }),
    );
    return;
  }
  json(404, JSON.stringify({ message: "Not Found" }));
}

const checks: string[] = [];
const results: Record<string, string> = {};
const logLines: string[] = [];
const stopLog = teeLogLines(["onepassword-connector", "github-connector", "github-bot-tokens"], (line) =>
  logLines.push(line),
);
const root = await mkdtemp(join(tmpdir(), "openbot-connector-e2e-"));
let passed = false;
let error: string | undefined;
try {
  await mkdir(BIN, { recursive: true });
  await runOnePassword(root, checks, results);
  await runGitHub(root, checks, results);
  // The secrets reach no log line.
  assert.ok(logLines.length > 0, "the test must catch the log of the connectors");
  assert.ok(
    logLines.some((line) => line.includes("[redacted]")),
    "the log must hide the token that the failure named",
  );
  for (const secret of SECRETS) {
    assert.ok(!logLines.some((line) => line.includes(secret)), "the log must not hold a secret");
  }
  checks.push("no secret reaches a log line");
  passed = true;
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  stopLog();
  delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
  await rm(root, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const report = { passed, checks, results, logLines: passed ? logLines : [], error };
  // The secrets reach no report.
  if (SECRETS.some((secret) => JSON.stringify(report).includes(secret))) {
    report.passed = false;
    report.error = "the report holds a secret";
  }
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  // The first line of the failure names the check. The report holds the whole message.
  const reason = report.error?.split("\n")[0] ?? "";
  process.stdout.write(
    `${report.passed ? "PASS" : "FAIL"}${reason ? `: ${reason}` : ""}: report in ${join(OUT, "report.json")}\n`,
  );
  if (!report.passed) process.exitCode = 1;
}
