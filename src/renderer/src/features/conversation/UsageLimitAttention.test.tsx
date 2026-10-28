/**
 * jsdom checks for usage-limit attention UI. Run in the renderer Vitest project:
 * `bun run test:desktop -- src/renderer/src/features/conversation/UsageLimitAttention.test.tsx`
 *
 * Source resolution: `@openbot/ui` resolves to this worktree's `packages/ui`. Most other
 * dependencies resolve through symlinked `node_modules` to the main checkout; Vitest loads this
 * worktree's `vitest.config.ts`. UI checks belong here, not under `scripts/*.test.ts` (node
 * project): that path failed to load Solid/Vite setup reliably in linked worktrees.
 * `resolve.preserveSymlinks` breaks `@testing-library/jest-dom` imports and is not enabled.
 * Electron and Storybook are not run here.
 */
import type { AgentBackupModels, AgentStatus, ClientAgentModelOption } from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import { AwaitingReplies } from "@openbot/ui/features/conversation/AwaitingReplies";
import { UsageLimitAskCard, usageLimitAskOptions } from "@openbot/ui/features/conversation/BackupModels";
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

const CHIEF = {
  id: "chief",
  name: "Chief",
  title: "",
  description: "",
  notifications: true,
  provider: "codex",
  model: "gpt-6-luna",
  reasoningEffort: "medium",
  threadId: "thread-chief",
  avatarSeed: "chief",
  avatarHue: 245,
  avatarUrl: null,
  time: "2026-08-19T10:00:00.000Z",
  preview: "",
} satisfies AgentProfile;

const RESETS_AT = Date.UTC(2026, 8, 21, 9, 0) / 1_000;
const OWN = { provider: "claude" as const, model: "claude-opus-5-5" };
const ORDER: AgentBackupModels = {
  automatic: false,
  order: [
    { provider: "codex", model: "gpt-6-luna" },
    { provider: "claude", model: "claude-sonnet-5" },
  ],
};
const MODELS: ClientAgentModelOption[] = [
  {
    provider: "codex",
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    description: "",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium"],
  },
  {
    provider: "claude",
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    description: "",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium"],
  },
  {
    provider: "claude",
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    description: "",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium"],
  },
];
const STATUS = {
  phase: "ready",
  cliVersion: "1.0.0",
  auth: { kind: "chatgpt", email: "person@example.com" },
  capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
  message: null,
  fullAccess: true,
  providers: [{ id: "codex", state: "available", version: "1.0.0", message: null }],
} satisfies AgentStatus;
const SOURCE = {
  modelOptions: MODELS,
  providers: STATUS.providers,
  limited: (choice: { provider: string; model: string }) =>
    choice.provider === OWN.provider && choice.model === OWN.model,
};

describe("UsageLimitAskCard", () => {
  it("offers Wait on a normal hold and labels the send target", async () => {
    const options = usageLimitAskOptions(OWN, ORDER, SOURCE);
    expect(options[0]?.model).toBe("GPT-6 Luna");
    render(() => (
      <UsageLimitAskCard
        provider="claude"
        resetsAt={RESETS_AT}
        options={options}
        onSend={vi.fn(async () => undefined)}
        onWait={vi.fn()}
      />
    ));

    await screen.findByRole("button", { name: "Wait for the reset" });
    await screen.findByText("GPT-6 Luna");
    await screen.findByText("Message on hold");
  });

  it("hides Wait and names attention when a probe needs the user", async () => {
    render(() => (
      <UsageLimitAskCard
        provider="claude"
        resetsAt={RESETS_AT}
        attention
        options={usageLimitAskOptions(OWN, ORDER, SOURCE)}
        onSend={vi.fn(async () => undefined)}
        onWait={vi.fn()}
      />
    ));

    expect(screen.queryByRole("button", { name: "Wait for the reset" })).toBeNull();
    await screen.findByText("Needs attention");
    await screen.findByRole("button", { name: /Switch to GPT-6 Luna/ });
  });

  it("shows attention with no backup actions when every model is limited", async () => {
    const limitedSource = { ...SOURCE, limited: () => true };
    expect(usageLimitAskOptions(OWN, ORDER, limitedSource)).toEqual([]);

    render(() => (
      <UsageLimitAskCard
        provider="claude"
        resetsAt={RESETS_AT}
        attention
        options={[]}
        onSend={vi.fn(async () => undefined)}
        onWait={vi.fn()}
      />
    ));

    expect(screen.queryByRole("button", { name: /Send to / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Wait for the reset" })).toBeNull();
    await screen.findByText("Needs attention");
  });
});

describe("AwaitingReplies usage-limit attention", () => {
  it("offers a Review action with an accessible name", async () => {
    render(() => (
      <AwaitingReplies
        items={[
          {
            id: "reply-1",
            agent: CHIEF,
            name: "Chief",
            state: "working",
            wait: { kind: "limited", resetsAt: null, attention: true },
          },
        ]}
        onOpenAgent={vi.fn()}
      />
    ));

    await screen.findByRole("button", { name: /Review/ });
    await screen.findByText("Usage limit needs your attention");
  });
});
