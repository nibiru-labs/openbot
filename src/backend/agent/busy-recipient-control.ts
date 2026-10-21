import { sourceText } from "@openbot/i18n/source";
import type { Logger } from "@openbot/logging";
import { Effect } from "effect";
import type { MailboxStore } from "../mailbox-store";
import type { BusyRecipientControl, BusyRecipientOutcome } from "./openbot-tool-router";

/** One sender does not stop the same teammate again within this time. */
export const INTERRUPT_COOLDOWN_MS = 60_000;
/** A teammate is stopped by others at most `INTERRUPT_LIMIT` times in this window. */
export const INTERRUPT_WINDOW_MS = 5 * 60_000;
export const INTERRUPT_LIMIT = 3;

export interface BusyRecipientControlHooks {
  /** The running turn of the agent's own chat, or null when it is idle. */
  activeTurnId(agentId: string): string | null;
  steer(agentId: string, deliveryId: string, turnId: string): Effect.Effect<void, unknown>;
  runNow(agentId: string, deliveryId: string): Effect.Effect<void, unknown>;
  agentName(agentId: string): string;
}

/**
 * `send_message` with `busy` set: one agent steers a teammate's running work, or stops it for a new
 * message. Any agent may do this for any teammate. Each use is logged with the sender, recipient,
 * mode and result, and interrupts are limited so agents cannot stop each other in a loop:
 *
 * - a cooldown for each sender and recipient pair;
 * - a limit on how often others stop one recipient in a window;
 * - no interrupt from a turn that itself started because a teammate interrupted the sender.
 *
 * A refused or failed request leaves the message queued, and the sender reads why.
 */
export class BusyRecipientControls {
  readonly #mailbox: MailboxStore;
  readonly #hooks: BusyRecipientControlHooks;
  readonly #logger: Logger;
  readonly #now: () => number;
  /** `sender\0recipient` -> the time of the last interrupt. */
  readonly #lastInterrupt = new Map<string, number>();
  /** recipient -> the times others interrupted it, newest last. */
  readonly #interruptsOf = new Map<string, number[]>();
  /** The deliveries that started a turn by an interrupt. A turn that runs one cannot interrupt. */
  readonly #interruptDeliveries = new Set<string>();

  constructor(options: {
    mailbox: MailboxStore;
    hooks: BusyRecipientControlHooks;
    logger: Logger;
    now?: () => number;
  }) {
    this.#mailbox = options.mailbox;
    this.#hooks = options.hooks;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  readonly control = Effect.fn("BusyRecipientControls.control")(function* (
    this: BusyRecipientControls,
    input: BusyRecipientControl,
  ) {
    const outcome = yield* input.mode === "steer" ? this.#steer(input) : this.#interrupt(input);
    // The audit record: who changed whose work, how, and what happened.
    this.#logger.info("Agent busy message control.", {
      sender: input.senderAgentId,
      senderName: this.#hooks.agentName(input.senderAgentId),
      recipient: input.recipientAgentId,
      recipientName: this.#hooks.agentName(input.recipientAgentId),
      deliveryId: input.deliveryId,
      mode: input.mode,
      result: outcome.result,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    });
    return outcome;
  });

  #steer(input: BusyRecipientControl): Effect.Effect<BusyRecipientOutcome> {
    const turnId = this.#hooks.activeTurnId(input.recipientAgentId);
    if (!turnId) return Effect.succeed({ agentId: input.recipientAgentId, result: "queued" });
    return this.#hooks.steer(input.recipientAgentId, input.deliveryId, turnId).pipe(
      Effect.as<BusyRecipientOutcome>({ agentId: input.recipientAgentId, result: "steered" }),
      Effect.catch((cause) => Effect.succeed(queued(input.recipientAgentId, failureText(cause)))),
    );
  }

  #interrupt(input: BusyRecipientControl): Effect.Effect<BusyRecipientOutcome> {
    return Effect.suspend(() => {
      const recipient = input.recipientAgentId;
      const turnId = this.#hooks.activeTurnId(recipient);
      if (!turnId) return Effect.succeed<BusyRecipientOutcome>({ agentId: recipient, result: "queued" });
      const refusal = this.#refusal(input);
      if (refusal) return Effect.succeed(queued(recipient, refusal));
      return this.#hooks.runNow(recipient, input.deliveryId).pipe(
        Effect.map((): BusyRecipientOutcome => {
          const now = this.#now();
          this.#lastInterrupt.set(pairKey(input.senderAgentId, recipient), now);
          this.#interruptsOf.set(recipient, [...this.#recentInterrupts(recipient), now]);
          this.#interruptDeliveries.add(input.deliveryId);
          return { agentId: recipient, result: "interrupted" };
        }),
        Effect.catch((cause) => Effect.succeed(queued(recipient, failureText(cause)))),
      );
    });
  }

  #refusal(input: BusyRecipientControl): string | null {
    const now = this.#now();
    const last = this.#lastInterrupt.get(pairKey(input.senderAgentId, input.recipientAgentId));
    if (last !== undefined && now - last < INTERRUPT_COOLDOWN_MS)
      return sourceText("error.backend.agentControlCooldown");
    if (this.#recentInterrupts(input.recipientAgentId).length >= INTERRUPT_LIMIT)
      return sourceText("error.backend.agentControlLimit");
    const started = this.#mailbox.findDeliveriesByTurn(input.senderAgentId, input.senderTurnId);
    if (started.some(({ delivery }) => this.#interruptDeliveries.has(delivery.id)))
      return sourceText("error.backend.agentControlChain");
    return null;
  }

  #recentInterrupts(agentId: string): number[] {
    const since = this.#now() - INTERRUPT_WINDOW_MS;
    return (this.#interruptsOf.get(agentId) ?? []).filter((time) => time > since);
  }
}

function pairKey(senderAgentId: string, recipientAgentId: string): string {
  return `${senderAgentId}\0${recipientAgentId}`;
}

function queued(agentId: string, reason: string): BusyRecipientOutcome {
  return { agentId, result: "queued", reason };
}

function failureText(cause: unknown): string {
  const inner = typeof cause === "object" && cause !== null && "cause" in cause ? cause.cause : cause;
  return inner instanceof Error ? inner.message : String(inner);
}
