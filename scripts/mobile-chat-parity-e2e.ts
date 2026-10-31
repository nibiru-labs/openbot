// Mobile chat parity for UI blocks, in-chat search, stop and send, grouped messages, and routine cards.
// The script drives the real mobile model code without a device. It writes
// .openbot-build/mobile-chat-parity-e2e/report.json and exits non-zero on a failure.
//
// Run: bun scripts/mobile-chat-parity-e2e.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ConversationMessage } from "@openbot/contracts/ipc";
import { routineConversationEventItemType } from "@openbot/contracts/ipc";
import { UI_BLOCK_VERSION } from "@openbot/contracts/ui-blocks";
import { createOpenBotLogger } from "@openbot/logging";
import { chatRunAuthor, senderRuns } from "../apps/mobile/src/features/chat/model/chat-grouping";
import { projectChatMessages } from "../apps/mobile/src/features/chat/model/chat-messages";
import { chatSearchHighlightSegments, findChatSearchMatches } from "../apps/mobile/src/features/chat/model/chat-search";
import { canStopAndSend, stopAndSend } from "../apps/mobile/src/features/chat/model/stop-and-send";

const logger = createOpenBotLogger("mobile-chat-parity-e2e");
const OUT = resolve(import.meta.dirname, "../.openbot-build/mobile-chat-parity-e2e");

interface Step {
  name: string;
  passed: boolean;
  detail: string;
}

const steps: Step[] = [];

function check(name: string, passed: boolean, detail: string): void {
  steps.push({ name, passed, detail });
  if (passed) logger.info(`${name}: ${detail}`);
  else logger.error(`${name}: ${detail}`);
}

function uiBlockMessage(): ConversationMessage {
  return {
    id: "msg-ui-block",
    author: "assistant",
    text: "",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    turnId: "turn-1",
    questionPrompt: {
      requestId: "req-1",
      resolution: null,
      questions: [
        {
          id: "action",
          header: "Send",
          question: "Send the letter?",
          isSecret: false,
          options: [{ label: "Send", description: "Send the letter." }],
        },
      ],
    },
    uiBlock: {
      version: UI_BLOCK_VERSION,
      blockId: "block-1",
      spec: {
        type: "confirm",
        title: "Send this letter?",
        actions: [
          { id: "send", label: "Send", style: "primary" },
          { id: "cancel", label: "Cancel", style: "ghost" },
        ],
      },
      state: { status: "pending" },
    },
  };
}

/** The rows of a chat, as the grouping rule reads them. */
function row(id: string, author: string, createdAt?: string, drawsTime = true) {
  return { id, author, createdAt, drawsTime };
}

const AT = "2026-01-05T10:00:00.000Z";
const LATER = "2026-01-05T10:02:00.000Z";
const MUCH_LATER = "2026-01-05T10:06:00.000Z";

