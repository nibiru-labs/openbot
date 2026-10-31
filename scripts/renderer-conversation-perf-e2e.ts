// Measures conversation snapshot projection, timeline derivation, chat virtualizer
// fallback rows, and content-block cache reuse on synthetic workloads. Writes
// .openbot-build/renderer-conversation-perf/report.json.
//
// `bun scripts/renderer-conversation-perf-e2e.ts [--messages=1000] [--stream-steps=200]
//  [--runs=5] [--out=<folder>]`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AttachmentSummary, ConversationMessage } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import type { AgentMessage } from "@openbot/ui/data";
import { chatVirtualizerFallbackRowCount } from "../packages/ui/src/features/conversation/createChatVirtualizer";
import { smoothHeightResizeWouldProcess } from "../packages/ui/src/features/conversation/createSmoothHeightResize";
import {
  cachedMessageContentBlocks,
  resetCachedMessageContentBlocks,
} from "../packages/ui/src/features/conversation/message-content-blocks";
import {
  messageAttachmentsById,
  messageCitationsByNumber,
  richMessageParts,
} from "../packages/ui/src/features/conversation/rich-message-parts";
import {
  agentMessageNeedsReprojection,
  agentMessagesEqual,
  toAgentMessage,
  toAgentMessages,
} from "../src/renderer/src/app-message-projection";
import {
  computeTimelineMessages,
  deriveTimeline,
  resetTimelineDeriveCache,
} from "../src/renderer/src/features/conversation/timeline-derive";

const ROOT = resolve(import.meta.dirname, "..");
const logger = createOpenBotLogger("renderer-conversation-perf-e2e");

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const messageCount = Number(option("messages") ?? "1000");
const streamSteps = Number(option("stream-steps") ?? "200");
const runs = Number(option("runs") ?? "5");
const outName = option("out") ?? "renderer-conversation-perf";
assert.ok(Number.isInteger(messageCount) && messageCount >= 1);
assert.ok(Number.isInteger(streamSteps) && streamSteps >= 10);
assert.ok(Number.isInteger(runs) && runs >= 1);
assert.match(outName, /^\w[\w.-]*$/);
const OUT = resolve(ROOT, ".openbot-build", outName);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function bench(label: string, run: () => void, iterations: number): number {
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) run();
  const elapsed = performance.now() - start;
  logger.info(`${label}: ${Math.round(elapsed * 10) / 10} ms (${iterations} iteration(s))`);
  return elapsed;
}

function syntheticThread(count: number): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const user = index % 2 === 0;
    messages.push({
      id: `msg-${index}`,
      turnId: `turn-${Math.floor(index / 2)}`,
      author: user ? "user" : "assistant",
      text: user ? `Question ${index}: what is the answer?` : `Answer ${index}: here is a short reply.`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 12, index % 60)).toISOString(),
      status: "completed",
    });
  }
  return messages;
}

function syntheticAgentMessages(count: number): AgentMessage[] {
  const ownerAgentId = "agent-perf";
  return toAgentMessages(syntheticThread(count), ownerAgentId, (message) => toAgentMessage(message, ownerAgentId));
}

function snapshotProjectionMs(source: ConversationMessage[]): number {
  const ownerAgentId = "agent-perf";
  const stored = toAgentMessages(source, ownerAgentId, (message) => toAgentMessage(message, ownerAgentId));
  const storedById = new Map(stored.map((message) => [message.id, message]));
  return bench(
    "snapshot projection",
    () => {
      const mapped = toAgentMessages(source, ownerAgentId, (message) => {
        const existing = storedById.get(message.id);
        if (existing && !agentMessageNeedsReprojection(message, existing, ownerAgentId)) return existing;
        return toAgentMessage(message, ownerAgentId, existing);
      });
      for (const [index, message] of mapped.entries()) {
        const existing = stored[index];
        if (existing && !agentMessagesEqual(existing, message)) throw new Error("Projection changed a stored row.");
      }
    },
    1,
  );
}

function timelineInput(messages: AgentMessage[]) {
  const unreadBoundaryMessageId: string | null = null;
  return {
    drawnMessages: messages,
    storedMessages: messages,
    shownMessages: messages,
    openAgentMessages: new Set<string>(),
    openRoutineRuns: new Map<string, boolean>(),
    unreadBoundaryMessageId,
    compactionStartedAt: undefined,
  };
}

