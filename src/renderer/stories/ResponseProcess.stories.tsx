import { Button } from "@openbot/ui";
import type { AgentMessage } from "@openbot/ui/data";
import { ResponseProcess } from "@openbot/ui/features/conversation/ResponseProcess";
import { createStore } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const message: AgentMessage = {
  id: "thinking:turn-process",
  turnId: "turn-process",
  author: "agent",
  body: "",
  time: "10:01",
  kind: "thinking",
  items: ["Read the project brief.", "Compare the available options."],
  streaming: false,
};

const meta = {
  title: "Conversation/Response process",
  component: ResponseProcess,
  args: { message },
  render: (args) => (
    <main style={{ width: "min(560px, 100vw)", padding: "var(--openbot-space-4)" }}>
      <ResponseProcess {...args} />
    </main>
  ),
  parameters: { layout: "centered", a11y: { test: "error" } },
} satisfies Meta<typeof ResponseProcess>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {};
export const Completed: Story = { args: { defaultOpen: true, message: { ...message, status: "completed" } } };
export const Interrupted: Story = { args: { message: { ...message, status: "interrupted" } } };
export const Failed: Story = { args: { message: { ...message, status: "failed" } } };
export const Empty: Story = { args: { defaultOpen: true, message: { ...message, items: [] } } };
export const LongNotes: Story = {
  args: {
    defaultOpen: true,
    message: { ...message, items: ["Read each source and compare the results.\n".repeat(12)] },
  },
};

/** Update streamed notes and end the turn without closing its process. */
export const Live: Story = {
  render: () => {
    const [state, setState] = createStore({ message: { ...message, streaming: true } });
    return (
      <main class="grid gap-4 p-4" style={{ width: "min(560px, 100vw)" }}>
        <ResponseProcess message={state.message} />
        <div class="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              setState((draft) => {
                draft.message.items = ["Read the project brief.", "Compare the available options. Check the costs."];
              })
            }
          >
            Update note
          </Button>
          <Button
            onClick={() =>
              setState((draft) => {
                draft.message.items = [...(draft.message.items ?? []), "Select the option with the lowest cost."];
              })
            }
          >
            Add note
          </Button>
          <Button
            onClick={() =>
              setState((draft) => {
                draft.message.streaming = false;
                draft.message.status = "completed";
              })
            }
          >
            End turn
          </Button>
        </div>
      </main>
    );
  },
};
