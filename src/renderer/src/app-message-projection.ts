import type {
  AttachmentSummary,
  ClientAgentSummary,
  ConversationMessage,
  QueueDeliveryStatus,
} from "@openbot/contracts/ipc";
import {
  AGENT_PAUSE_ITEM_TYPE,
  CONVERSATION_MEMORY_CHANGES_ITEM_TYPE,
  CONVERSATION_PLAN_ITEM_TYPE,
  CONVERSATION_SUBAGENTS_ITEM_TYPE,
  dispatchConversationEvent,
  hostedSiteConversationEvent,
  isChannelChangeMarker,
  isContextResetMarker,
  isVaultChangeMarker,
  marketplaceSuggestionEvent,
  mcpSignInEvent,
  modelSwitchReason,
  parseConversationPlanText,
  routineConversationEvent,
  routineRunConversationEvent,
  skillConversationEvent,
} from "@openbot/contracts/ipc";
import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import { cleanAgentMessageText } from "@openbot/team-client/agent-message-text";
import type {
  AgentDeliveryMarkerStatus,
  AgentMessage,
  AgentMessagePlan,
  AgentProfile,
  ChatActionMarkerModel,
} from "@openbot/ui/data";
import { formatChatTimestamp } from "@openbot/ui/features/conversation/chat-timestamp";
import type { TaskListItem } from "@openbot/ui/features/conversation/task-list-types";
import { currentText } from "@openbot/ui/text-value";
import { isDispatchMailboxDelivery, isRoutineEventItem } from "./features/conversation/conversation-read-state";

export function toAgentProfile(stored: ClientAgentSummary): AgentProfile {
  return {
    id: stored.id,
    name: stored.name,
    title: stored.title,
    description: stored.description,
    notifications: stored.notifications,
    provider: stored.provider,
    model: stored.model,
    reasoningEffort: stored.reasoningEffort,
    ...(stored.providerAccountId === undefined ? {} : { providerAccountId: stored.providerAccountId }),
    ...(stored.access === undefined ? {} : { access: stored.access }),
    ...(stored.computerUse === undefined ? {} : { computerUse: stored.computerUse }),
    ...(stored.allowAutomation === undefined ? {} : { allowAutomation: stored.allowAutomation }),
    ...(stored.allowNewChat === undefined ? {} : { allowNewChat: stored.allowNewChat }),
    ...(stored.quickAcknowledgement === undefined ? {} : { quickAcknowledgement: stored.quickAcknowledgement }),
    ...(stored.fastMode === undefined ? {} : { fastMode: stored.fastMode }),
    ...(stored.ownBrowserSession === undefined ? {} : { ownBrowserSession: stored.ownBrowserSession }),
    ...(stored.browserProfileId === undefined ? {} : { browserProfileId: stored.browserProfileId }),
    ...(stored.busyMessageMode === undefined ? {} : { busyMessageMode: stored.busyMessageMode }),
    ...(stored.taskLimit === undefined ? {} : { taskLimit: stored.taskLimit }),
    ...(stored.backupModels === undefined ? {} : { backupModels: stored.backupModels }),
    ...(stored.usageLimitReturn === undefined ? {} : { usageLimitReturn: stored.usageLimitReturn }),
    ...(stored.pendingRuntime === undefined ? {} : { pendingRuntime: stored.pendingRuntime }),
    threadId: stored.threadId,
    workspacePath: stored.workspacePath,
    avatarSeed: stored.avatarSeed,
    avatarHue: stored.avatarHue,
    avatarUrl: stored.avatarUrl,
    ...(stored.marketplaceSource === undefined ? {} : { marketplaceSource: stored.marketplaceSource }),
    updatedAt: stored.updatedAt,
    time: stored.updatedAt ? formatTime(stored.updatedAt) : currentText().t("chat.day.now"),
    preview: cleanPreview(stored.preview),
  };
}

