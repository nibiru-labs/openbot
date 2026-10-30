import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { AgentDatabaseSupervisor } from "../src/backend/agent-data/agent-database-supervisor";

const supervisor = new AgentDatabaseSupervisor({
  queueWaitMs: 100,
  statementDeadlineMs: 10_000,
  spawnHost: () => {
    const child = spawn("node", ["src/backend/agent-data/agent-database-host.ts"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    child.kill("SIGSTOP");
    return {
      send: (request) => child.stdin.write(`${JSON.stringify(request)}\n`),
      onResponse: () => {},
      onExit: (listener) => {
        child.on("exit", listener);
      },
      kill: () => {
        child.kill("SIGKILL");
      },
    };
  },
});
const request = { kind: "close" as const, databasePath: "/tmp/openbot-queue-e2e.db" };
try {
  const pending = Array.from({ length: 66 }, () => Effect.runPromise(supervisor.send(request)));
  const overflow = await pending[65];
  assert.equal(overflow?.ok, false);
  if (overflow?.ok === false) assert.equal(overflow.failure.kind, "busy");
  const expired = await Promise.all(pending.slice(1, 65));
  assert.ok(expired.every((item) => !item.ok && item.failure.kind === "busy"));
  supervisor.dispose();
  const first = await pending[0];
  assert.equal(first?.ok, false);
  await mkdir(".openbot-build", { recursive: true });
  await writeFile(
    ".openbot-build/database-queue-reliability.json",
    JSON.stringify({ overflow: true, expired: expired.length, stopped: true }, null, 2),
  );
} finally {
  supervisor.dispose();
}