/** Full grouping passes on every step, as before finding 3. */
function timelineFullRebuildMs(messages: AgentMessage[], steps: number): number {
  return bench(
    "timeline full rebuild",
    () => {
      for (let step = 0; step < steps; step += 1) {
        const drawn = messages.map((message, index) =>
          index === messages.length - 1
            ? { ...message, body: `${message.body} token-${step}`, streaming: true }
            : message,
        );
        computeTimelineMessages({ ...timelineInput(drawn), drawnMessages: drawn });
      }
    },
    1,
  );
}

/** Cached derivation: structure key unchanged, only the last body grows. */
function timelineCachedPatchMs(messages: AgentMessage[], steps: number): number {
  return bench(
    "timeline cached patch",
    () => {
      resetTimelineDeriveCache();
      for (let step = 0; step < steps; step += 1) {
        const drawn = messages.map((message, index) =>
          index === messages.length - 1
            ? { ...message, body: `${message.body} token-${step}`, streaming: true }
            : message,
        );
        deriveTimeline({ ...timelineInput(drawn), drawnMessages: drawn });
      }
    },
    1,
  );
}

function contentBlockCacheMs(messages: AgentMessage[]): number {
  return bench(
    "content block cache reuse",
    () => {
      resetCachedMessageContentBlocks();
      for (const message of messages) cachedMessageContentBlocks(message.body, false);
      for (const message of messages) cachedMessageContentBlocks(message.body, false);
    },
    1,
  );
}

const SETTLED_MESSAGE_COUNT = 30;
const RESIZE_EVENTS_PER_MESSAGE = 100;
const MARKDOWN_PARAGRAPH_COUNT = 40;

function simulateLayoutRead(seed: number): number {
  let total = seed;
  for (let index = 0; index < 64; index += 1) total = (total * 1.0003 + index) % 9973;
  return total;
}

/** Before finding 4: every disabled resize callback still read layout. */
function smoothHeightDisabledResizeOldMs(): number {
  const enabled = () => false;
  return bench(
    "smooth height disabled resize (old)",
    () => {
      for (let message = 0; message < SETTLED_MESSAGE_COUNT; message += 1) {
        for (let event = 0; event < RESIZE_EVENTS_PER_MESSAGE; event += 1) {
          simulateLayoutRead(message + event);
          if (enabled() === false) continue;
        }
      }
    },
    1,
  );
}

/** After finding 4: disabled callbacks skip layout reads via smoothHeightResizeWouldProcess. */
function smoothHeightDisabledResizeNewMs(): number {
  const enabled = () => false;
  return bench(
    "smooth height disabled resize (new)",
    () => {
      for (let message = 0; message < SETTLED_MESSAGE_COUNT; message += 1) {
        for (let event = 0; event < RESIZE_EVENTS_PER_MESSAGE; event += 1) {
          if (!smoothHeightResizeWouldProcess(enabled)) continue;
          simulateLayoutRead(message + event);
        }
      }
    },
    1,
  );
}

function syntheticMarkdownParagraphs(count: number): string[] {
  const paragraphs: string[] = [];
  for (let index = 0; index < count; index += 1) {
    paragraphs.push(
      `Paragraph ${index}: see [source ${index}](https://example.com/doc/${index}) and cite [${(index % 5) + 1}].`,
    );
  }
  return paragraphs;
}

function syntheticCitations(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    label: `Source ${index + 1}`,
    url: `https://example.com/source/${index + 1}`,
    host: "example.com",
  }));
}

/** Before finding 12: each paragraph rebuilt citation and attachment maps. */
function richMessageMapsPerParagraphMs(paragraphs: string[]): number {
  const citations = syntheticCitations(5);
  const attachments: AttachmentSummary[] = [
    {
      id: "att-1",
      name: "notes.md",
      mimeType: "text/markdown",
      size: 120,
      kind: "file",
      previewKind: "text",
      previewUrl: null,
    },
  ];
  return bench(
    "rich message maps per paragraph (old)",
    () => {
      for (const paragraph of paragraphs) {
        const citationsByNumber = messageCitationsByNumber(citations);
        const attachmentsById = messageAttachmentsById(attachments);
        richMessageParts(paragraph, [], [], citationsByNumber, attachmentsById);
      }
    },
    1,
  );
}