export function toAgentMessage(
  message: ConversationMessage,
  ownerAgentId?: string,
  existing?: AgentMessage,
): AgentMessage {
  const exchangeSenderId = message.senderAgentId ?? message.exchange?.senderAgentId;
  const routineEvent = routineConversationEvent(message);
  const routineRunEvent = routineRunConversationEvent(message);
  const hostedSiteEvent = hostedSiteConversationEvent(message);
  const actionMarker = chatActionMarker(message, ownerAgentId, routineEvent, routineRunEvent, hostedSiteEvent);
  const plan = messagePlan(message);
  const dispatchResult = message.itemType === "dispatch" && message.delivery !== undefined;
  const isUserMessage = message.author === "user" && !dispatchResult;
  const senderMember = isUserMessage ? message.senderMember : undefined;
  const subagents = message.itemType === CONVERSATION_SUBAGENTS_ITEM_TYPE ? message.subagents : undefined;
  const memoryChanges = message.author === "system" && message.itemType === CONVERSATION_MEMORY_CHANGES_ITEM_TYPE;
  const status =
    message.exchange || message.routine
      ? undefined
      : message.delivery?.status === "queued"
        ? `Queued #${message.delivery.position}`
        : message.delivery?.status === "cancelled"
          ? "Cancelled"
          : message.status === "failed"
            ? "Failed"
            : message.status === "interrupted"
              ? "Stopped"
              : undefined;
  return {
    id: message.id,
    ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
    author: isUserMessage ? "you" : "agent",
    body: isUserMessage ? message.text : cleanAgentMessageText(message.text),
    time: existing?.createdAt === message.createdAt ? existing.time : formatMessageTime(message.createdAt),
    createdAt: message.createdAt,
    streaming: message.status === "streaming",
    ...(message.itemType === undefined ? {} : { itemType: message.itemType }),
    kind: message.questionPrompt
      ? "question"
      : actionMarker
        ? "action-marker"
        : plan
          ? "plan"
          : subagents?.length
            ? "subagents"
            : memoryChanges
              ? "memory-changes"
              : "text",
    ...(exchangeSenderId === undefined ? {} : { senderAgentId: exchangeSenderId }),
    ...(senderMember === undefined ? {} : { senderMember }),
    ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
    ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
    ...(message.voiceRecording === undefined ? {} : { voiceRecording: message.voiceRecording }),
    ...(message.imageGeneration === undefined ? {} : { imageGeneration: message.imageGeneration }),
    ...(message.questionPrompt === undefined ? {} : { questionPrompt: message.questionPrompt }),
    ...(message.uiBlock ? { uiBlock: message.uiBlock } : {}),
    ...(message.exchange === undefined ? {} : { exchange: message.exchange }),
    ...(message.reaction === undefined ? {} : { reaction: message.reaction }),
    reactions:
      message.reactions ?? (message.reaction ? [{ emoji: message.reaction, actor: { kind: "user" as const } }] : []),
    ...(message.routine === undefined ? {} : { routine: message.routine }),
    ...(actionMarker ? { actionMarker } : {}),
    ...(plan ? { plan } : {}),
    ...(subagents?.length ? { subagents } : {}),
    ...(memoryChanges && message.memoryChanges ? { memoryChanges: message.memoryChanges } : {}),
    ...(message.trace === undefined ? {} : { trace: message.trace }),
    ...(status === undefined ? {} : { status }),
  };
}

/**
 * The plan of a `plan` message. A peer on a released Team API protocol sends only the checklist
 * text, so the plan is read back from it.
 */
function messagePlan(message: ConversationMessage): AgentMessagePlan | null {
  if (message.author !== "assistant" || message.itemType !== CONVERSATION_PLAN_ITEM_TYPE) return null;
  const plan = message.plan ?? parseConversationPlanText(message.text);
  if (!plan?.steps.length) return null;
  return { ...plan, stopped: message.status === "interrupted" || message.status === "failed" };
}

/**
 * The rows of a plan block. A step runs only while its turn runs: after the turn ends, a step that
 * was not finished shows as not started.
 */
