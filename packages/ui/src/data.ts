import type {
  AgentAccess,
  AgentExchangeSummary,
  AgentModelId,
  AgentProviderId,
  AgentReasoningEffort,
  AgentSummary,
  AttachmentSummary,
  AvatarHue,
  ChannelRoutingConversationEvent,
  ConversationMessageSender,
  ConversationPause,
  ConversationPlan,
  ConversationQuestionPrompt,
  ConversationReaction,
  HostedSiteConversationEvent,
  ImageGenerationInfo,
  InstalledSkill,
  McpServerConfig,
  MessageReaction,
  ModelSwitchReason,
  QueueDeliveryStatus,
  RoutineConversationEvent,
  RoutineRunConversationEvent,
  SkillConversationEvent,
} from "@openbot/contracts/ipc";
import type { ConversationUiBlock } from "@openbot/contracts/ui-blocks";

/**
 * `error` is a message the renderer wrote itself, not one the provider sent: an action of the
 * user failed, and `status` names which one.
 */
export type MessageKind = "text" | "thinking" | "exchange" | "question" | "action-marker" | "plan" | "error";

/** The plan of one turn. `stopped` is true when the turn was stopped or failed before it ended. */
export interface AgentMessagePlan extends ConversationPlan {
  stopped: boolean;
}

export type ChatActionMarkerStatus =
  | "queued"
  | "in-progress"
  | "needs-attention"
  | "completed"
  | "partial"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "unavailable";

export type AgentDeliveryMarkerStatus = Exclude<ChatActionMarkerStatus, "needs-attention">;

export interface RoutineRunMarkerTransition {
  status: "queued" | RoutineRunConversationEvent["status"];
  timestamp: string;
}

export interface AgentMessageMarkerModel {
  kind: "agent-message";
  direction: "incoming" | "outgoing";
  sourceAgentId: string;
  targetDeliveries: Array<{ agentId: string; status: QueueDeliveryStatus }>;
  status: AgentDeliveryMarkerStatus;
  timestamp: string;
  messageId: string;
  replyToMessageId: string | null;
  /** The sender asked for no answer, so the marker names it as information rather than a request. */
  expectsReply: boolean;
}

export interface RoutineRunMarkerModel {
  kind: "routine-run";
  sourceAgentId: string | null;
  routineId: string;
  runId: string;
  routineName: string;
  status: "queued" | RoutineRunConversationEvent["status"];
  timestamp: string;
  previousTransitions?: RoutineRunMarkerTransition[];
  /** Set when the run has messages in the chat: whether they show under the run. */
  expanded?: boolean;
}

export type ChatActionMarkerModel =
  | (SkillConversationEvent & { kind: "skill-lifecycle"; timestamp: string })
  | AgentMessageMarkerModel
  /**
   * Consecutive agent messages, oldest first, drawn as one row. Only the timeline joins them: each
   * stored message keeps its own marker. `timestamp` is the time of the newest message.
   */
  | {
      kind: "agent-message-group";
      messages: Array<{ id: string; marker: AgentMessageMarkerModel }>;
      timestamp: string;
    }
  | {
      kind: "routine-lifecycle";
      action: RoutineConversationEvent["action"];
      sourceAgentId: string | null;
      routineId: string;
      routineName: string;
      status: "completed";
      timestamp: string;
    }
  | RoutineRunMarkerModel
  /**
   * Consecutive completed runs of one routine, oldest first, drawn as one row. Only the timeline
   * joins them: each stored run keeps its own marker. `routineName` is the name of the newest run,
   * and `timestamp` is the time of the newest run.
   */
  | {
      kind: "routine-run-group";
      routineId: string;
      routineName: string;
      runs: Array<{ id: string; marker: RoutineRunMarkerModel }>;
      timestamp: string;
      /** Set when the timeline shows the runs as rows under the group: whether they show. */
      expanded?: boolean;
    }
  | {
      kind: "hosted-site";
      sourceAgentId: string | null;
      action: HostedSiteConversationEvent["action"];
      status: HostedSiteConversationEvent["status"];
      operationId: string;
      siteId: string | null;
      title: string;
      hostname: string | null;
      url: string | null;
      timestamp: string;
    }
  | (ChannelRoutingConversationEvent & { kind: "channel-routing"; timestamp: string })
  /** The agent suggested a Marketplace app. The chat shows a card to connect it. */
  | { kind: "marketplace-suggestion"; appId: string; timestamp: string }
  /** The user started a new chat: the agent does not see the messages above this marker. */
  | { kind: "context-reset"; timestamp: string }
  /** The agent left its model for a usage limit, or went back to it. `text` is the host's note. */
  | { kind: "model-switch"; reason: ModelSwitchReason; text: string; timestamp: string }
  /** The agent stopped or waits for the user or for its plan. `text` is the host's note. */
  | { kind: "agent-pause"; messageId: string; pause: ConversationPause; text: string; timestamp: string }
  | {
      kind: "unavailable";
      label: string;
      timestamp: string;
    };