type DraftRow = { text: string; attachments: unknown[]; replyToMessageId: string | null };
type QueueRow = { deliveries: Array<{ id: string; status: string }> };

/** Before finding 8: each draft write spreads the whole keyed record. */
function keyedDraftSpreadOldMs(agentCount: number, writes: number): number {
  let drafts: Record<string, DraftRow> = Object.fromEntries(
    Array.from({ length: agentCount }, (_, index) => [
      `agent-${index}`,
      { text: "", attachments: [], replyToMessageId: null },
    ]),
  );
  return bench(
    "keyed draft spread (old)",
    () => {
      for (let write = 0; write < writes; write += 1) {
        const key = `agent-${write % agentCount}`;
        drafts = {
          ...drafts,
          [key]: { ...(drafts[key] ?? { text: "", attachments: [], replyToMessageId: null }), text: `draft-${write}` },
        };
      }
    },
    1,
  );
}

/** After finding 8: each draft write patches one store row. */
function keyedDraftStoreNewMs(agentCount: number, writes: number): number {
  const drafts: Record<string, DraftRow> = Object.fromEntries(
    Array.from({ length: agentCount }, (_, index) => [
      `agent-${index}`,
      { text: "", attachments: [], replyToMessageId: null },
    ]),
  );
  return bench(
    "keyed draft store patch (new)",
    () => {
      for (let write = 0; write < writes; write += 1) {
        const key = `agent-${write % agentCount}`;
        const current = drafts[key] ?? { text: "", attachments: [], replyToMessageId: null };
        drafts[key] = { ...current, text: `draft-${write}` };
      }
    },
    1,
  );
}

/** Before finding 9: each queue write spreads the whole keyed record. */
function keyedQueueSpreadOldMs(agentCount: number, writes: number): number {
  let queues: Record<string, QueueRow> = Object.fromEntries(
    Array.from({ length: agentCount }, (_, index) => [`agent-${index}`, { deliveries: [] }]),
  );
  return bench(
    "keyed queue spread (old)",
    () => {
      for (let write = 0; write < writes; write += 1) {
        const key = `agent-${write % agentCount}`;
        queues = {
          ...queues,
          [key]: { deliveries: [{ id: `delivery-${write}`, status: "queued" }] },
        };
      }
    },
    1,
  );
}

/** After finding 9: each queue write patches one agent row. */
function keyedQueueStoreNewMs(agentCount: number, writes: number): number {
  const agentRows: Record<string, { queue?: QueueRow }> = Object.fromEntries(
    Array.from({ length: agentCount }, (_, index) => [`agent-${index}`, { queue: { deliveries: [] } }]),
  );
  return bench(
    "keyed queue store patch (new)",
    () => {
      for (let write = 0; write < writes; write += 1) {
        const key = `agent-${write % agentCount}`;
        if (!agentRows[key]) agentRows[key] = {};
        agentRows[key].queue = { deliveries: [{ id: `delivery-${write}`, status: "queued" }] };
      }
    },
    1,
  );
}

/** Before finding 9: agent-list changes load every agent queue eagerly. */
function queueBulkLoadCount(agentCount: number, listChanges: number) {
  let requests = 0;
  for (let change = 0; change < listChanges; change += 1) {
    for (let index = 0; index < agentCount; index += 1) requests += 1;
  }
  logger.info(`queue bulk load on list change (old): ${requests} request(s)`);
  return requests;
}

/** After finding 9: only the open agent queue loads until a row is read. */
function queueLazyLoadCount(agentCount: number, listChanges: number, readersPerChange: number) {
  let requests = 0;
  const loaded = new Set<string>();
  for (let change = 0; change < listChanges; change += 1) {
    for (let reader = 0; reader < readersPerChange; reader += 1) {
      const agentId = `agent-${reader % agentCount}`;
      if (loaded.has(agentId)) continue;
      loaded.add(agentId);
      requests += 1;
    }
  }
  logger.info(`queue lazy load on read (new): ${requests} request(s)`);
  return requests;
}