export function planItems(plan: AgentMessagePlan, streaming: boolean): TaskListItem[] {
  return plan.steps.map((step) => {
    const state =
      step.status === "completed" ? "done" : step.status === "inProgress" && streaming ? "active" : "pending";
    return { id: step.id, label: state === "active" ? (step.activeText ?? step.text) : step.text, state };
  });
}

const PLAN_TITLE_LIMIT = 80;

/** The header of a plan block: a short explanation, else "Tasks", or "Stopped" for a stopped plan. */
export function planTitle(plan: AgentMessagePlan): string {
  const { t } = currentText();
  if (plan.stopped && plan.steps.some((step) => step.status !== "completed")) return t("chat.taskList.stopped");
  if (plan.explanation && plan.explanation.length <= PLAN_TITLE_LIMIT) return plan.explanation;
  return t("chat.taskList.title");
}

/**
 * The chat rows of stored messages. `convert` gives the row of the message at an index; a caller
 * that keeps the rows of unchanged messages passes it.
 */
export function toAgentMessages(
  messages: readonly ConversationMessage[],
  ownerAgentId?: string,
  convert: (message: ConversationMessage, index: number) => AgentMessage = (message) =>
    toAgentMessage(message, ownerAgentId),
): AgentMessage[] {
  const result: AgentMessage[] = [];
  const thinkingByTurn = new Map<string, AgentMessage>();
  for (const [index, message] of messages.entries()) {
    if (isDispatchMailboxDelivery(message)) continue;
    if ((message.delivery?.status === "queued" || message.delivery?.status === "cancelled") && !message.routine) {
      continue;
    }
    if (message.author !== "assistant" || message.itemType !== "commentary") {
      result.push(convert(message, index));
      continue;
    }

    const key = message.turnId ?? message.id;
    const existing = thinkingByTurn.get(key);
    if (existing) {
      const text = cleanAgentMessageText(message.text);
      existing.items = [...(existing.items ?? []), text];
      existing.itemIds = [...(existing.itemIds ?? []), message.id];
      existing.itemCreatedAt = [...(existing.itemCreatedAt ?? []), message.createdAt];
      existing.streaming = existing.streaming || message.status === "streaming";
      if (message.status === "failed" || message.status === "interrupted") existing.status = message.status;
      if (message.trace) existing.trace = message.trace;
      continue;
    }

    const text = cleanAgentMessageText(message.text);
    const thinking: AgentMessage = {
      id: `thinking:${key}`,
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
      author: "agent",
      body: "",
      time: formatMessageTime(message.createdAt),
      createdAt: message.createdAt,
      streaming: message.status === "streaming",
      itemType: "commentary",
      status: message.status,
      kind: "thinking",
      items: [text],
      itemIds: [message.id],
      itemCreatedAt: [message.createdAt],
      ...(message.trace === undefined ? {} : { trace: message.trace }),
    };
    thinkingByTurn.set(key, thinking);
    result.push(thinking);
  }
  return result;
}

export function agentProfilesEqual(left: AgentProfile, right: AgentProfile): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.title === right.title &&
    left.description === right.description &&
    left.notifications === right.notifications &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.providerAccountId === right.providerAccountId &&
    JSON.stringify(left.backupModels) === JSON.stringify(right.backupModels) &&
    JSON.stringify(left.usageLimitReturn) === JSON.stringify(right.usageLimitReturn) &&
    JSON.stringify(left.pendingRuntime) === JSON.stringify(right.pendingRuntime) &&
    left.access === right.access &&
    left.computerUse === right.computerUse &&
    left.allowAutomation === right.allowAutomation &&
    left.allowNewChat === right.allowNewChat &&
    left.quickAcknowledgement === right.quickAcknowledgement &&
    left.fastMode === right.fastMode &&
    left.ownBrowserSession === right.ownBrowserSession &&
    left.browserProfileId === right.browserProfileId &&
    left.busyMessageMode === right.busyMessageMode &&
    left.taskLimit === right.taskLimit &&
    left.threadId === right.threadId &&
    left.avatarSeed === right.avatarSeed &&
    left.avatarHue === right.avatarHue &&
    left.avatarUrl === right.avatarUrl &&
    marketplaceSourcesEqual(left.marketplaceSource, right.marketplaceSource) &&
    left.updatedAt === right.updatedAt &&
    left.time === right.time &&
    left.preview === right.preview
  );
}

