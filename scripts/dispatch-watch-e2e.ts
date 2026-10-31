// Exercises dispatch run watchers: unknown timeout, abort, restart resume, and terminal delivery.
// Run: bun scripts/dispatch-watch-e2e.ts. Report: .openbot-build/dispatch-watch-e2e.json.
process.env.OPENBOT_DISPATCH_WATCH_TEST = "1";

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { DispatchRecord } from "../src/backend/dispatch/dispatch-service";
import { isMissingFileError } from "../src/backend/file-errors";

const { DispatchService } = await import("../src/backend/dispatch/dispatch-service");

interface WatchReport {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: unknown }>;
  error?: string;
}

const out = resolve(import.meta.dirname, "../.openbot-build/dispatch-watch-e2e.json");
let tempRoot: string | null = null;
const report: WatchReport = { passed: false, checks: [] };
const check = (name: string, passed: boolean, detail?: unknown) => report.checks.push({ name, passed, detail });

const caller = {
  agentId: "agent-watch",
  threadId: "thread-watch",
  inExecutionThread: false,
  workspaceOnly: false,
  workspacePath: "",
  idempotencyKey: "",
};
const task = { title: "Watch E2E", card: "No file changes." };

async function pollCount(pollsPath: string): Promise<number> {
  try {
    return (await readFile(pollsPath, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch (error) {
    if (isMissingFileError(error)) return 0;
    throw error;
  }
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`${label} did not become true within ${timeoutMs}ms.`);
}

async function waitForStablePolls(pollsPath: string, idleMs = 400): Promise<number> {
  let last = await pollCount(pollsPath);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, idleMs));
    const next = await pollCount(pollsPath);
    if (next === last) return next;
    last = next;
  }
  throw new Error("Poll count did not stabilize.");
}

function stubSource(root: string): string {
  const rootLiteral = `'${root.replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh
set -eu
root=${rootLiteral}
polls="$root/polls.txt"
mode_file="$root/mode"
run_id=""
case "\${1-}" in
  run|lane)
    run_id="run-$$"
    printf '%s\\n' "$run_id" > "$root/active-run"
    printf '{"id":"%s"}\\n' "$run_id"
    ;;
  fleet)
    if [ "\${2-}" != "_run-info" ]; then exit 2; fi
    run_id="\${3-}"
    printf '%s\\n' "$run_id" >> "$polls"
    mode=$(cat "$mode_file" 2>/dev/null || printf running)
    case "$mode" in
      deliver)
        printf '{"id":"%s","state":"finished","result":{"status":"done","branch":"watch/e2e","commit":"c0ffee","result":{"summary":"watch ok"}}}\\n' "$run_id"
        ;;
      stop)
        printf '{"id":"%s","state":"finished","result":{"status":"stopped","branch":null,"commit":null,"result":{"summary":"stopped"}}}\\n' "$run_id"
        ;;
      *)
        printf '{"id":"%s","state":"running","result":null}\\n' "$run_id"
        ;;
    esac
    ;;
  stop)
    printf stop > "$mode_file"
    printf '{"ok":true,"id":"%s","state":"stopped"}\\n' "\${3-}"
    ;;
  *) exit 2 ;;
esac
`;
}

function makeService(
  root: string,
  binary: string,
  publish: (record: DispatchRecord, terminal: boolean) => Effect.Effect<void> = () => Effect.void,
) {
  caller.workspacePath = root;
  return new DispatchService({
    dataPath: root,
    settings: () => ({ binaryPath: binary, defaultHost: "local", defaultLane: "" }),
    redact: (text) => text,
    publish,
    failed: () => {
      throw new Error("A dispatch event could not be saved.");
    },
  });
}

async function readRuns(root: string): Promise<DispatchRecord[]> {
  const state: { runs: DispatchRecord[] } = JSON.parse(await readFile(join(root, "openbot-dispatch-v1.json"), "utf8"));
  return state.runs;
}

