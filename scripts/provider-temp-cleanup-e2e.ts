import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithProviderTemp } from "../src/backend/provider-temp";

const root = await mkdtemp(join(tmpdir(), "openbot-provider-temp-e2e-"));
try {
  const { child, removed } = spawnWithProviderTemp(
    { root, provider: "fixture", availableDiskBytes: () => Number.MAX_SAFE_INTEGER },
    (env) => spawn(process.execPath, ["-e", "process.stdin.resume()"], { env: { ...process.env, ...env } }),
  );
  const [directory] = await readdir(root);
  assert(directory);
  await writeFile(join(root, directory, "unpacked"), "fixture");
  child.stdin.end();
  await removed;
  assert.deepEqual(await readdir(root), []);
  await mkdir(".openbot-build/provider-temp-cleanup-e2e", { recursive: true });
  await writeFile(".openbot-build/provider-temp-cleanup-e2e/report.json", JSON.stringify({ status: "passed" }));
  process.stdout.write('{"status":"passed"}\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