/** After finding 12: maps are built once per message and shared across paragraphs. */
function richMessageMapsSharedMs(paragraphs: string[]): number {
  const citations = syntheticCitations(5);
  const attachments: AttachmentSummary[] = [
    {
      id: "att-1",
      name: "notes.md",
      mimeType: "text/markdown",
      size: 120,
      kind: "file",
      previewKind: "text",
      previewUrl: null,
    },
  ];
  return bench(
    "rich message maps shared (new)",
    () => {
      const citationsByNumber = messageCitationsByNumber(citations);
      const attachmentsById = messageAttachmentsById(attachments);
      for (const paragraph of paragraphs) {
        richMessageParts(paragraph, [], [], citationsByNumber, attachmentsById);
      }
    },
    1,
  );
}

const snapshotSamples: number[] = [];
const timelineFullSamples: number[] = [];
const timelineCachedSamples: number[] = [];
const contentBlockCacheSamples: number[] = [];
const smoothHeightOldSamples: number[] = [];
const smoothHeightNewSamples: number[] = [];
const richMessageOldSamples: number[] = [];
const richMessageNewSamples: number[] = [];
const keyedDraftSpreadOldSamples: number[] = [];
const keyedDraftStoreNewSamples: number[] = [];
const keyedQueueSpreadOldSamples: number[] = [];
const keyedQueueStoreNewSamples: number[] = [];
const queueBulkLoadOldSamples: number[] = [];
const queueLazyLoadNewSamples: number[] = [];

const KEYED_RECORD_AGENT_COUNT = 50;
const source = syntheticThread(messageCount);
const agentMessages = syntheticAgentMessages(Math.min(messageCount, 120));
const virtualChatRows = chatVirtualizerFallbackRowCount(60);
const markdownParagraphs = syntheticMarkdownParagraphs(MARKDOWN_PARAGRAPH_COUNT);

for (let run = 0; run < runs; run += 1) {
  snapshotSamples.push(snapshotProjectionMs(source));
  timelineFullSamples.push(timelineFullRebuildMs(agentMessages, streamSteps));
  timelineCachedSamples.push(timelineCachedPatchMs(agentMessages, streamSteps));
  contentBlockCacheSamples.push(contentBlockCacheMs(agentMessages));
  smoothHeightOldSamples.push(smoothHeightDisabledResizeOldMs());
  smoothHeightNewSamples.push(smoothHeightDisabledResizeNewMs());
  richMessageOldSamples.push(richMessageMapsPerParagraphMs(markdownParagraphs));
  richMessageNewSamples.push(richMessageMapsSharedMs(markdownParagraphs));
  keyedDraftSpreadOldSamples.push(keyedDraftSpreadOldMs(KEYED_RECORD_AGENT_COUNT, 200));
  keyedDraftStoreNewSamples.push(keyedDraftStoreNewMs(KEYED_RECORD_AGENT_COUNT, 200));
  keyedQueueSpreadOldSamples.push(keyedQueueSpreadOldMs(KEYED_RECORD_AGENT_COUNT, 200));
  keyedQueueStoreNewSamples.push(keyedQueueStoreNewMs(KEYED_RECORD_AGENT_COUNT, 200));
  queueBulkLoadOldSamples.push(queueBulkLoadCount(KEYED_RECORD_AGENT_COUNT, 5));
  queueLazyLoadNewSamples.push(queueLazyLoadCount(KEYED_RECORD_AGENT_COUNT, 5, 3));
}

const snapshotMedian = median(snapshotSamples);
const timelineFullMedian = median(timelineFullSamples);
const timelineCachedMedian = median(timelineCachedSamples);
const contentBlockCacheMedian = median(contentBlockCacheSamples);
const smoothHeightOldMedian = median(smoothHeightOldSamples);
const smoothHeightNewMedian = median(smoothHeightNewSamples);
const richMessageOldMedian = median(richMessageOldSamples);
const richMessageNewMedian = median(richMessageNewSamples);
const keyedDraftSpreadOldMedian = median(keyedDraftSpreadOldSamples);
const keyedDraftStoreNewMedian = median(keyedDraftStoreNewSamples);
const keyedQueueSpreadOldMedian = median(keyedQueueSpreadOldSamples);
const keyedQueueStoreNewMedian = median(keyedQueueStoreNewSamples);
const queueBulkLoadOldMedian = median(queueBulkLoadOldSamples);
const queueLazyLoadNewMedian = median(queueLazyLoadNewSamples);
const timelinePatchSpeedup =
  timelineCachedMedian > 0 ? Math.round((timelineFullMedian / timelineCachedMedian) * 100) / 100 : null;