function marketplaceSourcesEqual(
  left: AgentProfile["marketplaceSource"],
  right: AgentProfile["marketplaceSource"],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.listingId === right.listingId &&
    left.versionId === right.versionId &&
    left.version === right.version &&
    stringArraysEqual(left.skillIds, right.skillIds) &&
    stringArraysEqual(left.routineIds, right.routineIds)
  );
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function optionalEqual<T>(left: T | undefined, right: T | undefined, equal: (left: T, right: T) => boolean): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return equal(left, right);
}

function attachmentsEqual(left: AttachmentSummary[], right: AttachmentSummary[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (attachment, index) =>
        attachment.id === right[index]?.id &&
        attachment.name === right[index]?.name &&
        attachment.size === right[index]?.size &&
        attachment.kind === right[index]?.kind &&
        attachment.mimeType === right[index]?.mimeType &&
        attachment.previewKind === right[index]?.previewKind &&
        attachment.previewUrl === right[index]?.previewUrl,
    )
  );
}

function reactionActorsEqual(
  left: NonNullable<AgentMessage["reactions"]>[number]["actor"],
  right: NonNullable<AgentMessage["reactions"]>[number]["actor"],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "agent") return right.kind === "agent" && left.agentId === right.agentId;
  return true;
}

function reactionsEqual(left: AgentMessage["reactions"], right: AgentMessage["reactions"]): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.length === right.length &&
    left.every((reaction, index) => {
      const other = right[index];
      if (!other) return false;
      return reaction.emoji === other.emoji && reactionActorsEqual(reaction.actor, other.actor);
    })
  );
}

function reactionSummaryEqual(left: AgentMessage["reactionSummary"], right: AgentMessage["reactionSummary"]): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.overflowCount === right.overflowCount &&
    left.emojis.length === right.emojis.length &&
    left.emojis.every((emoji, index) => emoji === right.emojis[index])
  );
}

function promptOptionsEqual(
  left: NonNullable<AgentMessage["questionPrompt"]>["questions"][number]["options"],
  right: NonNullable<AgentMessage["questionPrompt"]>["questions"][number]["options"],
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.length === right.length &&
    left.every(
      (option, index) => option.label === right[index]?.label && option.description === right[index]?.description,
    )
  );
}

function questionPromptsEqual(left: AgentMessage["questionPrompt"], right: AgentMessage["questionPrompt"]): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.requestId === right.requestId &&
    left.resolution === right.resolution &&
    left.questions.length === right.questions.length &&
    left.questions.every(
      (question, index) =>
        question.id === right.questions[index]?.id &&
        question.header === right.questions[index]?.header &&
        question.question === right.questions[index]?.question &&
        question.isSecret === right.questions[index]?.isSecret &&
        question.multiSelect === right.questions[index]?.multiSelect &&
        promptOptionsEqual(question.options, right.questions[index]?.options ?? null),
    )
  );
}

function exchangesEqual(left: AgentMessage["exchange"], right: AgentMessage["exchange"]): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.direction === right.direction &&
    left.senderAgentId === right.senderAgentId &&
    left.messageId === right.messageId &&
    left.replyToMessageId === right.replyToMessageId &&
    left.expectsReply === right.expectsReply &&
    left.deliveries.length === right.deliveries.length &&
    left.deliveries.every(
      (delivery, index) =>
        delivery.recipientAgentId === right.deliveries[index]?.recipientAgentId &&
        delivery.status === right.deliveries[index]?.status,
    )
  );
}

function routinesEqual(left: AgentMessage["routine"], right: AgentMessage["routine"]): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.routineId === right.routineId &&
    left.runId === right.runId &&
    left.name === right.name &&
    left.scheduledFor === right.scheduledFor
  );
}

