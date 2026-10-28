// Checks that provider exit-restart status messages come from the catalog, not English literals.
// `bun scripts/provider-restart-status-messages-e2e.ts`.
// Writes .openbot-build/provider-restart-status-messages-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { providerLabel } from "../src/backend/agent/thread-items";

const OUT = resolve(import.meta.dirname, "../.openbot-build/provider-restart-status-messages-e2e");
const SOURCE = resolve(import.meta.dirname, "../src/backend/agent/provider-runtime.ts");

interface Report {
  passed: boolean;
  stoppedRepeatedly?: string;
  restarting?: string;
}

const report: Report = { passed: false };

const text = await readFile(SOURCE, "utf8");
assert.ok(!text.includes("stopped repeatedly"), "provider-runtime must not hardcode the stopped-repeatedly sentence.");
assert.ok(!text.includes("Retrying ("), "provider-runtime must not hardcode the restarting retry sentence.");
assert.match(text, /sourceText\("error\.provider\.stoppedRepeatedly"/u);
assert.match(text, /sourceText\("error\.provider\.restarting"/u);

report.stoppedRepeatedly = sourceText("error.provider.stoppedRepeatedly", { provider: providerLabel("codex") });
report.restarting = sourceText("error.provider.restarting", {
  provider: providerLabel("codex"),
  attempt: "2",
});
const label = providerLabel("codex");
assert.ok(report.stoppedRepeatedly.includes(label));
assert.ok(report.restarting.includes(label));
assert.match(report.restarting, /2\/3/u);

report.passed = true;
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
