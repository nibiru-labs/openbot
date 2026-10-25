import type {
  AccountUsage,
  AgentContextState,
  AgentEvent,
  AgentModelChoice,
  AgentModelOption,
  AgentProviderId,
  AgentStatus,
  AgentTask,
  AgentTasksSnapshot,
  AgentWait,
  AttachmentSummary,
  AvatarImageInput,
  BrowserControlState,
  BrowserTab,
  BusyMessageMode,
  ConversationSnapshot,
  CustomAgentSummary,
  CustomProviderSummary,
  DraftAttachment,
  FilePreview,
  ProviderRuntimeStatus,
  QueueSnapshot,
  RoutineFields,
  ServerSummary,
  TeamPresenceSnapshot,
  UpdateAgentAdminSettingsInput,
  UpdateAgentInput,
  WorkspaceDirectory,
} from "@openbot/contracts/ipc";
import type { ConversationUiBlock } from "@openbot/contracts/ui-blocks";
import type { AgentMessage, AgentProfile } from "@openbot/ui/data";
import type { BrowserViewRuntime } from "@openbot/ui/features/browser/BrowserLiveView";
import type { UsageLimitAskCardProps } from "@openbot/ui/features/conversation/BackupModels";
import type { UnloadedHistory } from "@openbot/ui/features/conversation/ChatScrollRail";
import type { JSX } from "@solidjs/web";
import type { ConnectorRegistry } from "../connectors/connector-registry";
import type { ConversationRuntime } from "./conversation-runtime";

/**
 * What a conversation is, as data. These live apart from `ConversationView.tsx`
 * because fifteen of this feature's modules - the scope, the controller, the
 * draft logic and every store - name one of these types and none of them render
 * anything. Reading them from the entry component made `conversation-scope.ts`
 * and `ConversationView.tsx` import each other: a cycle `noImportCycles` lets
 * through only because one direction is `import type`.
 */

/** Opens an agent's settings panel. A `routine` opens that routine's settings in it. */
export interface AgentSettingsRequest {
  agentId: string;
  nonce: number;
  routine?: { routineId: string; name: string };
}

export interface ConversationTarget {
  agentId: string;
  serverId: string;
}

/** What was said so far in a recording, and the conversation it is dictated into. */
export interface VoiceLiveTranscript extends ConversationTarget {
  text: string;
}

/** How an answer to a prompt reports a failure. */
export interface PromptAnswerOptions {
  /**
   * Gets the error of an answer that failed, for a card that shows it itself. Without it the app
   * reports the failure in the conversation (desktop) or the answer throws (web client).
   */
  onError?: ((error: unknown) => void) | undefined;
}

export interface ConversationProps {
  contextState?: AgentContextState | undefined;
  runtime?: ConversationRuntime | undefined;
  notice?: JSX.Element | undefined;
  onOpenUsage?: ((trigger: HTMLButtonElement) => void) | undefined;
  onOpenMarketplace?: (() => void) | undefined;
  /**
   * Opens Marketplace at one app, from a suggestion card. `connect` is true only when the person
   * pressed Connect or Install on the card: the page then starts the connect step.
   */
  onOpenMarketplaceApp?: ((request: { appId: string; connect: boolean }) => void) | undefined;
  /** The connectors of the server on screen, which a suggestion card for a connector reads. */
  connectors?: ConnectorRegistry | undefined;
  platform?: import("@openbot/contracts/ipc").AppInfo["platform"] | undefined;

