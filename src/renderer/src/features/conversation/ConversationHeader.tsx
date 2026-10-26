import { isAgentTaskActive } from "@openbot/ui/features/conversation/AgentTasks";
import { ConversationHeader as SharedConversationHeader } from "@openbot/ui/features/conversation/ConversationHeader";
import { useConversationViewScope } from "./conversation-scope";

const loadAgentSettingsPanel = () => import("./AgentSettingsPanel");

import { useText } from "@openbot/ui/text";

/** @internal Stable HMR boundary for conversation header. */
export function ConversationHeader() {
  const { t } = useText();
  const {
    actingBrowserControl,
    agentActivity,
    browserControlAgent,
    props,
    selectAndConfirmModel,
    selectAndConfirmReasoning,
    setActiveRightPanel,
    settingsModel,
    settingsProvider,
    settingsReasoning,
    sidePanelOpen,
    toggleSidePanel,
  } = useConversationViewScope();
  const runningTasks = () => props.tasks?.snapshot?.tasks.filter(isAgentTaskActive).length ?? 0;
  const working = () =>
    !props.prompt &&
    !props.approval &&
    !props.browserTakeover &&
    (agentActivity() === "Working" || props.tasks?.snapshot?.tasks.some((task) => task.state === "running") === true);
  return (
    <SharedConversationHeader
      agent={props.agent}
      working={working()}
      onSettingsIntent={() => void loadAgentSettingsPanel()}
      onOpenSettings={() => setActiveRightPanel("settings")}
      modelPicker={{
        provider: settingsProvider(),
        value: settingsModel(),
        reasoningEffort: settingsReasoning(),
        modelOptions: props.modelOptions,
        agentStatus: props.agentStatus,
        runtimeStatuses: props.providerRuntimeStatuses,
        customProviders: props.customProviders,
        customAgents: props.customAgents,
        onDownloadProvider: props.onDownloadProvider,
        onCancelProviderDownload: props.onCancelProviderDownload,
        onConnectProvider: props.onConnectProvider,
        canConnectProvider: props.canConnectProvider,
        onManageProviders: props.onManageProviders,
        modelChangesDisabled: agentActivity() === "Working",
        disabledReason:
          agentActivity() === "Working"
            ? t("conversation.header.modelsBusy")
            : t("conversation.header.modelsUnavailable"),
        accountChoice: true,
        providerAccountId: props.agent?.providerAccountId,
        onChange: (model, provider, accountId) => void selectAndConfirmModel(model, provider, accountId),
        onReasoningEffortChange: (effort) => void selectAndConfirmReasoning(effort),
      }}
      remoteControl={
        props.remoteDesktopEnabled !== false && props.server?.kind === "remote"
          ? {
              enabled: Boolean(props.remoteDesktopSessionActive || props.server.state === "online"),
              active: Boolean(props.remoteDesktopSessionActive),
              visible: Boolean(props.remoteDesktopVisible),
              onOpen: (trigger) => {
                if (props.server) void props.onOpenRemoteDesktop(props.server.id, trigger);
              },
            }
          : undefined
      }
      sidePanel={{
        open: sidePanelOpen(),
        actingAgentName: actingBrowserControl()
          ? (browserControlAgent()?.name ?? t("conversation.header.agentFallback"))
          : undefined,
        running: runningTasks(),
        onToggle: toggleSidePanel,
      }}
    />
  );
}
