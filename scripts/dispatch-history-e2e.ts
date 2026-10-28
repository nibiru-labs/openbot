// Starts the dispatch service with an oversized history and checks the persisted result.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { DispatchService } from "../src/backend/dispatch/dispatch-service";

const output = resolve(import.meta.dirname, "../.openbot-build/dispatch-history-e2e.json");
await mkdir(resolve(output, ".."), { recursive: true });
const directory = await mkdtemp(resolve(import.meta.dirname, "../.openbot-build/dispatch-history-"));
const record = (index: number, delivered: boolean) => ({
  runId: `run-${index}`,
  host: "local",
  agentId: "agent",
  threadId: "thread",
  title: "title",
  binary: "unused",
  idempotencyKey: `key-${index}`,
  status: "done",
  branch: null,
  commit: null,
  startedAt: "2026-01-01T00:00:00Z",
  delivered,
});
const path = join(directory, "openbot-dispatch-v1.json");
await writeFile(
  path,
  JSON.stringify({ version: 1, runs: [...Array.from({ length: 105 }, (_, i) => record(i, true)), record(105, false)] }),
);
const service = new DispatchService({
  dataPath: directory,
  settings: () => {
    throw new Error("not used");
  },
  redact: (text) => text,
  publish: () => Effect.never,
  failed: () => {},
});
try {
  await Effect.runPromise(service.start());
  await Effect.runPromise(service.dispose());
  const state = JSON.parse(await readFile(path, "utf8"));
  assert.equal(state.runs.length, 101);
  assert.equal(state.runs[0].runId, "run-5");
  assert.equal(state.runs.at(-1).runId, "run-105");
  assert.equal(state.runs.at(-1).delivered, false);
  await writeFile(output, JSON.stringify({ passed: true, retainedDelivered: 100, retainedUndelivered: true }, null, 2));
} catch (error) {
  await writeFile(output, JSON.stringify({ passed: false, error: String(error) }, null, 2));
  throw error;
}
