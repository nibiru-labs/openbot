// Run: bun scripts/mailbox-idempotency-e2e.ts
// Gates real attachment transfers and writes a report under .openbot-build.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { AttachmentFiles } from "../src/backend/attachment-files";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const out = resolve(import.meta.dirname, "../.openbot-build/mailbox-idempotency-e2e");
await mkdir(out, { recursive: true });
const root = await mkdtemp(join(out, "profile-"));
const sharedRoot = join(root, "shared");
const database = new OpenBotDatabase(root);
const files = new AttachmentFiles({ userDataPath: root, sharedRoot });
const transfer = files.commitMessageTransfer;
let releaseFirst = () => {};
let firstEntered = () => {};
let controlEntered = () => {};
const firstGate = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});
const firstReady = new Promise<void>((resolve) => {
  firstEntered = resolve;
});
const controlReady = new Promise<void>((resolve) => {
  controlEntered = resolve;
});
let calls = 0;
Object.defineProperty(files, "commitMessageTransfer", {
  value: (...args: Parameters<typeof transfer>) =>
    Effect.gen(function* () {
      calls += 1;
      if (calls === 1) {
        firstEntered();
        yield* Effect.promise(() => firstGate);
      } else if (args[2][0] === "control") {
        controlEntered();
      }
      return yield* transfer(...args);
    }),
});
const mailbox = new MailboxStore(root, sharedRoot, database, files);
let passed = false;
let error = "";
try {
  await runCauseEffect(mailbox.initialize());
  const source = join(root, "source.txt");
  await writeFile(source, "attachment");
  const input = {
    sender: { kind: "user" as const },
    recipientAgentIds: ["agent"],
    text: "hello",
    sourcePaths: [source],
    idempotencyKey: "same-key",
  };
  const first = runCauseEffect(mailbox.enqueue(input));
  await firstReady;
  const second = runCauseEffect(mailbox.enqueue(input));
  const control = runCauseEffect(
    mailbox.enqueue({ ...input, recipientAgentIds: ["control"], idempotencyKey: "other-key" }),
  );
  await controlReady;
  await control;
  releaseFirst();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.messageId, b.messageId, "same-key calls must return the same message");
  assert.deepEqual(a.deliveries, b.deliveries);
  assert.deepEqual(mailbox.receiptForKey("same-key"), a);
  assert.equal(
    database.connection.prepare("SELECT COUNT(*) AS count FROM projection_mailbox_messages").get()?.count,
    2,
  );
  assert.equal(database.connection.prepare("SELECT COUNT(*) AS count FROM projection_deliveries").get()?.count, 2);
  const retry = await runCauseEffect(mailbox.enqueue({ ...input, text: "", recipientAgentIds: [], sourcePaths: [] }));
  assert.deepEqual(retry, a);
  await assert.rejects(
    runCauseEffect(
      mailbox.enqueue({ ...input, idempotencyKey: "failed-key", sourcePaths: [join(root, "missing.txt")] }),
    ),
  );
  const recovered = await runCauseEffect(mailbox.enqueue({ ...input, idempotencyKey: "failed-key" }));
  assert.deepEqual(mailbox.receiptForKey("failed-key"), recovered);
  const [draft] = await runCauseEffect(
    mailbox.prepareImportedAttachments(
      [],
      [{ name: "draft.txt", mimeType: "text/plain", bytes: Buffer.from("draft") }],
    ),
  );
  assert.ok(draft);
  const draftInput = { ...input, sourcePaths: [], draftIds: [draft.id], idempotencyKey: "draft-key" };
  const [draftFirst, draftSecond] = await Promise.all([
    runCauseEffect(mailbox.enqueue(draftInput)),
    runCauseEffect(mailbox.enqueue(draftInput)),
  ]);
  assert.deepEqual(draftFirst, draftSecond);
  assert.equal(await readFile(join(sharedRoot, "Transfers", a.messageId, "source.txt"), "utf8"), "attachment");
  database.close();
  const reopenedDatabase = new OpenBotDatabase(root);
  const reopened = new MailboxStore(root, sharedRoot, reopenedDatabase);
  await runCauseEffect(reopened.initialize());
  assert.deepEqual(reopened.receiptForKey("same-key"), a);
  reopenedDatabase.close();
  passed = true;
} catch (cause) {
  error = String(cause);
  throw cause;
} finally {
  releaseFirst();
  database.close();
  await writeFile(join(out, "report.json"), `${JSON.stringify({ passed, transferCalls: calls, error }, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