function actionMarkersEqual(left: AgentMessage["actionMarker"], right: AgentMessage["actionMarker"]): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  if (left.kind !== right.kind || left.timestamp !== right.timestamp) return false;
  switch (left.kind) {
    case "agent-message":
      return (
        right.kind === "agent-message" &&
        left.direction === right.direction &&
        left.sourceAgentId === right.sourceAgentId &&
        left.status === right.status &&
        left.messageId === right.messageId &&
        left.replyToMessageId === right.replyToMessageId &&
        left.expectsReply === right.expectsReply &&
        left.targetDeliveries.length === right.targetDeliveries.length &&
        left.targetDeliveries.every(
          (delivery, index) =>
            delivery.agentId === right.targetDeliveries[index]?.agentId &&
            delivery.status === right.targetDeliveries[index]?.status,
        )
      );
    case "routine-run":
      return (
        right.kind === "routine-run" &&
        left.sourceAgentId === right.sourceAgentId &&
        left.routineId === right.routineId &&
        left.runId === right.runId &&
        left.routineName === right.routineName &&
        left.status === right.status
      );
    case "routine-lifecycle":
      return (
        right.kind === "routine-lifecycle" &&
        left.action === right.action &&
        left.sourceAgentId === right.sourceAgentId &&
        left.routineId === right.routineId &&
        left.routineName === right.routineName &&
        left.status === right.status
      );
    case "skill-lifecycle":
      return (
        right.kind === "skill-lifecycle" &&
        left.action === right.action &&
        left.skillId === right.skillId &&
        left.revision === right.revision &&
        left.skillName === right.skillName
      );
    case "hosted-site":
      return (
        right.kind === "hosted-site" &&
        left.sourceAgentId === right.sourceAgentId &&
        left.action === right.action &&
        left.status === right.status &&
        left.operationId === right.operationId &&
        left.siteId === right.siteId &&
        left.title === right.title &&
        left.hostname === right.hostname &&
        left.url === right.url
      );
    case "dispatch":
      return right.kind === "dispatch" && left.phase === right.phase && left.text === right.text;
    case "model-switch":
      return right.kind === "model-switch" && left.reason === right.reason && left.text === right.text;
    case "context-reset":
      return right.kind === "context-reset";
    case "channel-change":
    case "vault-change":
      return right.kind === left.kind && left.text === right.text;
    case "agent-pause":
      return (
        right.kind === "agent-pause" &&
        left.messageId === right.messageId &&
        left.text === right.text &&
        left.pause.reason === right.pause.reason &&
        left.pause.usedTokens === right.pause.usedTokens &&
        left.pause.limitTokens === right.pause.limitTokens &&
        left.pause.resetsAt === right.pause.resetsAt &&
        left.pause.resume === right.pause.resume &&
        left.pause.resolved === right.pause.resolved
      );
    case "marketplace-suggestion":
      return right.kind === "marketplace-suggestion" && left.appId === right.appId;
    case "mcp-sign-in":
      return right.kind === "mcp-sign-in" && left.mcpServerId === right.mcpServerId;
    case "unavailable":
      return right.kind === "unavailable" && left.label === right.label;
    case "agent-message-group":
    case "routine-run-group":
    case "channel-routing":
      return false;
    default:
      return false;
  }
}

function plansEqual(left: AgentMessage["plan"], right: AgentMessage["plan"]): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.stopped === right.stopped &&
    left.explanation === right.explanation &&
    left.steps.length === right.steps.length &&
    left.steps.every(
      (step, index) =>
        step.id === right.steps[index]?.id &&
        step.text === right.steps[index]?.text &&
        step.activeText === right.steps[index]?.activeText &&
        step.status === right.steps[index]?.status,
    )
  );
}

function subagentsEqual(left: AgentMessage["subagents"], right: AgentMessage["subagents"]): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.length === right.length &&
    left.every(
      (subagent, index) =>
        subagent.id === right[index]?.id &&
        subagent.title === right[index]?.title &&
        subagent.status === right[index]?.status,
    )
  );
}

