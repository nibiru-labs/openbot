import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentEvent, AgentWait, AgentWaitsSnapshot } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { z } from "zod";
import { ROUTINE_NO_UPDATE_TOOL } from "../agent/routine-quiet-runs";
import { type OpenBotToolResponse, openBotToolFailure, openBotToolResult } from "../agent/routine-tools";
import type { MailboxStore } from "../mailbox-store";
import type { DynamicToolCallParams } from "../protocol";
import { AgentWaitError, type AgentWaitStore } from "./agent-wait-store";

export const AWAIT_EVENT_TOOL = "await_event";
export const CLOSE_WAIT_TOOL = "close_wait";

export const awaitEventToolSchema = z.strictObject({
  note: z.string().trim().min(1).max(INPUT_LIMITS.agentWaitNote),
  routineId: z.string().trim().min(1).max(INPUT_LIMITS.identifier).optional(),
});

export const closeWaitToolSchema = z.strictObject({
  waitId: z.string().trim().min(1).max(INPUT_LIMITS.identifier),
});

export interface AgentWaitsHooks {
  emit(event: AgentEvent): void;
  /** Whether this agent owns this routine. */
  ownsRoutine(agentId: string, routineId: string): boolean;
  /** Whether this agent has a routine: only a routine run wakes a wait. */
  hasRoutine(agentId: string): boolean;
}

export interface AgentWaitsOptions {
  store: AgentWaitStore;
  mailbox: MailboxStore;
  hooks: AgentWaitsHooks;
}

/** Where a wait was opened, as the tool router knows it. */
export interface AgentWaitCaller {
  agentId: string;
  /** A channel or messaging turn: its messages are not in the agent's own chat. */
  inExecutionThread: boolean;
}

/**
 * Open waits: work an agent stopped because it waits for something outside the turn. The agent
 * opens and closes them with two tools; the user cancels them from the chat; a routine run of the
 * agent wakes them. The input of the run that wakes a wait repeats the request and the note, so
 * the agent can continue the request after its context lost it.
 *
 * It never imports the agent service facade.
 */
export class AgentWaits {
  readonly #store: AgentWaitStore;
  readonly #mailbox: MailboxStore;
  readonly #hooks: AgentWaitsHooks;