/** A system message of a routine the agent created. */
function routineEvent(routineId: string, name: string, action: "created" | "updated") {
  return {
    id: `message-${routineId}-${action}`,
    author: "system" as const,
    source: "system" as const,
    status: "completed" as const,
    itemType: routineConversationEventItemType(action, routineId),
    text: name,
    createdAt: AT,
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  // Finding 1: the interactive block stays in the projection as uiBlock, not only question fallback.
  {
    const projected = projectChatMessages([uiBlockMessage()]);
    const blockRow = projected.find((message) => message.id === "msg-ui-block");
    check("uiBlock projection keeps uiBlock kind", blockRow?.kind === "uiBlock", blockRow?.kind ?? "missing");
    check(
      "uiBlock projection keeps block spec",
      blockRow?.kind === "uiBlock" &&
        blockRow.block.spec.type === "confirm" &&
        blockRow.block.spec.title === "Send this letter?",
      blockRow?.kind === "uiBlock" ? blockRow.block.spec.type : "missing",
    );
  }

  // Finding 14: the open chat can search loaded bubbles and highlight matches in plain text.
  {
    const messages = projectChatMessages([
      {
        id: "a",
        author: "assistant",
        text: "Hello **world** of search",
        status: "completed",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "b",
        author: "user",
        text: "Another line about search terms",
        status: "completed",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    const matches = findChatSearchMatches(messages, "search");
    check("chat search finds loaded messages", matches.length >= 2, String(matches.length));
    check(
      "chat search returns message ids",
      matches.every((match) => match.messageId === "a" || match.messageId === "b"),
      matches.map((match) => match.messageId).join(","),
    );
    const segments = chatSearchHighlightSegments("Hello world of search", [{ start: 6, end: 11 }], {
      start: 6,
      end: 11,
    });
    check(
      "chat search highlight marks the current match",
      segments.some((segment) => segment.highlight && segment.current && segment.text === "world"),
      segments.map((segment) => segment.text).join("|"),
    );
  }

  // "Stop and send": the action shows while a turn runs and the composer holds a message.
  check(
    "The action shows while a turn runs and the composer holds a message",
    canStopAndSend({ running: true, hasDraft: true, disabled: false }),
    "a running turn and a message",
  );
  check(
    "The action waits for a turn",
    !canStopAndSend({ running: false, hasDraft: true, disabled: false }),
    "no turn runs",
  );
  check(
    "The action waits for a message",
    !canStopAndSend({ running: true, hasDraft: false, disabled: false }),
    "the composer is empty",
  );
  check(
    "The action waits for a chat that can send",
    !canStopAndSend({ running: true, hasDraft: true, disabled: true }),
    "the composer is disabled",
  );

  // The turn stops before the message goes, so the message runs after the old turn has stopped.
  const calls: string[] = [];
  await stopAndSend({
    stop: async () => {
      calls.push("stop");
    },
    send: (text: string) => {
      calls.push(`send:${text}`);
    },
    text: "the message that goes next",
  });
  check(
    "The turn stops before the message goes",
    calls.join(",") === "stop,send:the message that goes next",
    calls.join(","),
  );

  // A stop that fails sends nothing: the person keeps the text and reads the error.
  const failed: string[] = [];
  let failedSend = false;
  await stopAndSend({
    stop: async () => {
      failed.push("stop");
      throw new Error("The host did not stop the turn.");
    },
    send: () => {
      failedSend = true;
    },
    text: "the message that stays",
  }).catch(() => undefined);
  check(
    "A stop that fails sends nothing",
    failed.join(",") === "stop" && !failedSend,
    `${failed.join(",")}; sent: ${failedSend}`,
  );

  // The messages of one sender read as one run: the run carries one time at its top.
  const run = senderRuns([row("one", "agent", AT), row("two", "agent", LATER), row("three", "user", LATER)]);
  check(
    "A run of messages by one sender carries one time",
    run.has("two") && !run.has("one") && !run.has("three"),
    [...run].join(",") || "no run",
  );

  // Another sender opens a run.
  const otherSender = senderRuns([row("one", "agent", AT), row("two", "user", LATER)]);
  check("Another sender opens a run", !otherSender.has("two"), [...otherSender].join(",") || "no run");

  // A message that comes later opens a run: the time returned.
  const later = senderRuns([row("one", "agent", AT), row("two", "agent", MUCH_LATER)]);
  check("A message that comes later opens a run", !later.has("two"), [...later].join(",") || "no run");

  // A marker between two messages breaks the run: the run it interrupts cannot continue under it.
  const marker = senderRuns([row("one", "agent", AT), row("marker", "", undefined, false), row("two", "agent", LATER)]);
  check("A marker between two messages breaks the run", !marker.has("two"), [...marker].join(",") || "no run");

  // A message without a time opens a run: the reader cannot read it as a continuation.
  const untimed = senderRuns([row("one", "agent", AT), row("two", "agent")]);
  check("A message without a time opens a run", !untimed.has("two"), [...untimed].join(",") || "no run");

  // The first message of a chat always opens a run.
  const first = senderRuns([row("one", "agent", AT)]);
  check("The first message of a chat opens a run", !first.has("one"), [...first].join(",") || "no run");

  // The sender of a row: the reader, another member, or an agent.
  check(
    "The reader writes under its own name",
    chatRunAuthor({ kind: "message", author: "user" }) === "user",
    chatRunAuthor({ kind: "message", author: "user" }),
  );
  check(
    "Another member writes under its own name",
    chatRunAuthor({ kind: "message", author: "agent", sender: { id: "member-1" } }) === "member:member-1",
    chatRunAuthor({ kind: "message", author: "agent", sender: { id: "member-1" } }),
  );
  check(
    "An agent writes under its own name",
    chatRunAuthor({ kind: "message", author: "agent" }) === "agent" &&
      chatRunAuthor({ kind: "message", author: "agent", speaker: { id: "agent-1" } }) === "agent-1",
    `${chatRunAuthor({ kind: "message", author: "agent" })}; ${chatRunAuthor({
      kind: "message",
      author: "agent",
      speaker: { id: "agent-1" },
    })}`,
  );
  check("A marker has no sender", chatRunAuthor({ kind: "routine" }) === "", chatRunAuthor({ kind: "routine" }));
  const agentAndMember = senderRuns([
    { id: "one", author: chatRunAuthor({ kind: "message", author: "agent" }), createdAt: AT, drawsTime: true },
    {
      id: "two",
      author: chatRunAuthor({ kind: "message", author: "agent", sender: { id: "member-1" } }),
      createdAt: LATER,
      drawsTime: true,
    },
  ]);
  check(
    "A message of another member opens a run",
    !agentAndMember.has("two"),
    [...agentAndMember].join(",") || "no run",
  );

  // The routine of the chat keeps its id, so the chat can open the routine.
  const created = projectChatMessages([routineEvent("routine-1", "Morning brief", "created")], null, null);
  const routineMarker = created.find((message) => message.kind === "routine");
  check(
    "The routine of the chat keeps its id",
    routineMarker?.kind === "routine" &&
      routineMarker.routineId === "routine-1" &&
      routineMarker.routineName === "Morning brief" &&
      routineMarker.event === "created",
    routineMarker?.kind === "routine"
      ? `${routineMarker.routineId}: ${routineMarker.routineName} (${routineMarker.event})`
      : "no marker",
  );

  const updated = projectChatMessages([routineEvent("routine-2", "Evening brief", "updated")], null, null);
  const updatedMarker = updated.find((message) => message.kind === "routine");
  check(
    "A changed routine keeps its id",
    updatedMarker?.kind === "routine" &&
      updatedMarker.routineId === "routine-2" &&
      updatedMarker.routineName === "Evening brief" &&
      updatedMarker.event === "updated",
    updatedMarker?.kind === "routine"
      ? `${updatedMarker.routineId}: ${updatedMarker.routineName} (${updatedMarker.event})`
      : "no marker",
  );

  const report = {
    generatedAt: new Date().toISOString(),
    passed: steps.every((step) => step.passed),
    steps,
    unverified: [
      "The composer of the phone. The script drives the rule the composer reads, not the screen.",
      "The message list of the phone. The script drives the rule the list reads, not the rows it draws.",
      "The routine screen of the phone. The script checks that the chat keeps the id of the routine, not the screen it opens.",
    ],
  };
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  logger.info(`Checked ${steps.length} steps. Wrote ${join(OUT, "report.json")}.`);
  if (!report.passed) process.exitCode = 1;
}

await main();
