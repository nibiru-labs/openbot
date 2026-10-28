import type { AgentModelChoice } from "@openbot/contracts/ipc";
import type { BackupModelOption } from "@openbot/ui/features/conversation/BackupModels";
import { describe, expect, it } from "vitest";
import type { UsageLimitHold } from "../agents/waited-usage-limits";
import { shouldShowUsageLimitAsk } from "./usage-limit-ask";

const AGENT = { id: "agent-1", provider: "claude" as const, backupModels: null };
const LIMIT: UsageLimitHold = { resetsAt: 1_700_000_000, attention: false };
const READY: BackupModelOption = {
  key: "codex\u0000default\u0000gpt-6-luna",
  choice: { provider: "codex", model: "gpt-6-luna" },
  model: "GPT-6 Luna",
  account: null,
  state: "ready",
};

describe("shouldShowUsageLimitAsk", () => {
  it("shows nothing on a joined Team API host", () => {
    expect(
      shouldShowUsageLimitAsk({
        serverKind: "remote",
        agent: AGENT,
        limit: LIMIT,
        waitedDismissed: false,
        hasQueuedMessage: true,
        readyOptions: [READY],
      }),
    ).toBe(false);
  });

  it("hides the ask after Wait for the same reset time", () => {
    expect(
      shouldShowUsageLimitAsk({
        serverKind: "local",
        agent: AGENT,
        limit: LIMIT,
        waitedDismissed: true,
        hasQueuedMessage: true,
        readyOptions: [READY],
      }),
    ).toBe(false);
  });

  it("shows attention after Wait even without a queued message", () => {
    expect(
      shouldShowUsageLimitAsk({
        serverKind: "local",
        agent: AGENT,
        limit: { resetsAt: null, attention: true },
        waitedDismissed: true,
        hasQueuedMessage: false,
        readyOptions: [],
      }),
    ).toBe(true);
  });

  it("shows attention when every backup model is limited", () => {
    expect(
      shouldShowUsageLimitAsk({
        serverKind: "local",
        agent: AGENT,
        limit: { resetsAt: null, attention: true },
        waitedDismissed: false,
        hasQueuedMessage: false,
        readyOptions: [],
      }),
    ).toBe(true);
  });

  it("hides the ask when automatic failover can run a saved ready model", () => {
    const choice: AgentModelChoice = { provider: "codex", model: "gpt-6-luna" };
    expect(
      shouldShowUsageLimitAsk({
        serverKind: "local",
        agent: { ...AGENT, backupModels: { automatic: true, order: [choice] } },
        limit: LIMIT,
        waitedDismissed: false,
        hasQueuedMessage: true,
        readyOptions: [{ ...READY, choice }],
      }),
    ).toBe(false);
  });
});