  constructor(options: AgentWaitsOptions) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#hooks = options.hooks;
  }

  list(agentId: string): AgentWaitsSnapshot {
    return { agentId, waits: this.#store.list(agentId) };
  }

  /** The user cancels a wait. A run that it woke and that has not started no longer names it. */
  cancel(agentId: string, waitId: string): void {
    if (!this.#store.delete(agentId, waitId)) throw new AgentWaitError(sourceText("error.backend.agentWaitGone"));
    this.#changed(agentId);
  }

  /**
   * Marks the waits that a routine run wakes, after its delivery is queued. A script event that
   * names a wait wakes only that wait. Any other run wakes every wait of its agent that has no
   * routine or has this routine. A wait whose last wake has not ended yet stays with that run.
   */
  wakeForRun(run: { agentId: string; routineId: string }, deliveryId: string, waitId: string | null): void {
    const named = waitId ? this.#store.get(run.agentId, waitId) : null;
    const candidates = waitId ? (named ? [named] : []) : this.#store.forRoutineRun(run.agentId, run.routineId);
    const woken = candidates
      .filter((wait) => !wait.wakeDeliveryId || !this.#isPending(wait.wakeDeliveryId))
      .map((wait) => wait.id);
    if (woken.length === 0) return;
    this.#store.markWoken(run.agentId, woken, deliveryId);
    this.#changed(run.agentId);
  }

  /** The waits that the run of this delivery continues, read when the run starts. */
  wokenBy(deliveryId: string): AgentWait[] {
    return this.#store.wokenBy(deliveryId);
  }

  /** Answers `await_event` and `close_wait`; null for every other tool. */
  handleTool(params: DynamicToolCallParams, caller: AgentWaitCaller): OpenBotToolResponse | null {
    if (params.tool !== AWAIT_EVENT_TOOL && params.tool !== CLOSE_WAIT_TOOL) return null;
    try {
      return params.tool === AWAIT_EVENT_TOOL ? this.#awaitEvent(params, caller) : this.#closeWait(params, caller);
    } catch (error) {
      if (error instanceof AgentWaitError) return openBotToolFailure(error.message);
      throw error;
    }
  }

  #awaitEvent(params: DynamicToolCallParams, caller: AgentWaitCaller): OpenBotToolResponse {
    const parsed = awaitEventToolSchema.safeParse(params.arguments);
    if (!parsed.success) return openBotToolFailure(sourceText("error.backend.agentWaitNoteRequired"));
    const { note, routineId } = parsed.data;
    if (caller.inExecutionThread) return openBotToolFailure(sourceText("error.backend.agentWaitOwnChatOnly"));
    const deliveries = this.#mailbox.findDeliveriesByTurn(caller.agentId, params.turnId);
    // A run that continues waits keeps them: leaving a wait open waits for the next run again.
    const continued = deliveries.flatMap((context) => this.#store.wokenBy(context.delivery.id));
    if (continued.length > 0)
      return openBotToolResult({
        waitIds: continued.map((wait) => wait.id),
        note: "This run continues these open waits. To wait again, leave them open and end your turn. Open a new wait only for a different request.",
      });
    // The user's message comes first; a routine run that waits serves its own instruction.
    const request =
      deliveries.findLast((context) => context.delivery.sender.kind === "user") ?? deliveries.at(0) ?? null;
    if (!request) return openBotToolFailure(sourceText("error.backend.agentWaitNoRequest"));
    if (routineId && !this.#hooks.ownsRoutine(caller.agentId, routineId))
      return openBotToolFailure(sourceText("error.backend.agentWaitRoutineGone"));
    if (!this.#hooks.hasRoutine(caller.agentId))
      return openBotToolFailure(sourceText("error.backend.agentWaitNoRoutine"));
    const wait = this.#store.open({
      agentId: caller.agentId,
      requestMessageId: request.delivery.id,
      requestText: request.delivery.text,
      note,
      routineId: routineId ?? null,
    });
    this.#changed(caller.agentId);
    return openBotToolResult({
      waitId: wait.id,
      wakes: wait.routineId
        ? `The next run of routine ${wait.routineId} wakes this wait, or a script event that names it.`
        : "The next run of any of your routines wakes this wait, or a script event that names it.",
      scriptEvent: `A local script names the wait with "waitId": "${wait.id}" next to "payload" in the body of its routine run request.`,
      next: "End your turn now. The run that wakes the wait repeats the request and your note. Close the wait with openbot.close_wait when the request is done.",
    });
  }

  #closeWait(params: DynamicToolCallParams, caller: AgentWaitCaller): OpenBotToolResponse {
    const parsed = closeWaitToolSchema.safeParse(params.arguments);
    if (!parsed.success || !this.#store.delete(caller.agentId, parsed.data.waitId))
      return openBotToolFailure(sourceText("error.backend.agentWaitGone"));
    this.#changed(caller.agentId);
    return openBotToolResult({ closed: parsed.data.waitId });
  }

  #isPending(deliveryId: string): boolean {
    const status = this.#mailbox.getDelivery(deliveryId)?.delivery.status;
    return status === "queued" || status === "starting" || status === "running";
  }

  #changed(agentId: string): void {
    this.#hooks.emit({ type: "waits-changed", snapshot: this.list(agentId) });
  }
}

/**
 * The age at which an open wait is stale. A routine run wakes a wait again and again, and an agent
 * that only waits again each time hides a blocked request from the user for hours.
 */
export const STALE_WAIT_MS = 2 * 60 * 60 * 1_000;

/** The part of a run's input that continues its woken waits. */
export function wokenWaitsPromptText(waits: readonly AgentWait[], now: Date = new Date()): string | null {
  if (waits.length === 0) return null;
  return [
    "--- open waits that this run wakes ---",
    `You opened these waits with openbot.${AWAIT_EVENT_TOOL}. Continue each request with what this run brings. When a request is done, or can no longer be done, tell the user and call openbot.${CLOSE_WAIT_TOOL} with its wait id. To wait for the next run again, leave the wait open.`,
    ...waits.flatMap((wait) => [
      "",
      `Wait ID: ${wait.id}`,
      `Opened: ${wait.createdAt}`,
      `Your note: ${wait.note}`,
      ...staleWaitLines(wait, now),
      "The request it continues:",
      wait.requestText,
    ]),
    "--- end of open waits ---",
  ].join("\n");
}

/** The report that a stale wait asks for. A wait with an unreadable open time is not stale. */
function staleWaitLines(wait: AgentWait, now: Date): string[] {
  const openedMs = Date.parse(wait.createdAt);
  if (!Number.isFinite(openedMs) || now.getTime() - openedMs < STALE_WAIT_MS) return [];
  const hours = Math.floor((now.getTime() - openedMs) / (60 * 60 * 1_000));
  return [
    `This wait is open for ${hours} hours. Do not only wait again. When this run brings no change for it, tell the user now what blocks it, who must act, and the one action that unblocks it. This report is required: do not call openbot.${ROUTINE_NO_UPDATE_TOOL} in this run.`,
  ];
}
