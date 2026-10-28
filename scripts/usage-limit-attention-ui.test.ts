import { createFormat, translateFor } from "@openbot/i18n";
import { usageLimitAskOptions } from "@openbot/ui/features/conversation/BackupModels";
import { sidebarAgentWait } from "@openbot/ui/features/sidebar/sidebar-agent-states";
import { sidebarAgentStateLabel } from "@openbot/ui/features/sidebar/sidebar-filtering";
import { describe, expect, it } from "vitest";

const t = translateFor("en");
const format = createFormat("en");

describe("usage limit attention presentation", () => {
  it("names a probe attention hold in the sidebar", () => {
    const wait = sidebarAgentWait("agent-1", {
      pendingPrompts: {},
      pendingApprovals: {},
      usageLimits: { "agent-1": { resetsAt: null, attention: true } },
    });
    expect(wait).toEqual({ kind: "limited", resetsAt: null, attention: true });
    if (!wait) throw new Error("expected a limited wait");
    expect(sidebarAgentStateLabel(wait, t, format)).toBe("Usage limit needs your attention");
  });

  it("keeps a normal limit wait separate from attention", () => {
    const wait = sidebarAgentWait("agent-1", {
      pendingPrompts: {},
      pendingApprovals: {},
      usageLimits: { "agent-1": { resetsAt: 1_700_000_000, attention: false } },
    });
    expect(wait?.kind).toBe("limited");
    expect(wait && "attention" in wait && wait.attention).not.toBe(true);
  });

  it("offers no ready backup option when every model is limited", () => {
    const own = { provider: "claude" as const, model: "claude-opus-5-5" };
    const options = usageLimitAskOptions(
      own,
      { automatic: false, order: [{ provider: "codex", model: "gpt-6-luna" }] },
      {
        modelOptions: [
          {
            provider: "codex",
            id: "gpt-6-luna",
            name: "GPT-6 Luna",
            description: "",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["medium"],
          },
        ],
        providers: [{ id: "codex", state: "available", version: "1.0.0", message: null }],
        limited: () => true,
      },
    );
    expect(options).toEqual([]);
  });
});
