// Checks that a failed queued delivery stores a catalog reason, redacted detail, and that clients
// localize catalog text while legacy raw rows still read usefully.
// Run: bun scripts/queue-delivery-failure-e2e.ts
// Writes .openbot-build/queue-delivery-failure-e2e/report.json

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deliveryFailureMessage, encodeDeliveryFailure } from "@openbot/i18n";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const OUT = resolve(import.meta.dirname, "../.openbot-build/queue-delivery-failure-e2e");
const AGENT = "agent-failure-e2e";
const RAW = "provider refused request sk-SECRET123";
const LEGACY = "The primary source was not available.";

const report: { passed?: boolean; checks: string[]; delivery?: unknown; error?: string } = { checks: [] };

const root = await mkdtemp(join(tmpdir(), "openbot-queue-delivery-failure-"));
const profile = join(root, "profile");
const database = new OpenBotDatabase(profile);
try {
  const mailbox = new MailboxStore(profile, join(root, "shared"), database);
  await runCauseEffect(mailbox.initialize());

  const receipt = await runCauseEffect(
    mailbox.enqueue({ sender: { kind: "user" }, recipientAgentIds: [AGENT], text: "fail me" }),
  );
  const deliveryId = receipt.deliveries.find((candidate) => candidate.recipientAgentId === AGENT)?.id;
  assert.ok(deliveryId, "The send created a delivery.");

  await runCauseEffect(mailbox.markStarting(deliveryId));
  await runCauseEffect(mailbox.markTerminal(deliveryId, "failed", RAW));

  const delivery = mailbox.getDelivery(deliveryId)?.delivery;
  assert.ok(delivery, "The delivery is readable.");
  assert.equal(delivery.error, sourceText("error.backend.deliveryFailed"), "New failures store catalog text.");
  assert.ok(delivery.errorDetail?.includes("provider refused"), "Detail keeps redacted provider text.");
  assert.equal(delivery.errorDetail?.includes("SECRET123"), false, "Secrets are redacted in detail.");

  const localized = deliveryFailureMessage(delivery, (text) => `[localized:${text}]`);
  assert.equal(localized, `[localized:${delivery.error}]`, "Clients localize the catalog sentence.");

  const legacyDelivery = {
    id: "legacy",
    error: LEGACY,
    errorDetail: undefined,
    reference: undefined,
  } as const;
  assert.equal(
    deliveryFailureMessage(legacyDelivery, (text) => text),
    LEGACY,
    "Legacy raw rows still show their stored text.",
  );

  const encoded = encodeDeliveryFailure(sourceText("error.backend.turnNotStarted"));
  assert.equal(encoded?.error, sourceText("error.backend.turnNotStarted"), "Catalog input stays catalog.");
  assert.equal(encoded?.errorDetail, null, "Catalog-only failures keep no detail.");

  report.delivery = {
    status: delivery.status,
    error: delivery.error,
    errorDetail: delivery.errorDetail,
    reference: delivery.reference,
    localized,
  };
  report.checks.push("catalog failure stored with detail; legacy and catalog display paths verified");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(
  `${report.passed ? "PASS" : "FAIL"}: ${report.checks.length} checks. Report: ${join(OUT, "report.json")}\n`,
);
process.exit(report.passed ? 0 : 1);
