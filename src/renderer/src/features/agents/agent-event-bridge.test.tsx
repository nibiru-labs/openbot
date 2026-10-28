/**
 * AgentEventBridge integration tests for waited usage-limit reconciliation.
 * Run: `bun run test:desktop -- src/renderer/src/features/agents/agent-event-bridge.test.tsx`
 *
 * Mounts the real bridge and provider stack with a mocked `window.openbot` event stream.
 * UI checks stay in `UsageLimitAttention.test.tsx`; this file verifies bridge wiring, not the helper alone.
 */
import { isKnownAgentProvider } from "@openbot/contracts/agent-providers";
import type {
  AgentBackupModels,
  AgentModelChoice,
  AgentRuntimeSnapshot,
  ClientAgentSummary,
  ServerSummary,
} from "@openbot/contracts/ipc";
import {
  type BackupModelSource,
  UsageLimitAskCard,
  usageLimitAskOptions,
} from "@openbot/ui/features/conversation/BackupModels";
import { render, screen } from "@solidjs/testing-library";
import { createEffect, createMemo, type ParentProps, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnsweredPromptsProvider } from "../../answered-prompts";
import { I18nProvider } from "../../i18n-context";
import { LayoutProvider } from "../../layout";
import { NavigationProvider } from "../../navigation";
import { PlatformProvider } from "../../platform";
import { STORY_AGENT_SUMMARIES, STORY_MODELS, STORY_QUEUES, STORY_SERVERS } from "../../preview/fixtures";
import { createMockOpenBot, type MockOpenBotControls } from "../../preview/mock-openbot";
import { ProvidersProvider } from "../../providers";
import { TurnsProvider, useTurns } from "../../turns";
import { UiErrorsProvider } from "../../ui-errors";
import { AuthProvider } from "../account/account-context";
import { AgentTasksProvider } from "../agent-tasks/agent-tasks-context";
import { AgentThreadsProvider } from "../agent-threads/agent-threads-context";
import { BrowserTabsProvider } from "../browser/browser-context";
import { ChannelsProvider } from "../channels/channels-context";
import { ConversationProvider } from "../conversation/conversation-context";
import { createServerConversationState, createStableConversationState } from "../conversation/conversation-controller";
import { ConversationControllerProvider } from "../conversation/conversation-controller-context";
import { DirectMessagesProvider } from "../conversation/direct-messages-context";
import { shouldShowUsageLimitAsk } from "../conversation/usage-limit-ask";
import { CustomAgentsProvider } from "../custom-agents/custom-agents-context";
import { CustomProvidersProvider } from "../custom-providers/custom-providers-context";
import { ProviderDetectionProvider } from "../custom-providers/provider-detection-context";
import { DynamicIslandProvider } from "../dynamic-island/dynamic-island-context";
import { SetupProvider } from "../onboarding/onboarding-context";
import { RemoteDesktopProvider } from "../remote-desktop/remote-desktop-context";
import { ServerScopeProvider } from "../servers/server-scope";
import { ServerSelectionProvider } from "../servers/server-selection";
import { ServerSettingsProvider } from "../servers/server-settings";
import { ServerSwitchProvider } from "../servers/server-switch";
import { ServersProvider, useServers } from "../servers/servers-context";
import { SettingsProvider } from "../settings/settings-context";
import { SidebarProvider } from "../sidebar/sidebar-context";
import { PresenceProvider } from "../team/team-context";
import { UpdatesProvider } from "../updates/updates-context";
import { WhatsNewProvider } from "../updates/whats-new-context";
import { UsageProvider } from "../usage/usage-context";
import { WindowPageProvider } from "../window/window-page-context";
import { AgentActionsProvider } from "./agent-actions";
import { AgentEventBridge } from "./agent-event-bridge";
import { AgentReadTrackingProvider } from "./agent-read-tracking";
import { AgentsProvider, useAgents } from "./agents-context";

