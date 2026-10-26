import { createHash } from "node:crypto";
import type { ConversationMessage } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";
import { Effect } from "effect";
import type { ConversationRuntime } from "../agent/conversation-runtime";
import type { DrainScheduler } from "../agent/drain-scheduler";
import type { MailboxSync } from "../agent/mailbox-sync";
import type { AgentStore } from "../agent-store";
import type { MailboxStore } from "../mailbox-store";
import { DispatchFailed } from "./dispatch-process";
import type { DispatchRecord } from "./dispatch-service";

export interface DispatchDeliveryOptions {
  store: AgentStore;
  mailbox: MailboxStore;
  conversation: ConversationRuntime;
  mailboxSync: MailboxSync;
  drain: DrainScheduler;
  redact(text: string): string;
}

/** Redacts the exact mailbox payload at the send boundary. */
export function dispatchResultMailboxText(record: DispatchRecord, redact: (text: string) => string): string {
  return redact(
    redactText(
      JSON.stringify({
        runId: record.runId,
        host: record.host,
        status: record.status,
        branch: record.branch,
        commit: record.commit,
        summary: record.summary,
        verify: record.verify,
      }),
    ),
  );
}

/** Owns dispatch status messages and idempotent result delivery into the original chat. */
export class DispatchDelivery {
  readonly #options: DispatchDeliveryOptions;
  constructor(options: DispatchDeliveryOptions) {
    this.#options = options;
  }

  readonly publish = Effect.fn("DispatchDelivery.publish")(function* (
    this: DispatchDelivery,
    record: DispatchRecord,
    terminal: boolean,
  ) {
    const { store, mailbox, conversation, mailboxSync, drain } = this.#options;
    const agent = store.list().find((entry) => entry.id === record.agentId);
    // Removed agents must not be recreated by a late result.
    if (!agent) return;
    yield* Effect.try({
      try: () => {
        conversation.registerExecutionThread(record.agentId, record.threadId);
        const snapshot = structuredClone(conversation.ensureSnapshot(record.agentId, record.threadId));
        const key = createHash("sha256").update(`${record.host}:${record.runId}`).digest("hex").slice(0, 32);
        const id = `dispatch-${key}-${terminal ? "result" : "started"}`;
        if (snapshot.messages.some((message) => message.id === id)) return;
        const message: ConversationMessage = {
          id,
          author: "system",
          source: "system",
          status: "completed",
          itemType: "dispatch",
          createdAt: new Date().toISOString(),
          text: terminal
            ? sourceText("status.agent.dispatchFinished", {
                title: record.title,
                host: record.host,
                status: record.status,
              })
            : sourceText("status.agent.dispatchStarted", {
                title: record.title,
                host: record.host,
                runId: record.runId,
              }),
        };
        snapshot.messages.push(message);
        snapshot.revision = store.database.persistConversationChanges({
          agentId: record.agentId,
          threadId: record.threadId,
          activeTurnId: snapshot.activeTurnId,
          changedMessages: [message],
          eventType: "dispatch.updated",
          detail: { runId: record.runId, host: record.host, status: record.status },
        });
        conversation.setSnapshot(record.agentId, snapshot);
        conversation.publishConversation(snapshot);
      },
      catch: (cause) => new DispatchFailed({ cause }),
    });
    if (!terminal) return;
    yield* mailbox
      .enqueue({
        sender: { kind: "user" },
        dispatch: { runId: record.runId, host: record.host, threadId: record.threadId },
        recipientAgentIds: [record.agentId],
        text: dispatchResultMailboxText(record, this.#options.redact),
        draftIds: [],
        replyToMessageId: null,
        idempotencyKey: `dispatch:${record.host}:${record.runId}`,
      })
      .pipe(Effect.mapError((failure) => new DispatchFailed({ cause: failure.cause })));
    mailboxSync.emitQueue(record.agentId);
    drain.scheduleDrain(record.agentId);
  }, Effect.uninterruptible);
}
