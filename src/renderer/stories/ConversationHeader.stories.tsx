import { ConversationHeader } from "@openbot/ui/features/conversation/ConversationHeader";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_AGENT, STORY_AGENT_STATUS, STORY_MODELS } from "./fixtures";

const meta = {
  title: "Conversation/Header",
  component: ConversationHeader,
  args: {
    agent: STORY_AGENT,
    onSettingsIntent: fn(),
    onOpenSettings: fn(),
    modelPicker: {
      provider: STORY_AGENT.provider,
      value: STORY_AGENT.model,
      reasoningEffort: STORY_AGENT.reasoningEffort,
      modelOptions: STORY_MODELS,
      agentStatus: STORY_AGENT_STATUS,
      onChange: fn(),
      onReasoningEffortChange: fn(),
    },
    sidePanel: { open: false, running: 0, onToggle: fn() },
  },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof ConversationHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Working: Story = { args: { working: true } };
export const WaitingForInput: Story = { args: { working: false } };
export const WorkspaceOnly: Story = { args: { agent: { ...STORY_AGENT, access: "workspace" } } };
export const RemoteControl: Story = {
  args: { remoteControl: { enabled: true, active: true, visible: false, onOpen: fn() } },
};
export const OfflineHost: Story = {
  args: {
    remoteControl: { enabled: false, active: false, visible: false, onOpen: fn() },
  },
};
export const AgentUsingBrowser: Story = {
  args: { sidePanel: { open: true, actingAgentName: STORY_AGENT.name, running: 0, onToggle: fn() } },
};
export const TasksRunning: Story = {
  args: { working: true, sidePanel: { open: false, running: 2, onToggle: fn() } },
};