function projectedBody(message: ConversationMessage): string {
  const dispatchResult = message.itemType === "dispatch" && message.delivery !== undefined;
  const isUserMessage = message.author === "user" && !dispatchResult;
  return isUserMessage ? message.text : cleanAgentMessageText(message.text);
}

function projectedStatus(message: ConversationMessage): string | undefined {
  if (message.exchange || message.routine) return undefined;
  if (message.delivery?.status === "queued") return `Queued #${message.delivery.position}`;
  if (message.delivery?.status === "cancelled") return "Cancelled";
  if (message.status === "failed") return "Failed";
  if (message.status === "interrupted") return "Stopped";
  return undefined;
}

/** True when a stored row must be built again from the source message. */
export function agentMessageNeedsReprojection(
  source: ConversationMessage,
  existing: AgentMessage,
  ownerAgentId?: string,
): boolean {
  if (source.id !== existing.id) return true;
  if (projectedBody(source) !== existing.body) return true;
  if (source.createdAt !== existing.createdAt) return true;
  if ((source.status === "streaming") !== (existing.streaming === true)) return true;
  if (source.turnId !== existing.turnId) return true;
  if (source.itemType !== existing.itemType) return true;
  const dispatchResult = source.itemType === "dispatch" && source.delivery !== undefined;
  const isUserMessage = source.author === "user" && !dispatchResult;
  if ((isUserMessage ? "you" : "agent") !== existing.author) return true;
  if (projectedStatus(source) !== existing.status) return true;
  const exchangeSenderId = source.senderAgentId ?? source.exchange?.senderAgentId;
  if (exchangeSenderId !== existing.senderAgentId) return true;
  if (source.senderMember?.id !== existing.senderMember?.id) return true;
  if (source.senderMember?.name !== existing.senderMember?.name) return true;
  if (source.replyToMessageId !== existing.replyToMessageId) return true;
  if (source.reaction !== existing.reaction) return true;
  if (!optionalEqual(source.attachments, existing.attachments, attachmentsEqual)) return true;
  if (!optionalEqual(source.questionPrompt, existing.questionPrompt, questionPromptsEqual)) return true;
  if (!optionalEqual(source.exchange, existing.exchange, exchangesEqual)) return true;
  if (!optionalEqual(source.routine, existing.routine, routinesEqual)) return true;
  if (
    !reactionsEqual(
      source.reactions ?? (source.reaction ? [{ emoji: source.reaction, actor: { kind: "user" as const } }] : []),
      existing.reactions,
    )
  ) {
    return true;
  }
  const routineEvent = routineConversationEvent(source);
  const routineRunEvent = routineRunConversationEvent(source);
  const hostedSiteEvent = hostedSiteConversationEvent(source);
  const actionMarker = chatActionMarker(source, ownerAgentId, routineEvent, routineRunEvent, hostedSiteEvent);
  if (!actionMarkersEqual(actionMarker ?? undefined, existing.actionMarker)) return true;
  const plan = messagePlan(source);
  if (!plansEqual(plan ?? undefined, existing.plan)) return true;
  const subagents = source.itemType === CONVERSATION_SUBAGENTS_ITEM_TYPE ? source.subagents : undefined;
  if (!subagentsEqual(subagents, existing.subagents)) return true;
  return false;
}

export function agentMessagesEqual(left: AgentMessage, right: AgentMessage): boolean {
  if (left === right) return true;
  return (
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.author === right.author &&
    left.body === right.body &&
    left.time === right.time &&
    left.kind === right.kind &&
    left.streaming === right.streaming &&
    left.itemType === right.itemType &&
    left.status === right.status &&
    left.senderAgentId === right.senderAgentId &&
    left.senderMember?.id === right.senderMember?.id &&
    left.senderMember?.name === right.senderMember?.name &&
    left.replyToMessageId === right.replyToMessageId &&
    left.reaction === right.reaction &&
    optionalEqual(left.reactions, right.reactions, reactionsEqual) &&
    optionalEqual(left.reactionSummary, right.reactionSummary, reactionSummaryEqual) &&
    optionalEqual(left.attachments, right.attachments, attachmentsEqual) &&
    optionalEqual(left.questionPrompt, right.questionPrompt, questionPromptsEqual) &&
    optionalEqual(left.exchange, right.exchange, exchangesEqual) &&
    optionalEqual(left.routine, right.routine, routinesEqual) &&
    optionalEqual(left.actionMarker, right.actionMarker, actionMarkersEqual) &&
    optionalEqual(left.items, right.items, stringArraysEqual) &&
    optionalEqual(left.itemIds, right.itemIds, stringArraysEqual) &&
    optionalEqual(left.plan, right.plan, plansEqual) &&
    optionalEqual(left.subagents, right.subagents, subagentsEqual)
  );
}

