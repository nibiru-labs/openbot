import { randomUUID } from "node:crypto";
import { sortConversationMessages } from "@openbot/contracts/conversation-order";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentApproval,
  AgentApprovalPermissions,
  ConversationMessage,
  HostedSiteConversationEventAction,
  HostedSiteConversationEventDetails,
  HostedSiteConversationEventStatus,
  HostedSiteList,
  HostedSiteSummary,
  PublishHostedSiteInput,
} from "@openbot/contracts/ipc";
import { hostedSiteConversationEventItemType, hostedSiteConversationEventText } from "@openbot/contracts/ipc";
import { isBoolean } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result, Schema } from "effect";
import type { AgentClient } from "../agent-client";
import type { AgentStore } from "../agent-store";
import { causeHelpers } from "../effect-boundary";
import type { PendingHostedSiteTerminalEvent } from "../openbot-database";
import { type AppServerRequest, type DynamicToolCallParams, isRecord, type RequestId } from "../protocol";
import type { ConversationRuntime } from "./conversation-runtime";
import {
  type HostedSiteMutationTool,
  hostedSiteAction,
  hostedSiteEventCommandId,
  hostedSiteEventDetails,
  hostedSiteEventMessageId,
  hostedSiteTool,
} from "./hosted-site-events";
import { type OpenBotToolResponse, openBotToolResult, siteToolString } from "./routine-tools";

/** The openbot.site host, injected so the backend never depends on the account Worker directly. */
export interface AgentHostedSites {
  list(): Effect.Effect<HostedSiteList, HostedSiteOperationFailed>;
  publish(
    input: PublishHostedSiteInput,
    allowedRoots: readonly string[],
  ): Effect.Effect<HostedSiteSummary, HostedSiteOperationFailed>;
  replace(
    input: PublishHostedSiteInput & { siteId: string },
    allowedRoots: readonly string[],
  ): Effect.Effect<HostedSiteSummary, HostedSiteOperationFailed>;
  delete(siteId: string): Effect.Effect<void, HostedSiteOperationFailed>;
}

/**
 * Carried on the pending approval record rather than in a map keyed by request id: request ids come
 * from the provider process and are reused across client restarts, so a second map could hand a
 * stale mutation to an unrelated approval. The approval record is already the thing every cleanup
 * path drops.
 */
export interface HostedSiteMutationContext {
  agentId: string;
  operationId: string;
  action: HostedSiteConversationEventAction;
  params: DynamicToolCallParams;
  eventDetails: HostedSiteConversationEventDetails;
}

export interface HostedSiteApprovalTarget {
  client: AgentClient;
  id: RequestId;
  agentId: string;
}

export interface HostedSiteCoordinatorOptions {
  store: AgentStore;
  conversation: ConversationRuntime;
  hostedSites: AgentHostedSites | null;
  emitError(code: string, error: unknown, agentId?: string): void;
  isStopping(): boolean;
}

interface HostedSiteApprovalDetails {
  reason: string;
  permissions: AgentApprovalPermissions;
  eventDetails: HostedSiteConversationEventDetails;
}

interface HostedSiteMutationResult {
  response: OpenBotToolResponse;
  eventDetails: HostedSiteConversationEventDetails;
}

export const HOSTED_SITE_APPROVAL_METHOD = "openbot/hosted-site-mutation";

/** The first retry of a pending marker waits a second; every later one waits twice as long. */
const TERMINAL_RETRY_BASE_DELAY_MS = 1_000;
/** The longest a retry of a pending marker waits. */
const TERMINAL_RETRY_MAX_DELAY_MS = 60_000;
/** How often a pending marker is written before OpenBot leaves it for the next start. */
const TERMINAL_RETRY_MAX_ATTEMPTS = 5;

/** How a pending marker waits for the database to take it again. */
interface TerminalRetry {
  /** The writes that failed. */
  attempts: number;
  /** When the marker may be written again. */
  nextAt: number;
  /** The failure is reported once, so the renderer does not get it again for every attempt. */
  reported: boolean;
}

