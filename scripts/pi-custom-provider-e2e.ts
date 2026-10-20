// Runs a real Pi RPC process against a local OpenAI-compatible service. Uses a synthetic key only.
// Pass the verified Pi executable as argv[2]. Writes .openbot-build/pi-custom-provider-e2e/report.json.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { piCustomProviderEnv, piProviderKeyVariable } from "../src/backend/pi-provider-env";
import { PiRpc } from "../src/backend/pi-rpc";
import { confineSpawnTarget, piStatePaths, type SpawnTarget } from "../src/backend/process-confinement";

const executableArgument = process.argv[2];
assert(executableArgument, "Pass the verified Pi executable.");
const executable = resolve(executableArgument);
const scratch = resolve(import.meta.dirname, "../.openbot-build");
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, "pi-provider-"));
const agentDir = join(root, "pi-agent");
await mkdir(agentDir);
const key = "synthetic-pi-e2e-not-a-credential";
let authenticated = false;
let modelMatched = false;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  authenticated = request.headers.authorization === `Bearer ${key}`;
  modelMatched = JSON.parse(body).model === "pi-test-model";
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    [
      {
        id: "e2e",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "CONNECTED" }, finish_reason: null }],
      },
      {
        id: "e2e",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]
      .map((item) => `data: ${JSON.stringify(item)}\n\n`)
      .join(""),
  );
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
const models = {
  providers: {
    "openbot-e2e": {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: "openai-completions",
      apiKey: `$${piProviderKeyVariable("openbot-e2e")}`,
      models: [
        {
          id: "pi-test-model",
          name: "Pi endpoint check",
          input: ["text", "image"],
          reasoning: false,
          contextWindow: 32768,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
  },
};
assert(!JSON.stringify(models).includes(key));
await writeFile(join(agentDir, "models.json"), JSON.stringify(models));
await writeFile(join(agentDir, "auth.json"), "{}");
await writeFile(join(agentDir, "models-store.json"), "{}");
await writeFile(
  join(agentDir, "settings.json"),
  JSON.stringify({ defaultProvider: "openbot-e2e", defaultModel: "pi-test-model" }),
);
const rpc = new PiRpc((text) => text.replaceAll(key, "[REDACTED]"));
const report: {
  passed: boolean;
  authenticated: boolean;
  modelMatched: boolean;
  replyReceived: boolean;
  plaintextCredentialPersisted: boolean;
  sharedConfigurationProtected: boolean;
  error?: string;
} = {
  passed: false,
  authenticated: false,
  modelMatched: false,
  replyReceived: false,
  plaintextCredentialPersisted: false,
  sharedConfigurationProtected: false,
};
try {
  let finish: (() => void) | undefined;
  const ended = new Promise<void>((done) => {
    finish = done;
  });
  rpc.on("record", (record) => {
    if (record.type === "message_end" && JSON.stringify(record.message).includes("CONNECTED"))
      report.replyReceived = true;
    if (record.type === "agent_end") finish?.();
  });
  const diagnostics: string[] = [];
  rpc.on("diagnostic", (line) => diagnostics.push(line));
  const target: SpawnTarget = {
    command: executable,
    windowsVerbatimArguments: false,
    args: ["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-approve"],
  };
  const confined = process.argv.includes("--confined");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  rpc.start(
    confined
      ? confineSpawnTarget(
          target,
          { writableRoots: [join(root, "workspace")] },
          piStatePaths({ PI_CODING_AGENT_DIR: agentDir }),
        )
      : target,
    root,
    {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      ...piCustomProviderEnv(() => [
        {
          id: "openbot-e2e",
          name: "Synthetic provider",
          baseUrl: models.providers["openbot-e2e"].baseUrl,
          apiKey: key,
          headers: [],
          models: [{ id: "pi-test-model", name: "Pi endpoint check" }],
        },
      ]),
    },
  );
  await runCauseEffect(rpc.request({ type: "get_available_models" })).catch((error) => {
    throw new Error(`${String(error)} ${diagnostics.join(" ")}`);
  });
  await runCauseEffect(rpc.request({ type: "prompt", message: "Reply CONNECTED." }));
  const timeout = setTimeout(() => finish?.(), 20_000);
  await ended;
  clearTimeout(timeout);
  assert(report.replyReceived, "Pi did not finish the model call.");
  assert(authenticated && modelMatched, "The service did not receive the selected key and model.");
  report.authenticated = authenticated;
  report.modelMatched = modelMatched;
  report.plaintextCredentialPersisted =
    existsSync(join(agentDir, "auth.json")) && (await readFile(join(agentDir, "auth.json"), "utf8")).includes(key);
  assert(!report.plaintextCredentialPersisted);
  if (confined) {
    for (const name of ["auth.json", "models.json", "models-store.json", "settings.json", "trust.json"]) {
      const path = join(agentDir, name);
      const before = existsSync(path) ? await readFile(path, "utf8") : undefined;
      const target = confineSpawnTarget(
        {
          command: "/usr/bin/python3",
          args: ["-c", "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('CHANGED')", path],
          windowsVerbatimArguments: false,
        },
        { writableRoots: [join(root, "workspace")] },
        piStatePaths({ PI_CODING_AGENT_DIR: agentDir }),
      );
      const attempt = spawnSync(target.command, target.args, { encoding: "utf8" });
      assert.notEqual(attempt.status, 0, `The sandbox allowed a write to ${name}.`);
      assert.equal(existsSync(path) ? await readFile(path, "utf8") : undefined, before);
    }
    report.sharedConfigurationProtected = true;
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message.replaceAll(key, "[REDACTED]") : "Pi provider check failed.";
  process.exitCode = 1;
} finally {
  await runCauseEffect(rpc.stop());
  await new Promise<void>((done) => server.close(() => done()));
  const out = resolve(import.meta.dirname, "../.openbot-build/pi-custom-provider-e2e");
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(root, { recursive: true, force: true });
  // Machine-readable: the synthetic provider E2E report.
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