function chatActionMarker(
  message: ConversationMessage,
  ownerAgentId: string | undefined,
  routineEvent: ReturnType<typeof routineConversationEvent>,
  routineRunEvent: ReturnType<typeof routineRunConversationEvent>,
  hostedSiteEvent: ReturnType<typeof hostedSiteConversationEvent>,
): ChatActionMarkerModel | null {
  if (isDispatchMailboxDelivery(message)) return null;
  if (message.exchange) {
    const targetDeliveries = message.exchange.deliveries.map((delivery) => ({
      agentId: delivery.recipientAgentId,
      status: delivery.status,
    }));
    const status =
      message.exchange.direction === "incoming"
        ? deliveryStatus(message.delivery?.status ?? targetDeliveries[0]?.status)
        : aggregateDeliveryStatus(targetDeliveries.map((delivery) => delivery.status));
    return {
      kind: "agent-message",
      direction: message.exchange.direction,
      sourceAgentId: message.exchange.senderAgentId,
      targetDeliveries,
      status,
      timestamp: message.createdAt,
      messageId: message.exchange.messageId,
      replyToMessageId: message.exchange.replyToMessageId,
      expectsReply: message.exchange.expectsReply !== false,
    };
  }
  if (isContextResetMarker(message)) return { kind: "context-reset", timestamp: message.createdAt };
  if (message.itemType === AGENT_PAUSE_ITEM_TYPE && message.author === "system" && message.pause)
    return {
      kind: "agent-pause",
      messageId: message.id,
      pause: message.pause,
      text: message.text,
      timestamp: message.createdAt,
    };
  const switchReason = modelSwitchReason(message);
  if (switchReason)
    return { kind: "model-switch", reason: switchReason, text: message.text, timestamp: message.createdAt };
  if (isChannelChangeMarker(message))
    return { kind: "channel-change", text: message.text, timestamp: message.createdAt };
  if (isVaultChangeMarker(message)) return { kind: "vault-change", text: message.text, timestamp: message.createdAt };
  const skillEvent = skillConversationEvent(message);
  if (skillEvent) return { ...skillEvent, kind: "skill-lifecycle", timestamp: message.createdAt };
  const suggestion = marketplaceSuggestionEvent(message);
  if (suggestion) return { kind: "marketplace-suggestion", appId: suggestion.appId, timestamp: message.createdAt };
  const dispatchEvent = dispatchConversationEvent(message);
  if (dispatchEvent)
    return {
      kind: "dispatch",
      phase: dispatchEvent.phase,
      text: message.text,
      timestamp: message.createdAt,
    };
  const signIn = mcpSignInEvent(message);
  if (signIn) return { kind: "mcp-sign-in", mcpServerId: signIn.mcpServerId, timestamp: message.createdAt };
  if (routineEvent) {
    return {
      kind: "routine-lifecycle",
      action: routineEvent.action,
      sourceAgentId: ownerAgentId ?? null,
      routineId: routineEvent.routineId,
      routineName: routineEvent.routineName,
      status: "completed",
      timestamp: message.createdAt,
    };
  }
  if (routineRunEvent) {
    return {
      kind: "routine-run",
      sourceAgentId: ownerAgentId ?? null,
      routineId: routineRunEvent.routineId,
      runId: routineRunEvent.runId,
      routineName: routineRunEvent.routineName,
      status: routineRunEvent.status,
      timestamp: message.createdAt,
    };
  }
  if (message.routine) {
    return {
      kind: "routine-run",
      sourceAgentId: ownerAgentId ?? null,
      routineId: message.routine.routineId,
      runId: message.routine.runId,
      routineName: message.routine.name,
      status: "queued",
      timestamp: message.createdAt,
    };
  }
  if (hostedSiteEvent) {
    return {
      kind: "hosted-site",
      sourceAgentId: ownerAgentId ?? null,
      action: hostedSiteEvent.action,
      status: hostedSiteEvent.status,
      operationId: hostedSiteEvent.operationId,
      siteId: hostedSiteEvent.siteId,
      title: hostedSiteEvent.title,
      hostname: hostedSiteEvent.hostname,
      url: hostedSiteEvent.url,
      timestamp: message.createdAt,
    };
  }
  if (isRoutineEventItem(message)) {
    return { kind: "unavailable", label: currentText().t("app.action.unavailable"), timestamp: message.createdAt };
  }
  return null;
}