/** The wait before the next write of a pending marker: a second, then twice as long. */
function terminalRetryDelay(attempts: number): number {
  return Math.min(TERMINAL_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), TERMINAL_RETRY_MAX_DELAY_MS);
}

/**
 * Owns publishing to openbot.site: the approval a mutation needs, the mutation itself, and the
 * conversation markers that record it.
 *
 * The markers are the reason this is a class rather than a set of functions. A terminal marker
 * ("succeeded", "failed", "cancelled", "interrupted") is written to SQLite *before* the provider is
 * answered, so a crash between the two leaves a durable pending event that `restore()` replays; the
 * provider response rides along as the `deliver` callback and only fires once the marker is durable.
 */
export class HostedSiteCoordinator {
  readonly #store: AgentStore;
  readonly #conversation: ConversationRuntime;
  readonly #hostedSites: AgentHostedSites | null;
  readonly #emitError: (code: string, error: unknown, agentId?: string) => void;
  readonly #isStopping: () => boolean;
  readonly #pendingTerminalEvents = new Map<string, PendingHostedSiteTerminalEvent>();
  readonly #pendingTerminalDeliveries = new Map<string, () => void>();
  /** How each pending marker waits for its next write, so a broken database is not written to every second. */
  readonly #terminalRetries = new Map<string, TerminalRetry>();
  #terminalRetryTimer: NodeJS.Timeout | null = null;

  constructor(options: HostedSiteCoordinatorOptions) {
    this.#store = options.store;
    this.#conversation = options.conversation;
    this.#hostedSites = options.hostedSites;
    this.#emitError = options.emitError;
    this.#isStopping = options.isStopping;
  }

  /** Replays markers left behind by a crash, then closes out mutations that never terminated. */
  restore(): void {
    this.#restorePendingTerminalEvents();
    this.#reconcileEventsAfterRestart();
  }

  listSites(): Effect.Effect<HostedSiteList, HostedSiteOperationFailed> {
    return this.#requireHostedSites().list();
  }

  readonly prepareApproval = Effect.fn("HostedSiteCoordinator.prepareApproval")(function* (
    this: HostedSiteCoordinator,
    client: AgentClient,
    request: AppServerRequest,
    params: DynamicToolCallParams,
    tool: HostedSiteMutationTool,
  ) {
    const threadId = params.threadId;
    const turnId = params.turnId;
    const agentId = this.#conversation.agentForThread(threadId);
    if (!turnId || !agentId) {
      client.respondError(request.id, {
        code: -32602,
        message: "OpenBot could not identify this hosted site request.",
      });
      return null;
    }
    const details = yield* this.#approvalDetailsEffect(params, tool);
    const mutation: HostedSiteMutationContext = {
      agentId,
      operationId: randomUUID(),
      action: hostedSiteAction(tool),
      params,
      eventDetails: details.eventDetails,
    };
    const approval: AgentApproval = {
      requestId: request.id,
      agentId,
      threadId: this.#conversation.publicThreadId(agentId, threadId),
      turnId,
      kind: "permissions",
      command: null,
      cwd: null,
      reason: details.reason,
      grantRoot: null,
      permissions: details.permissions,
    };
    return { approval, mutation };
  });

  /**
   * Runs an approved mutation, or records the decline. Never throws: every failure becomes a
   * terminal marker plus an error event, because the provider is still waiting on a response.
   */

