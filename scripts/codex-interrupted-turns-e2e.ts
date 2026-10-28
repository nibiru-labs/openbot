import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { CodexAppServerClient } from "../src/backend/app-server-client";

const root = await mkdtemp(join(tmpdir(), "openbot-interrupt-e2e-"));
const executable = join(root, "codex");
await writeFile(
  executable,
  `#!/usr/bin/env bun
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "probe") {
    if (message.params.complete) console.log(JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: message.params.turnId } } }));
    console.log(JSON.stringify({ id: "tool", method: "item/tool/call", params: { threadId: "thread", turnId: message.params.turnId } }));
  }
  console.log(JSON.stringify({ id: message.id, result: {} }));
}
`,
  { mode: 0o755 },
);
const client = new CodexAppServerClient(executable);
const signals: boolean[] = [];
client.on("request", (request) => signals.push(request.signal?.aborted ?? false));
try {
  client.start();
  const request = (method: string, params: { threadId?: string; turnId: string; complete?: boolean }) =>
    Effect.runPromise(client.request(method, params, (value) => value));
  for (let i = 0; i <= 1000; i++) await request("turn/interrupt", { threadId: "thread", turnId: String(i) });
  await request("probe", { turnId: "0" });
  await request("probe", { turnId: "1000" });
  await request("probe", { turnId: "999", complete: true });
  assert.deepEqual(signals, [false, true, false]);
  await mkdir(".openbot-build/codex-interrupted-turns-e2e", { recursive: true });
  await writeFile(
    ".openbot-build/codex-interrupted-turns-e2e/report.json",
    JSON.stringify({ status: "passed", signals }),
  );
  process.stdout.write(`${JSON.stringify({ status: "passed", signals })}\n`);
} finally {
  await Effect.runPromise(client.stop());
  await rm(root, { recursive: true, force: true });
}