function aggregateDeliveryStatus(statuses: QueueDeliveryStatus[]): AgentDeliveryMarkerStatus {
  if (statuses.length === 0) return "unavailable";
  const normalized = statuses.map(deliveryStatus);
  if (normalized.every((status) => status === "queued")) return "queued";
  if (normalized.some((status) => status === "in-progress")) return "in-progress";
  if (normalized.every((status) => status === "completed")) return "completed";
  if (normalized.every((status) => status === "failed")) return "failed";
  if (normalized.every((status) => status === "interrupted")) return "interrupted";
  if (normalized.every((status) => status === "cancelled")) return "cancelled";
  if (normalized.every((status) => ["completed", "failed", "interrupted", "cancelled"].includes(status))) {
    return "partial";
  }
  return "in-progress";
}

function deliveryStatus(status: QueueDeliveryStatus | undefined): Exclude<AgentDeliveryMarkerStatus, "partial"> {
  if (!status) return "unavailable";
  if (status === "starting" || status === "running") return "in-progress";
  return status;
}

export function retainThinkingMessages(previous: AgentMessage[], next: AgentMessage[]): AgentMessage[] {
  const result = [...next];
  const nextIds = new Set(result.map((message) => message.id));
  for (const thinking of previous) {
    if (thinking.kind !== "thinking" || nextIds.has(thinking.id) || !thinking.turnId) continue;
    const sameTurnIndexes = result.flatMap((message, index) => (message.turnId === thinking.turnId ? [index] : []));
    if (sameTurnIndexes.length === 0) continue;
    const finalAnswerIndex = result.findIndex(
      (message) => message.turnId === thinking.turnId && message.author === "agent" && message.kind !== "thinking",
    );
    const insertionIndex = finalAnswerIndex >= 0 ? finalAnswerIndex : (sameTurnIndexes.at(-1) ?? result.length - 1) + 1;
    result.splice(insertionIndex, 0, { ...thinking, streaming: false });
    nextIds.add(thinking.id);
  }
  return result;
}

export function withoutAgent<T>(values: Record<string, T>, agentId: string): Record<string, T> {
  const next = { ...values };
  delete next[agentId];
  return next;
}

function cleanPreview(preview: string): string {
  // The stored preview is the start of the message as written, Markdown and all.
  const cleaned = markdownPreviewText(cleanAgentMessageText(preview))
    .replace(/\binbox\s+at\s+zero\b[:,]?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || currentText().t("app.agent.noMessages");
}

function formatTime(value: string): string {
  const date = new Date(value);
  const { t, format } = currentText();
  if (Number.isNaN(date.getTime())) return t("chat.day.now");
  return format.date(date, { hour: "2-digit", minute: "2-digit" });
}

export function formatMessageTime(value: string): string {
  const date = new Date(value);
  const { t, format } = currentText();
  if (Number.isNaN(date.getTime())) return t("chat.day.now");
  return formatChatTimestamp(date, format);
}