function requireFixture<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing fixture: ${label}`);
  return value;
}

const AGENT = requireFixture(STORY_AGENT_SUMMARIES[0], "chief agent");
const AGENT_ID = AGENT.id;
const RESETS_AT = 1_700_000_000;
const LOCAL_SERVER = STORY_SERVERS[0];
const REMOTE_SERVER: ServerSummary = { ...requireFixture(STORY_SERVERS[1], "remote server"), active: true };
const EMPTY_DRAFTS = { agents: {}, channels: {} } as const;
const BACKUP_ORDER: AgentBackupModels = {
  automatic: false,
  order: [{ provider: "claude", model: "claude-sonnet-5" }],
};

function runtimeSnapshot(
  usageLimits: AgentRuntimeSnapshot["usageLimits"],
  usageLimitedModels: AgentRuntimeSnapshot["usageLimitedModels"] = [],
): AgentRuntimeSnapshot {
  return {
    contextStates: [],
    agents: [
      {
        id: AGENT_ID,
        name: AGENT.name,
        notifications: AGENT.notifications,
        preview: AGENT.preview,
        updatedAt: AGENT.updatedAt,
        avatarSeed: AGENT.avatarSeed,
        avatarHue: AGENT.avatarHue ?? null,
        avatarUrl: AGENT.avatarUrl ?? null,
      },
    ],
    activeTurns: [],
    work: [],
    latestMessages: [],
    attentionComplete: true,
    pendingPrompts: [],
    pendingApprovals: [],
    pendingBrowserTakeovers: [],
    failedTurns: [],
    usageLimits,
    usageLimitedModels,
  };
}

function TurnsProbe(props: { controls: MountResult }) {
  const { waitedUsageLimits, usageLimits, setWaitedUsageLimits } = useTurns();
  createEffect(
    () => [waitedUsageLimits(), usageLimits()],
    () => {
      props.controls.readWaited = waitedUsageLimits;
      props.controls.readLimits = usageLimits;
      props.controls.setWaited = setWaitedUsageLimits;
    },
  );
  return null;
}

function UsageLimitAskProbe() {
  const { activeAgent, modelOptions, agentStatus } = useAgents();
  const { activeServer } = useServers();
  const { usageLimits, usageLimitedModels, waitedUsageLimits, queues } = useTurns();
  const usageLimited = (choice: { provider: string; model: string }) =>
    usageLimitedModels().some((limited) => limited.provider === choice.provider && limited.model === choice.model);
  const usageLimitAsk = createMemo((): Parameters<typeof UsageLimitAskCard>[0] | undefined => {
    const agent = activeAgent();
    const limit = agent ? usageLimits()[agent.id] : undefined;
    const resetsAt = limit?.resetsAt ?? null;
    const waited = agent ? waitedUsageLimits() : {};
    const waitedDismissed = Boolean(
      limit && !limit.attention && agent && agent.id in waited && waited[agent.id] === resetsAt,
    );
    const hasQueuedMessage = Boolean(
      agent && queues()[agent.id]?.deliveries.some((delivery) => delivery.status === "queued"),
    );
    const provider = agent?.provider;
    const source: BackupModelSource = {
      modelOptions: modelOptions(),
      providers: agentStatus().providers,
      limited: usageLimited,
    };
    const options =
      agent && provider && isKnownAgentProvider(provider)
        ? usageLimitAskOptions({ ...agent, provider }, agent.backupModels, source)
        : [];
    if (
      !shouldShowUsageLimitAsk({
        serverKind: activeServer()?.kind,
        agent,
        limit,
        waitedDismissed,
        hasQueuedMessage,
        readyOptions: options,
      })
    )
      return undefined;
    if (!agent || !provider || !limit || !isKnownAgentProvider(provider)) return undefined;
    return {
      provider,
      resetsAt,
      attention: limit.attention,
      hasQueuedMessage,
      options,
      onSend: vi.fn(async () => undefined),
      onWait: vi.fn(),
    };
  });
  return <Show when={usageLimitAsk()}>{(ask) => <UsageLimitAskCard {...ask()} />}</Show>;
}

function ScopedBridgeProviders(props: ParentProps) {
  const conversationController = {
    ...createStableConversationState({ onTypingChange: () => undefined }, false, EMPTY_DRAFTS),
    ...createServerConversationState(),
  };
  return (
    <ConversationControllerProvider controller={conversationController}>
      <PresenceProvider>
        <DirectMessagesProvider>
          <AgentsProvider>
            <ChannelsProvider>
              <ProvidersProvider>
                <TurnsProvider>
                  <AgentTasksProvider>
                    <AgentThreadsProvider>
                      <ConversationProvider>
                        <BrowserTabsProvider>
                          <SidebarProvider>
                            <NavigationProvider>
                              <ServerSelectionProvider>
                                <AgentActionsProvider>
                                  <ServerScopeProvider>
                                    <AgentEventBridge />
                                    {props.children}
                                  </ServerScopeProvider>
                                </AgentActionsProvider>
                              </ServerSelectionProvider>
                            </NavigationProvider>
                          </SidebarProvider>
                        </BrowserTabsProvider>
                      </ConversationProvider>
                    </AgentThreadsProvider>
                  </AgentTasksProvider>
                </TurnsProvider>
              </ProvidersProvider>
            </ChannelsProvider>
          </AgentsProvider>
        </DirectMessagesProvider>
      </PresenceProvider>
    </ConversationControllerProvider>
  );
}

function BridgeServerScope(props: ParentProps) {
  const { activeServerId } = useServers();
  return (
    <Show keyed when={activeServerId()}>
      <ScopedBridgeProviders>{props.children}</ScopedBridgeProviders>
    </Show>
  );
}

function BridgeTestRoot(props: ParentProps) {
  return (
    <PlatformProvider>
      <I18nProvider>
        <AuthProvider>
          <SetupProvider>
            <WhatsNewProvider>
              <SettingsProvider>
                <LayoutProvider>
                  <UpdatesProvider>
                    <CustomProvidersProvider>
                      <CustomAgentsProvider>
                        <ProviderDetectionProvider>
                          <ServersProvider>
                            <DynamicIslandProvider>
                              <ServerSettingsProvider>
                                <RemoteDesktopProvider>
                                  <ServerSwitchProvider>
                                    <AnsweredPromptsProvider>
                                      <UiErrorsProvider>
                                        <UsageProvider>
                                          <WindowPageProvider>
                                            <AgentReadTrackingProvider>
                                              <BridgeServerScope>{props.children}</BridgeServerScope>
                                            </AgentReadTrackingProvider>
                                          </WindowPageProvider>
                                        </UsageProvider>
                                      </UiErrorsProvider>
                                    </AnsweredPromptsProvider>
                                  </ServerSwitchProvider>
                                </RemoteDesktopProvider>
                              </ServerSettingsProvider>
                            </DynamicIslandProvider>
                          </ServersProvider>
                        </ProviderDetectionProvider>
                      </CustomAgentsProvider>
                    </CustomProvidersProvider>
                  </UpdatesProvider>
                </LayoutProvider>
              </SettingsProvider>
            </WhatsNewProvider>
          </SetupProvider>
        </AuthProvider>
      </I18nProvider>
    </PlatformProvider>
  );
}

interface MountOptions {
  runtimeSnapshot: AgentRuntimeSnapshot;
  servers?: ServerSummary[];
  agents?: ClientAgentSummary[];
  queued?: boolean;
}

interface MountResult {
  mock: MockOpenBotControls;
  readWaited: () => Record<string, number | null>;
  readLimits: () => Record<string, { resetsAt: number | null; attention?: boolean }>;
  setWaited: ReturnType<typeof useTurns>["setWaitedUsageLimits"];
}

function emptyMountResult(mock: MockOpenBotControls): MountResult {
  return {
    mock,
    readWaited: () => ({}),
    readLimits: () => ({}),
    setWaited: () => undefined,
  };
}

let activeMock: MockOpenBotControls | undefined;
let previousOpenBot: typeof window.openbot | undefined;

async function mountBridge(options: MountOptions): Promise<MountResult> {
  previousOpenBot = window.openbot;
  const mock = createMockOpenBot({
    runtimeSnapshot: options.runtimeSnapshot,
    servers: options.servers ?? [LOCAL_SERVER],
    agents: options.agents ?? [{ ...AGENT, backupModels: BACKUP_ORDER }],
    models: STORY_MODELS,
    queues: options.queued ? { [AGENT_ID]: STORY_QUEUES[AGENT_ID] ?? [] } : undefined,
  });
  window.openbot = mock.api;
  activeMock = mock;
  const controls = emptyMountResult(mock);
  render(() => (
    <BridgeTestRoot>
      <TurnsProbe controls={controls} />
      <UsageLimitAskProbe />
    </BridgeTestRoot>
  ));
  await vi.waitFor(() => expect(controls.readLimits()[AGENT_ID]).toBeDefined());
  return controls;
}

describe("AgentEventBridge waited usage limits", () => {
  afterEach(() => {
    activeMock?.dispose();
    activeMock = undefined;
    if (previousOpenBot !== undefined) window.openbot = previousOpenBot;
    previousOpenBot = undefined;
  });

  it("keeps a Wait dismissal while the same hold continues without attention", async () => {
    const hold = [{ agentId: AGENT_ID, resetsAt: RESETS_AT, attention: false }];
    const bridge = await mountBridge({
      runtimeSnapshot: runtimeSnapshot(hold),
      queued: true,
    });
    bridge.setWaited({ [AGENT_ID]: RESETS_AT });
    await vi.waitFor(() => expect(bridge.readWaited()[AGENT_ID]).toBe(RESETS_AT));

    bridge.mock.setRuntimeSnapshot(runtimeSnapshot(hold));

    await vi.waitFor(() => expect(bridge.readWaited()[AGENT_ID]).toBe(RESETS_AT));
    expect(screen.queryByText("Message on hold")).toBeNull();
  });

  it("clears a Wait dismissal when the hold ends", async () => {
    const bridge = await mountBridge({
      runtimeSnapshot: runtimeSnapshot([{ agentId: AGENT_ID, resetsAt: RESETS_AT, attention: false }]),
      queued: true,
    });
    bridge.setWaited({ [AGENT_ID]: RESETS_AT });
    await vi.waitFor(() => expect(bridge.readWaited()[AGENT_ID]).toBe(RESETS_AT));

    bridge.mock.setRuntimeSnapshot(runtimeSnapshot([]));

    await vi.waitFor(() => expect(bridge.readWaited()).toEqual({}));
    expect(bridge.readLimits()[AGENT_ID]).toBeUndefined();
  });

  it("clears a Wait dismissal when a probe needs attention", async () => {
    const bridge = await mountBridge({
      runtimeSnapshot: runtimeSnapshot([{ agentId: AGENT_ID, resetsAt: RESETS_AT, attention: false }]),
      queued: true,
    });
    bridge.setWaited({ [AGENT_ID]: RESETS_AT });
    await vi.waitFor(() => expect(screen.queryByText("Message on hold")).toBeNull());

    bridge.mock.setRuntimeSnapshot(runtimeSnapshot([{ agentId: AGENT_ID, resetsAt: RESETS_AT, attention: true }]));

    await vi.waitFor(() => expect(bridge.readWaited()[AGENT_ID]).toBeUndefined());
    await screen.findByText("Needs attention");
    expect(screen.queryByRole("button", { name: "Wait for the reset" })).toBeNull();
  });

  it("shows attention with no backup actions after the bridge clears a Wait dismissal", async () => {
    const limited: AgentModelChoice[] = STORY_MODELS.flatMap((model) =>
      isKnownAgentProvider(model.provider) ? [{ provider: model.provider, model: model.id }] : [],
    );
    const bridge = await mountBridge({
      runtimeSnapshot: runtimeSnapshot([{ agentId: AGENT_ID, resetsAt: null, attention: false }], limited),
      queued: true,
    });
    bridge.setWaited({ [AGENT_ID]: null });
    await vi.waitFor(() => expect(screen.queryByText("Needs attention")).toBeNull());

    bridge.mock.setRuntimeSnapshot(runtimeSnapshot([{ agentId: AGENT_ID, resetsAt: null, attention: true }], limited));

    await screen.findByText("Needs attention");
    expect(screen.queryAllByRole("button", { name: /Send to / })).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Wait for the reset" })).toBeNull();
  });

  it("does not show the usage-limit ask on a joined Team API host", async () => {
    const bridge = await mountBridge({
      servers: [REMOTE_SERVER],
      runtimeSnapshot: runtimeSnapshot([{ agentId: AGENT_ID, resetsAt: null, attention: true }]),
    });

    await vi.waitFor(() => expect(bridge.readLimits()[AGENT_ID]?.attention).toBe(true));
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.queryByText("Message on hold")).toBeNull();
  });
});