  agentStatus: AgentStatus;
  /** A joined server's agents are still on their way, so the composer says that it connects. */
  agentsConnecting?: boolean | undefined;
  /**
   * The plan windows for the active agent's provider and model, when the account usage has them.
   * The composer reads them for one thing only: a window at 100% means the next send is refused by
   * the provider, so the notice has to say so before the user writes the message.
   */
  accountUsage?: AccountUsage | null | undefined;
  providerRuntimeStatuses?: Partial<Record<AgentProviderId, ProviderRuntimeStatus>> | undefined;
  /**
   * The endpoints the user named, so both model pickers can tell a custom model from an OpenCode
   * one. It travels as a prop rather than through `useCustomProviders()`, the same
   * path `providerRuntimeStatuses` above already takes.
   */
  customProviders?: readonly CustomProviderSummary[] | undefined;
  /** The user's own ACP agents on this computer, for the model picker's Custom tab. */
  customAgents?: readonly CustomAgentSummary[] | undefined;
  onDownloadProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onCancelProviderDownload?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  onConnectProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  canConnectProvider?: ((provider: AgentProviderId) => boolean) | undefined;
  /**
   * Take the user to the provider's sign-in. Separate from `onConnectProvider`, which is the
   * managed-download path and is withheld when downloads are unavailable: a signed-out provider
   * needs a way in whether or not OpenBot manages its CLI.
   */
  onSignInProvider?: ((provider: AgentProviderId) => void | Promise<void>) | undefined;
  /** The code sign-in, for a provider that has one, when the browser sign-in is slow or fails. */
  onSignInWithCodeProvider?: ((provider: AgentProviderId) => void) | undefined;
  /** Open the Providers section of this server's settings, where the user adds an endpoint. */
  onManageProviders?: ((trigger: HTMLElement) => void) | undefined;
  agent: AgentProfile | undefined;
  agents: AgentProfile[];
  /**
   * The agents that the composer offers for a mention. Absent means `agents`. A hidden agent gets no
   * messages, so the desktop leaves it out; the timeline still names it from `agents`.
   */
  mentionAgents?: AgentProfile[] | undefined;
  availableRoutineIds?: readonly string[] | undefined;
  /** The agent's routines, for the chat card of a routine the agent created or changed. */
  routines?: readonly RoutineFields[] | undefined;
  modelOptions: AgentModelOption[];
  messages: readonly AgentMessage[];
  messageReferences?: Record<string, AgentMessage> | undefined;
  /** The quoted originals that the host no longer has. Their replies show a note in place of the quote. */
  missingMessageReferences?: Readonly<Record<string, true>> | undefined;
  unreadCount: number;
  firstUnreadMessageId: string | null;
  loaded: boolean;
  hasOlder?: boolean | undefined;
  /** The messages above the loaded page, for the scroll rail. Absent when the host does not count them. */
  unloadedHistory?: UnloadedHistory | undefined;
  discontinuous?: boolean | undefined;
  loadingOlder?: boolean | undefined;
  olderError?: string | null | undefined;
  activeTurnId: string | null | undefined;
  activityDetail?: string | undefined;
  skillsMarketplaceOpen?: boolean | undefined;
  /**
   * True while a surface that can add or remove one of the host's MCP servers is open: the server
   * settings and the marketplace, where a plugin installs its app. The composer reads the
   * list again when the last of them closes, so a server added there can be tagged without a
   * restart.
   */
  mcpSettingsOpen?: boolean | undefined;
  globalOverlayOpen: boolean;
  settingsRequest: AgentSettingsRequest | null;
  messageFocusRequest: { agentId: string; messageId: string; nonce: number } | null;
  queue: QueueSnapshot | undefined;
  /** The agent's open waits. Absent where the host does not keep them. */
  waits?: readonly AgentWait[] | undefined;
  /** The agent's tasks. Absent where the host keeps no tasks. */
  tasks?: ConversationTasks | undefined;
  browserTabs: BrowserTab[];
  activeBrowserTabId: string | null;
  browserVisibilitySuspended: boolean;
  /**
   * The workspace content is covered by a panel above it, the Usage report today.
   * The conversation stays mounted, so its document-level keyboard listeners are
   * still registered; `inert` on the covered markup does not reach them.
   */
  workspaceCovered?: boolean | undefined;
  browserControlState: BrowserControlState;
  /** Optional browser stream adapter for a non-Electron client. */
  browserRuntime?: BrowserViewRuntime | undefined;
  server: ServerSummary | undefined;
  presence: TeamPresenceSnapshot;
  currentUserEmail: string;
  /**
   * Is the stamped sender of a message the reader? Only another person's message draws a face and a
   * name; a message with no sender is the reader's own, as every message was before senders.
   */
  isOwnSender: (senderId: string) => boolean;
  browserEnabled?: boolean | undefined;
  remoteDesktopEnabled?: boolean | undefined;
  remoteDesktopSessionActive: boolean;
  remoteDesktopVisible: boolean;
  prompt: Extract<AgentEvent, { type: "prompt" }> | undefined;
  /**
   * The interactive block of `prompt`'s message, when the agent asked with one. The prompt then draws
   * as the block's card; without it, as the prompt's questions.
   */
  promptUiBlock?: ConversationUiBlock | undefined;
  approval: Extract<AgentEvent, { type: "approval" }>["approval"] | undefined;
  /** A usage limit holds the agent's queued message on this computer. The chat asks where to send it. */
  usageLimitAsk?: UsageLimitAskCardProps | undefined;
  /** Whether a usage limit holds this model and account now. Absent for a joined server. */
  usageLimited?: ((choice: AgentModelChoice) => boolean) | undefined;
  browserTakeover: Extract<AgentEvent, { type: "browser-takeover-requested" }>["request"] | undefined;
  onSelectAgent: (agentId: string) => void;
  onUpdateAgent: (agentId: string, updates: Omit<UpdateAgentInput, "agentId">) => Promise<void>;
  onSetAgentAvatar: (agentId: string, image: AvatarImageInput | null) => Promise<void>;
  /**
   * Sends one message. `clientMessageId` names it for the host, so a retry with the same id
   * returns the first receipt; the answer carries the host's id for the message, or why it failed.
   */
  onSendMessage: (
    body: string,
    attachmentDraftIds: string[],
    replyToMessageId: string | null,
    target?: ConversationTarget,
    clientMessageId?: string,
    options?: { interrupt?: boolean },
  ) => Promise<SendMessageResult>;
  onMarkRead: () => Promise<void>;
  onLoadOlder?: (() => void) | undefined;
  onLoadLatest?: (() => Promise<void>) | undefined;
  onSearchMessages?: ((query: string) => Promise<{ messageIds: string[]; total: number }>) | undefined;
  onOpenSearchMessage?: ((messageId: string) => Promise<void>) | undefined;
  onTypingChange: (agentId: string, typing: boolean) => void;
  onAnswerPrompt: (answers: Record<string, string[]>, options?: PromptAnswerOptions) => Promise<boolean>;
  onPromptResolutionPresented?: ((agentId: string, turnId: string, requestId: string | number) => void) | undefined;
  onRespondToApproval: (decision: "accept" | "decline") => Promise<boolean>;
  /**
   * Moves an agent at Ask first to Full access and accepts the request in hand. Absent at any other
   * level, and where the user may not change the agent's Permissions.
   */
  onAlwaysAllowApproval?: (() => Promise<boolean>) | undefined;
  /**
   * Whether this agent acts without asking at Full access. Unknown while a remote host has not
   * answered. Together with the agent's access it gives the Permissions level.
   */
  agentAutoApproves?: boolean | undefined;
  /** The app default an agent without its own busy-message setting follows. Local agents only. */
  defaultBusyMessageMode?: BusyMessageMode | undefined;
  /** The app memory cap. Local agents only. */
  agentMemoryLimit?: number | undefined;
  /** Writes the agent's Permissions level. Absent where the user may not change it. */
  onUpdateAgentPermissions?: ((input: UpdateAgentAdminSettingsInput) => Promise<void>) | undefined;
  /** Starts a new chat with the agent. Absent when its host does not serve `context-reset-v1`. */
  onClearAgentContext?: (() => Promise<void>) | undefined;
  onRespondToBrowserTakeover: (decision: "complete" | "cancel") => Promise<boolean>;
  onCancelQueuedMessage: (deliveryId: string) => void;
  onCancelWait?: ((waitId: string) => void) | undefined;
  onSteerQueuedMessage: (deliveryId: string) => void;
  onUpdateQueuedMessage: (
    deliveryId: string,
    text: string,
    keepAttachmentIds: string[],
    attachmentDraftIds: string[],
    target?: ConversationTarget,
  ) => Promise<boolean>;
  onReorderQueue: (deliveryIds: string[]) => void;
  /** Pauses or resumes the agent's queue. Local agents only. */
  onSetQueuePaused?: ((paused: boolean) => void) | undefined;
  /** Stops the running turn and starts one queued message next. Local agents only. */
  onRunQueuedMessageNow?: ((deliveryId: string) => void) | undefined;
  /** Cancels every queued message of the agent. */
  onClearQueue?: (() => void) | undefined;
  /** Shows "Stop and send". The Team API has no route for it, so remote agents do not offer it. */
  canStopAndSend?: boolean | undefined;
  onActivateBrowserTab: (tabId: string) => void;
  onCloseBrowserTab: (tabId: string) => void | Promise<void>;
  onOpenRemoteDesktop: (serverId: string, trigger: HTMLElement) => Promise<void>;
  onStop: () => void;
}

