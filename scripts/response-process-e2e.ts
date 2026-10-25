// Runs provider history through decoding, the real history importer and SQLite, then reopens it.
// Run with `node --import tsx scripts/response-process-e2e.ts` on Node 24 or newer.
// No account or provider is used. Writes .openbot-build/response-process-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { toThreadItem } from "../src/backend/agent/thread-items";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { decodeThreadResponse, type ThreadItem } from "../src/backend/protocol";
import type { ProviderHistoryFragment, ReadProviderHistory } from "../src/backend/provider-history";
import { importProviderHistory } from "../src/backend/provider-history-import";

const out = resolve(".openbot-build/response-process-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-process-e2e-"));
const home = join(root, "home");
const data = join(root, "data");
let database = new OpenBotDatabase(data);
const acceptance: Record<string, boolean> = {};
try {
  const store = new AgentStore(data, home, database);
  await runCauseEffect(store.initialize());
  const agent = await runCauseEffect(store.getOrCreate("process-agent", "Process check", "Process check"));
  const threadId = await runCauseEffect(store.ensureThreadId(agent.id));
  const payloads = [
    { id: "string-summary", summary: ["String summary"], content: ["Do not replace the summary"] },
    { id: "block-summary", summary: [{ type: "summary_text", text: "Block summary" }], encrypted_content: "opaque" },
    { id: "block-content", content: [{ type: "reasoning_text", text: "Readable content" }] },
    { id: "pi-text", text: "Pi process note", summary: [{ type: "summary_text", text: "Pi process note" }] },
    { id: "text-only", text: "Text-only process note" },
    { id: "encrypted-only", encrypted_content: "opaque" },
  ];
  const expected = ["String summary", "Block summary", "Readable content", "Pi process note", "Text-only process note"];
  // Both live notifications and saved history use the same readable content and classification.
  const live = payloads.map((value) => toThreadItem({ ...value, type: "reasoning" }));
  const decoded = decodeThreadResponse({
    thread: {
      id: "external-thread",
      turns: [
        {
          id: "history-turn",
          status: "completed",
          items: [
            ...payloads.map((value) => ({ ...value, type: "reasoning" })),
            { id: "answer", type: "agentMessage", text: "Final answer", phase: "final_answer" },
          ],
        },
      ],
    },
  });
  const turns = decoded.thread.turns;
  assert(turns?.[0]);
  const items: ThreadItem[] = turns[0].items ?? [];
  assert.deepEqual(
    live.flatMap((item) => (item?.text ? [item.text] : [])),
    expected,
  );
  assert.deepEqual(
    items.filter((item) => item.phase === "commentary").flatMap((item) => (item.text ? [item.text] : [])),
    expected,
  );
  acceptance.liveAndHistoryAgree = true;
  assert.equal(live.at(-1)?.text, undefined);
  acceptance.emptyReasoningItemHasNoReplacementText = true;
  const fragment: ProviderHistoryFragment = {
    turnId: "history-turn",
    status: "completed",
    startedAt: 1,
    itemOffset: 0,
    complete: true,
    items,
  };
  const readHistory: ReadProviderHistory = (_request, consume) =>
    Effect.gen(function* () {
      yield* consume(fragment);
    });
  const importHistory = () =>
    runCauseEffect(
      importProviderHistory({
        database,
        readHistory,
        sessionId: "process-session",
        provider: "codex",
        externalSessionId: "external-thread",
        agentId: agent.id,
        publicThreadId: threadId,
        findDelivery: () => null,
        findMessageDelivery: () => null,
        quietRoutineDelivery: () => false,
      }),
    );
  await importHistory();
  database.close();
  database = new OpenBotDatabase(data);
  await runCauseEffect(database.initialize());
  const stored = database.readConversation(agent.id, threadId).messages;
  assert.deepEqual(
    stored.filter((message) => message.itemType === "commentary").map((message) => message.text),
    expected,
  );
  assert.equal(stored.find((message) => message.id === "answer")?.text, "Final answer");
  acceptance.reopenedHistoryKeepsProcessAndAnswer = true;
  assert(!JSON.stringify(stored).includes("opaque"));
  acceptance.encryptedContentIsNotDisplayed = true;
  const repeat = await importHistory();
  assert.equal(repeat.messages, 0);
  acceptance.historyReimportDoesNotDuplicate = true;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "history.json"), `${JSON.stringify(stored, null, 2)}\n`);
  await writeFile(join(out, "report.json"), `${JSON.stringify({ passed: true, acceptance }, null, 2)}\n`);
  // Machine-readable: the E2E runner reports its artifact path.
  process.stdout.write(`${JSON.stringify({ passed: true, acceptance, out })}\n`);
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
}