const smoothHeightDisabledSpeedup =
  smoothHeightNewMedian > 0 ? Math.round((smoothHeightOldMedian / smoothHeightNewMedian) * 100) / 100 : null;
const richMessageMapSpeedup =
  richMessageNewMedian > 0 ? Math.round((richMessageOldMedian / richMessageNewMedian) * 100) / 100 : null;
const keyedDraftStoreSpeedup =
  keyedDraftStoreNewMedian > 0 ? Math.round((keyedDraftSpreadOldMedian / keyedDraftStoreNewMedian) * 100) / 100 : null;
const keyedQueueStoreSpeedup =
  keyedQueueStoreNewMedian > 0 ? Math.round((keyedQueueSpreadOldMedian / keyedQueueStoreNewMedian) * 100) / 100 : null;
const queueLazyLoadSpeedup =
  queueLazyLoadNewMedian > 0 ? Math.round((queueBulkLoadOldMedian / queueLazyLoadNewMedian) * 100) / 100 : null;

const report = {
  label: outName,
  createdAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  parameters: { messageCount, streamSteps, runs },
  metrics: {
    snapshotProjectionMs: { median: snapshotMedian, samples: snapshotSamples },
    timelineFullRebuildMs: { median: timelineFullMedian, samples: timelineFullSamples },
    timelineCachedPatchMs: { median: timelineCachedMedian, samples: timelineCachedSamples },
    timelinePatchSpeedup,
    chatVirtualizerFallbackRowsAt60: virtualChatRows,
    contentBlockCacheReuseMs: { median: contentBlockCacheMedian, samples: contentBlockCacheSamples },
    smoothHeightDisabledResizeOldMs: { median: smoothHeightOldMedian, samples: smoothHeightOldSamples },
    smoothHeightDisabledResizeNewMs: { median: smoothHeightNewMedian, samples: smoothHeightNewSamples },
    smoothHeightDisabledSpeedup,
    richMessageMapsPerParagraphMs: { median: richMessageOldMedian, samples: richMessageOldSamples },
    richMessageMapsSharedMs: { median: richMessageNewMedian, samples: richMessageNewSamples },
    richMessageMapSpeedup,
    keyedDraftSpreadOldMs: { median: keyedDraftSpreadOldMedian, samples: keyedDraftSpreadOldSamples },
    keyedDraftStoreNewMs: { median: keyedDraftStoreNewMedian, samples: keyedDraftStoreNewSamples },
    keyedDraftStoreSpeedup,
    keyedQueueSpreadOldMs: { median: keyedQueueSpreadOldMedian, samples: keyedQueueSpreadOldSamples },
    keyedQueueStoreNewMs: { median: keyedQueueStoreNewMedian, samples: keyedQueueStoreNewSamples },
    keyedQueueStoreSpeedup,
    queueBulkLoadOldCount: { median: queueBulkLoadOldMedian, samples: queueBulkLoadOldSamples },
    queueLazyLoadNewCount: { median: queueLazyLoadNewMedian, samples: queueLazyLoadNewSamples },
    queueLazyLoadSpeedup,
  },
  notes: [
    "snapshotProjectionMs applies a full synthetic thread twice with reuse; lower is better.",
    "timelinePatchSpeedup is full/cached median timeline derivation time during streaming; higher is better.",
    "chatVirtualizerFallbackRowsAt60 is the row count drawn for a 60-message chat before measurement; lower is better.",
    "contentBlockCacheReuseMs parses each synthetic row twice; lower is better.",
    "smoothHeightDisabledSpeedup is old/new median time for settled-message resize callbacks; higher is better.",
    "richMessageMapSpeedup is per-paragraph vs shared map build time over 40 paragraphs; higher is better.",
    "keyedDraftStoreSpeedup is spread vs store patch time for 200 draft writes across 50 agents; higher is better.",
    "keyedQueueStoreSpeedup is spread vs store patch time for 200 queue writes across 50 agents; higher is better.",
    "queueLazyLoadSpeedup is bulk vs lazy queue request counts for five list changes (50 agents, three readers per change); higher is better.",
  ],
};

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
logger.info(`Wrote ${resolve(OUT, "report.json")}`);