  readonly resolveApproval = Effect.fn("HostedSiteCoordinator.resolveApproval")(function* (
    this: HostedSiteCoordinator,
    mutation: HostedSiteMutationContext,
    target: HostedSiteApprovalTarget,
    decision: "accept" | "decline",
  ) {
    if (decision === "decline") {
      this.#recordTerminalEvent(mutation, "cancelled", mutation.eventDetails, () => {
        target.client.respondError(target.id, {
          code: -32001,
          message: "The user declined this hosted site change.",
        });
      });
      return;
    }
    try {
      this.#recordEvent(mutation, "running", mutation.eventDetails);
    } catch (error) {
      try {
        target.client.respondError(target.id, {
          code: -32603,
          message: "The hosted site change could not be recorded.",
        });
      } catch (responseError) {
        this.#emitError("server_response_failed", responseError, target.agentId);
      }
      this.#emitError("hosted_site_marker_persistence_failed", error, target.agentId);
      return;
    }
    const result = yield* Effect.result(this.#executeMutationEffect(mutation));
    if (Result.isFailure(result)) {
      const error = result.failure.cause;
      this.#recordTerminalEvent(mutation, "failed", mutation.eventDetails, () => {
        target.client.respondError(target.id, { code: -32603, message: String(error) });
      });
      this.#emitError("server_request_failed", error, target.agentId);
    }
    if (Result.isSuccess(result)) {
      const succeeded = result.success;
      this.#recordTerminalEvent(mutation, "succeeded", succeeded.eventDetails, () => {
        target.client.respond(target.id, succeeded.response);
      });
    }
  }, Effect.uninterruptible);

  forgetAgent(agentId: string): void {
    for (const [key, event] of this.#pendingTerminalEvents) {
      if (event.agentId !== agentId) continue;
      this.#pendingTerminalEvents.delete(key);
      this.#pendingTerminalDeliveries.delete(key);
      this.#terminalRetries.delete(key);
    }
    if (this.#pendingTerminalEvents.size === 0 && this.#terminalRetryTimer) {
      clearTimeout(this.#terminalRetryTimer);
      this.#terminalRetryTimer = null;
    }
  }

  dispose(): void {
    if (this.#terminalRetryTimer) clearTimeout(this.#terminalRetryTimer);
    this.#terminalRetryTimer = null;
    this.#pendingTerminalEvents.clear();
    this.#pendingTerminalDeliveries.clear();
    this.#terminalRetries.clear();
  }

  #requireHostedSites(): AgentHostedSites {
    if (!this.#hostedSites) throw new Error(sourceText("error.site.hostingUnavailable"));
    return this.#hostedSites;
  }

  readonly #approvalDetailsEffect = Effect.fn("HostedSiteCoordinator.approvalDetails")(function* (
    this: HostedSiteCoordinator,
    params: DynamicToolCallParams,
    tool: HostedSiteMutationTool,
  ): Effect.fn.Return<HostedSiteApprovalDetails, HostedSiteOperationFailed> {
    const args = yield* siteStep(() => {
      const value = params.arguments;
      if (!isRecord(value)) throw new Error("Hosted site arguments are required.");
      return value;
    });
    if (tool === "delete_site") {
      const siteId = yield* siteStep(() => siteToolString(args.siteId, "siteId", INPUT_LIMITS.identifier));
      const site = yield* this.#ownedSiteEffect(siteId);
      return {
        reason: `Delete ${site.hostname} from openbot.site.`,
        permissions: { fileSystem: { read: [], write: [] }, network: true },
        eventDetails: hostedSiteEventDetails(site, siteId),
      };
    }

    const sourcePath = yield* siteStep(() => siteToolString(args.sourcePath, "sourcePath", INPUT_LIMITS.path));
    const title = yield* siteStep(() => siteToolString(args.title, "title", 120));
    yield* siteStep(() => siteToolString(args.description, "description", 500));
    if (args.spaFallback !== undefined && !isBoolean(args.spaFallback)) {
      return yield* new HostedSiteOperationFailed({ cause: new Error("spaFallback must be a boolean.") });
    }
    const permissions = { fileSystem: { read: [sourcePath], write: [] }, network: true };
    if (tool === "publish_site") {
      return {
        reason: `Publish ${JSON.stringify(title)} as a public site on openbot.site.`,
        permissions,
        eventDetails: { siteId: null, title, hostname: null, url: null },
      };
    }
    const siteId = yield* siteStep(() => siteToolString(args.siteId, "siteId", INPUT_LIMITS.identifier));
    const site = yield* this.#ownedSiteEffect(siteId);
    return {
      reason: `Replace ${site.hostname} with ${JSON.stringify(title)}.`,
      permissions,
      eventDetails: { ...hostedSiteEventDetails(site, siteId), title },
    };
  });

  readonly #ownedSiteEffect = Effect.fn("HostedSiteCoordinator.ownedSite")(function* (
    this: HostedSiteCoordinator,
    siteId: string,
  ) {
    const host = yield* siteStep(() => this.#requireHostedSites());
    const { sites } = yield* host.list();
    for (const site of sites) if (site.id === siteId) return site;
    return yield* new HostedSiteOperationFailed({ cause: new Error(sourceText("error.site.hostedSiteNotFound")) });
  });

  readonly #executeMutationEffect = Effect.fn("HostedSiteCoordinator.executeMutation")(function* (
    this: HostedSiteCoordinator,
    context: HostedSiteMutationContext,
  ): Effect.fn.Return<HostedSiteMutationResult, HostedSiteOperationFailed> {
    const { params } = context;
    const args = yield* siteStep(() => {
      const value = params.arguments;
      if (!isRecord(value)) throw new Error("Hosted site arguments are required.");
      return value;
    });
    if (context.action === "delete") {
      const siteId = yield* siteStep(() => siteToolString(args.siteId, "siteId", INPUT_LIMITS.identifier));
      const host = yield* siteStep(() => this.#requireHostedSites());
      yield* host.delete(siteId);
      return { response: openBotToolResult({ deleted: true, siteId }), eventDetails: context.eventDetails };
    }

    const sourcePath = yield* siteStep(() => siteToolString(args.sourcePath, "sourcePath", INPUT_LIMITS.path));
    const title = yield* siteStep(() => siteToolString(args.title, "title", 120));
    const description = yield* siteStep(() => siteToolString(args.description, "description", 500));
    if (args.spaFallback !== undefined && !isBoolean(args.spaFallback)) {
      return yield* new HostedSiteOperationFailed({ cause: new Error("spaFallback must be a boolean.") });
    }
    const agent = yield* siteStep(() => this.#conversation.requireKnownAgent(context.agentId));
    const input = {
      sourcePath,
      title,
      description,
      ...(isBoolean(args.spaFallback) ? { spaFallback: args.spaFallback } : {}),
    };
    const roots = [agent.workspacePath, this.#store.sharedRoot];
    const siteId =
      context.action === "publish"
        ? undefined
        : yield* siteStep(() => siteToolString(args.siteId, "siteId", INPUT_LIMITS.identifier));
    const host = yield* siteStep(() => this.#requireHostedSites());
    const site = siteId ? yield* host.replace({ ...input, siteId }, roots) : yield* host.publish(input, roots);
    return { response: openBotToolResult(site), eventDetails: hostedSiteEventDetails(site, siteId) };
  });

  #recordEvent(
    context: HostedSiteMutationContext,
    status: HostedSiteConversationEventStatus,
    details: HostedSiteConversationEventDetails,
    createdAt = new Date().toISOString(),
  ): void {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.#appendEvent(context, status, details, createdAt);
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }

  #tryRecordEvent(
    context: HostedSiteMutationContext,
    status: HostedSiteConversationEventStatus,
    details: HostedSiteConversationEventDetails,
    createdAt?: string,
  ): { written: boolean; failure: unknown } {
    try {
      this.#recordEvent(context, status, details, createdAt);
      return { written: true, failure: null };
    } catch (error) {
      return { written: false, failure: error };
    }
  }

  #recordTerminalEvent(
    context: HostedSiteMutationContext,
    status: Exclude<HostedSiteConversationEventStatus, "running">,
    details: HostedSiteConversationEventDetails,
    deliver?: () => void,
  ): void {
    const event: PendingHostedSiteTerminalEvent = {
      agentId: context.agentId,
      threadId: this.#store.ensureThreadIdNow(context.agentId),
      turnId: context.params.turnId,
      operationId: context.operationId,
      action: context.action,
      status,
      details,
      markerCommandId: hostedSiteEventCommandId(context.agentId, context.operationId, status),
      createdAt: new Date().toISOString(),
    };
    hostedSiteConversationEventItemType(event.action, event.status, event.operationId);
    hostedSiteConversationEventText(event.details);
    this.#pendingTerminalEvents.set(event.markerCommandId, event);
    if (deliver) this.#pendingTerminalDeliveries.set(event.markerCommandId, deliver);
    this.#flushPendingTerminalEvents();
  }

  #restorePendingTerminalEvents(): void {
    for (const event of this.#store.database.pendingHostedSiteTerminalEvents()) {
      this.#pendingTerminalEvents.set(event.markerCommandId, event);
    }
    this.#flushPendingTerminalEvents();
  }

  #flushPendingTerminalEvents(): void {
    const now = Date.now();
    for (const [key, event] of this.#pendingTerminalEvents) {
      const retry = this.#terminalRetries.get(key);
      // The marker ran out of attempts: its row stays in the database, and the next start writes it.
      if (retry && retry.attempts >= TERMINAL_RETRY_MAX_ATTEMPTS) continue;
      // The marker waits for its backoff, so one failure does not write to the database every second.
      if (retry && retry.nextAt > now) continue;
      let failure: unknown = null;
      let durable = false;
      try {
        this.#store.database.recordPendingHostedSiteTerminalEvent(event);
        durable = true;
      } catch (error) {
        failure = error;
      }
      const context: HostedSiteMutationContext = {
        agentId: event.agentId,
        operationId: event.operationId,
        action: event.action,
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          callId: event.operationId,
          namespace: "openbot",
          tool: hostedSiteTool(event.action),
          arguments: {},
        },
        eventDetails: event.details,
      };
      const written = this.#tryRecordEvent(context, event.status, event.details, event.createdAt);
      if (written.written) {
        this.#pendingTerminalEvents.delete(key);
        this.#terminalRetries.delete(key);
        durable = true;
      } else if (failure === null) {
        failure = written.failure;
      }
      if (!written.written) {
        // The marker is not in the conversation yet: the retry waits for its backoff.
        this.#noteTerminalFailure(key, failure, event.agentId);
      } else if (failure !== null) {
        // The row of the pending event did not reach the database; the marker is written all the same.
        this.#emitError("hosted_site_marker_persistence_failed", failure, event.agentId);
      }
      if (durable) {
        const deliver = this.#pendingTerminalDeliveries.get(key);
        this.#pendingTerminalDeliveries.delete(key);
        if (deliver) {
          try {
            deliver();
          } catch (error) {
            this.#emitError("server_response_failed", error, event.agentId);
          }
        }
      }
    }
    this.#scheduleTerminalRetry();
  }

  /**
   * Counts a write that failed and waits for the backoff. The failure is reported once, not on
   * every attempt, and the attempts are capped: the row stays in the database and the next start
   * writes the marker.
   */
  #noteTerminalFailure(key: string, failure: unknown, agentId: string): void {
    const retry = this.#terminalRetries.get(key) ?? { attempts: 0, nextAt: 0, reported: false };
    retry.attempts += 1;
    retry.nextAt = Date.now() + terminalRetryDelay(retry.attempts);
    this.#terminalRetries.set(key, retry);
    if (!retry.reported) {
      retry.reported = true;
      this.#emitError("hosted_site_marker_persistence_failed", failure, agentId);
      return;
    }
    if (retry.attempts >= TERMINAL_RETRY_MAX_ATTEMPTS) {
      this.#emitError("hosted_site_marker_retry_exhausted", failure, agentId);
    }
  }

  #scheduleTerminalRetry(): void {
    if (this.#terminalRetryTimer || this.#isStopping()) return;
    const now = Date.now();
    let nextAt = Number.POSITIVE_INFINITY;
    for (const key of this.#pendingTerminalEvents.keys()) {
      const retry = this.#terminalRetries.get(key);
      if (retry && retry.attempts >= TERMINAL_RETRY_MAX_ATTEMPTS) continue;
      nextAt = Math.min(nextAt, retry ? retry.nextAt : 0);
    }
    // Every pending marker ran out of attempts: the next start writes them.
    if (!Number.isFinite(nextAt)) return;
    this.#terminalRetryTimer = setTimeout(
      () => {
        this.#terminalRetryTimer = null;
        this.#flushPendingTerminalEvents();
      },
      Math.max(0, nextAt - now),
    );
    this.#terminalRetryTimer.unref?.();
  }

  #appendEvent(
    context: HostedSiteMutationContext,
    status: HostedSiteConversationEventStatus,
    details: HostedSiteConversationEventDetails,
    createdAt: string,
  ): void {
    const database = this.#store.database;
    this.#conversation.withConversationTransaction(context.agentId, ({ threadId, snapshot: current }) => {
      const messageId = hostedSiteEventMessageId(context.operationId, status);
      if (!current.messages.some((message) => message.id === messageId)) {
        const message: ConversationMessage = {
          id: messageId,
          turnId: context.params.turnId,
          author: "system",
          source: "system",
          text: hostedSiteConversationEventText(details),
          createdAt,
          status: "completed",
          itemType: hostedSiteConversationEventItemType(context.action, status, context.operationId),
        };
        current.messages.push(message);
        sortConversationMessages(current.messages);
        current.revision = database.appendConversationMessage({
          agentId: context.agentId,
          threadId,
          activeTurnId: current.activeTurnId,
          message,
          eventType: `hosted-site.${context.action}-${status}`,
          commandId: hostedSiteEventCommandId(context.agentId, context.operationId, status),
          detail: { action: context.action, status, operationId: context.operationId, siteId: details.siteId },
        });
      }
      if (status === "running") {
        database.recordActiveHostedSiteConversationEvent({
          agentId: context.agentId,
          threadId,
          turnId: context.params.turnId,
          createdAt,
          event: { action: context.action, status, operationId: context.operationId, ...details },
        });
      } else {
        database.deleteActiveHostedSiteConversationEvent(context.agentId, context.operationId);
        database.deletePendingHostedSiteTerminalEvent(context.agentId, context.operationId, status);
      }
      // The idempotency guard above means this can legitimately append nothing and still publish.
      return { result: undefined, snapshot: current };
    });
  }

  #reconcileEventsAfterRestart(): void {
    for (const { agentId, threadId, turnId, event } of this.#store.database.activeHostedSiteConversationEvents()) {
      if (
        [...this.#pendingTerminalEvents.values()].some(
          (pending) => pending.agentId === agentId && pending.operationId === event.operationId,
        )
      ) {
        continue;
      }
      const context: HostedSiteMutationContext = {
        agentId,
        operationId: event.operationId,
        action: event.action,
        params: {
          threadId,
          turnId: turnId ?? `hosted-site-${event.operationId}`,
          callId: event.operationId,
          namespace: "openbot",
          tool: hostedSiteTool(event.action),
          arguments: {},
        },
        eventDetails: {
          siteId: event.siteId,
          title: event.title,
          hostname: event.hostname,
          url: event.url,
        },
      };
      this.#recordTerminalEvent(context, "interrupted", context.eventDetails);
    }
  }
}

export class HostedSiteOperationFailed extends Schema.TaggedError<HostedSiteOperationFailed>()(
  "HostedSiteOperationFailed",
  { cause: Schema.Defect() },
) {}

const { sync: siteStep, rewrap: toHostedSiteOperationFailed } = causeHelpers(HostedSiteOperationFailed);

export { toHostedSiteOperationFailed };