try {
  await mkdir(resolve(out, ".."), { recursive: true });
  tempRoot = await mkdtemp(resolve(out, "../dispatch-watch-"));
  const root = tempRoot;
  const binary = join(root, "openswarm");
  const pollsPath = join(root, "polls.txt");
  await writeFile(binary, stubSource(root), { mode: 0o700 });
  await writeFile(pollsPath, "");

  // Unknown: a run that never finishes is marked unknown and the watcher stops polling.
  {
    const service = makeService(root, binary);
    await Effect.runPromise(service.start());
    const { runId } = await Effect.runPromise(
      service.dispatch({ ...task, title: "Unknown run" }, { ...caller, idempotencyKey: "unknown-run" }),
    );
    await waitFor("unknown status", async () => {
      const record = (await readRuns(root)).find((run) => run.runId === runId);
      return record?.status === "unknown";
    });
    const unknown = (await readRuns(root)).find((run) => run.runId === runId);
    assert.equal(unknown?.summary, sourceText("status.agent.dispatchWatchExpired"));
    const pollsBeforeIdle = await waitForStablePolls(pollsPath);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    check("unknown run ends the watcher", (await pollCount(pollsPath)) === pollsBeforeIdle, {
      pollsBeforeIdle,
      pollsAfter: await pollCount(pollsPath),
    });
    await Effect.runPromise(service.dispose());
  }

  // Stop: abort resumes the watcher until the stopped result is delivered.
  await writeFile(pollsPath, "");
  await writeFile(join(root, "mode"), "running");
  {
    const delivered = Promise.withResolvers<void>();
    const service = makeService(root, binary, (record, terminal) =>
      terminal && record.status === "stopped" ? Effect.sync(() => delivered.resolve()) : Effect.void,
    );
    await Effect.runPromise(service.start());
    const { runId } = await Effect.runPromise(
      service.dispatch({ ...task, title: "Stop run" }, { ...caller, idempotencyKey: "stop-run" }),
    );
    await waitFor("running record", async () => (await readRuns(root)).some((run) => run.runId === runId));
    await Effect.runPromise(service.abort(runId, caller));
    await writeFile(join(root, "mode"), "stop");
    await waitFor("stopped delivery", async () => {
      const record = (await readRuns(root)).find((run) => run.runId === runId);
      return record?.delivered === true && record.status === "stopped";
    });
    await delivered.promise;
    const pollsBeforeIdle = await waitForStablePolls(pollsPath);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    check("stop ends the watcher after delivery", (await pollCount(pollsPath)) === pollsBeforeIdle);
    await Effect.runPromise(service.dispose());
  }

  // Restart: an undelivered running record is watched again and ends after delivery.
  await writeFile(pollsPath, "");
  await writeFile(join(root, "mode"), "deliver");
  const restartRunId = "run-restart";
  await writeFile(
    join(root, "openbot-dispatch-v1.json"),
    JSON.stringify({
      version: 1,
      runs: [
        {
          runId: restartRunId,
          host: "local",
          agentId: caller.agentId,
          threadId: caller.threadId,
          title: "Restart run",
          binary,
          idempotencyKey: "restart-run",
          status: "running",
          branch: null,
          commit: null,
          startedAt: new Date(0).toISOString(),
          delivered: false,
        },
      ],
    }),
  );
  {
    const service = makeService(root, binary);
    await Effect.runPromise(service.start());
    await waitFor("restart delivery", async () => {
      const record = (await readRuns(root)).find((run) => run.runId === restartRunId);
      return record?.delivered === true && record.status === "done";
    });
    const pollsBeforeIdle = await waitForStablePolls(pollsPath);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    check("restart delivery ends the watcher", (await pollCount(pollsPath)) === pollsBeforeIdle);
    await Effect.runPromise(service.dispose());
  }

  // Delivery: a normal terminal result ends the watcher without timing out.
  await writeFile(pollsPath, "");
  await writeFile(join(root, "mode"), "deliver");
  {
    const service = makeService(root, binary);
    await Effect.runPromise(service.start());
    const { runId } = await Effect.runPromise(
      service.dispatch({ ...task, title: "Deliver run" }, { ...caller, idempotencyKey: "deliver-run" }),
    );
    await waitFor("terminal delivery", async () => {
      const record = (await readRuns(root)).find((run) => run.runId === runId);
      return record?.delivered === true && record.status === "done";
    });
    const pollsBeforeIdle = await waitForStablePolls(pollsPath);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    check("delivery ends the watcher", (await pollCount(pollsPath)) === pollsBeforeIdle);
    await Effect.runPromise(service.dispose());
  }

  report.passed = report.checks.every((item) => item.passed);
} catch (error) {
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
} finally {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