/** `messageId` is the conversation message the host stored: the delivery id of the receipt. */
export type SendMessageResult = { messageId: string } | { error: string };

export interface ComposerDraft {
  text: string;
  attachments: DraftAttachment[];
  replyToMessageId: string | null;
}

/**
 * What the file preview panel is showing. A shared or workspace file is named by its path, which
 * the main process reads; an attachment is named by its record, because its bytes arrive over
 * `previewUrl` and "open externally" goes through the attachment handler instead of a path.
 */
type SidebarFilePreviewSource =
  | { kind: "shared"; path: string }
  /** `folder` is the folder view the file was opened from, so the panel can go back to it. */
  | { kind: "workspace"; path: string; folder?: string | undefined }
  | { kind: "attachment"; attachment: AttachmentSummary };

export type SidebarFilePreview =
  | { ownerAgentId: string; source: SidebarFilePreviewSource; preview: FilePreview; directory?: undefined }
  | {
      ownerAgentId: string;
      source: { kind: "workspace-folder"; path: string };
      preview: null;
      directory: WorkspaceDirectory;
    };

export type RightPanelMode =
  | "none"
  /** The side panel with no open pane. It lists the panes it can open. */
  | "side-panel"
  | "browser"
  | "browser-expanded"
  | "browser-pip"
  | "settings"
  | "file-preview"
  | "files"
  | "task"
  | "question";

export type { SidePanelPane } from "@openbot/ui/features/conversation/SidePanel";

/** The tasks of the active agent, and the task actions. Each action names the task, not the agent. */
export interface ConversationTasks {
  snapshot: AgentTasksSnapshot | undefined;
  /** The conversation of a task, after `onOpen` read it. */
  conversation: (taskId: string) => ConversationSnapshot | undefined;
  onOpen: (taskId: string) => void;
  onStart: (text: string) => Promise<AgentTask | null>;
  onRunQueuedMessage: (deliveryId: string) => void;
  onSend: (taskId: string, text: string) => Promise<boolean>;
  onStop: (taskId: string) => void;
  onClose: (taskId: string) => void;
  onReopen: (taskId: string) => void;
}