export interface MessageCitation {
  number: number;
  label: string;
  url: string;
  host?: string;
}

export interface MessageReactionSummary {
  emojis: MessageReaction[];
  overflowCount?: number;
}

export interface AgentMessage {
  id: string;
  turnId?: string | undefined;
  author: "you" | "agent";
  body: string;
  time: string;
  createdAt?: string;
  streaming?: boolean;
  animate?: boolean | undefined;
  itemType?: string | undefined;
  kind?: MessageKind;
  status?: string | undefined;
  senderAgentId?: string | undefined;
  /** The person who wrote a `you` message. Absent on the reader's own older messages. */
  senderMember?: ConversationMessageSender | undefined;
  replyToMessageId?: string | null | undefined;
  attachments?: AttachmentSummary[] | undefined;
  imageGeneration?: ImageGenerationInfo | undefined;
  questionPrompt?: ConversationQuestionPrompt | undefined;
  /** The interactive block an agent drew. A blocking block sits beside `questionPrompt`. */
  uiBlock?: ConversationUiBlock;
  citations?: MessageCitation[];
  exchange?: AgentExchangeSummary | undefined;
  reaction?: MessageReaction | null | undefined;
  reactions?: ConversationReaction[];
  reactionSummary?: MessageReactionSummary;
  routine?:
    | {
        routineId: string;
        runId: string;
        name: string;
        scheduledFor: string;
      }
    | undefined;
  actionMarker?: ChatActionMarkerModel | undefined;
  items?: string[];
  itemIds?: string[];
  plan?: AgentMessagePlan | undefined;
}

export interface AgentProfile {
  id: string;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  provider: AgentProviderId;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
  /** The provider account after the first. Absent for the provider's own sign-in. */
  providerAccountId?: string | undefined;
  /** Absent for an agent on a remote host, which does not share it; the host then decides. */
  access?: AgentAccess | undefined;
  /** Absent means on. Absent for an agent on a remote host too, which does not share it. */
  computerUse?: boolean | undefined;
  /** Absent means off. Absent for an agent on a remote host too, which does not share it. */
  allowAutomation?: boolean | undefined;
  /** Absent means the app default. Absent for an agent on a remote host too, which does not share it. */
  busyMessageMode?: AgentSummary["busyMessageMode"];
  /** Absent means the default task limit. Absent for an agent on a remote host too, which runs no tasks. */
  taskLimit?: AgentSummary["taskLimit"];
  /** Absent means ask before a switch at a usage limit. Absent for an agent on a remote host too. */
  backupModels?: AgentSummary["backupModels"];
  /** Set while the agent works on a backup model for a usage limit: the model it goes back to. */
  usageLimitReturn?: AgentSummary["usageLimitReturn"];
  threadId: string | null;
  /** The agent's working directory. Absent for profiles built before it was tracked. */
  workspacePath?: string;
  avatarSeed: string;
  avatarHue: AvatarHue | null;
  avatarUrl: string | null;
  marketplaceSource?: NonNullable<AgentSummary["marketplaceSource"]>;
  updatedAt?: string | null;
  time: string;
  preview: string;
}

/** The agent fields that the composer, the queue, rich text and the browser dock read. */
export type ComposerAgent = Pick<
  AgentProfile,
  "id" | "name" | "title" | "description" | "avatarSeed" | "avatarHue" | "avatarUrl"
>;

/** The skill fields that the composer, the queue and rich text read. */
export type ComposerSkill = Pick<
  InstalledSkill,
  "skillId" | "slug" | "name" | "state" | "enabled" | "origin" | "description"
>;

/** The MCP server fields that the composer reads. It never reads the environment or the headers. */
export type ComposerMcpServer = Pick<
  McpServerConfig,
  "id" | "name" | "enabled" | "transport" | "command" | "args" | "url"
>;
