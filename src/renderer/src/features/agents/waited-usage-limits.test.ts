import { describe, expect, it } from "vitest";
import { reconcileWaitedUsageLimits } from "./waited-usage-limits";

describe("reconcileWaitedUsageLimits", () => {
  it("drops a Wait dismissal when a probe needs attention after the user waited", () => {
    const next = reconcileWaitedUsageLimits(
      { "agent-1": 1_700_000_000 },
      { "agent-1": { resetsAt: 1_700_000_000, attention: false } },
      { "agent-1": { resetsAt: 1_700_000_000, attention: true } },
    );
    expect(next).toEqual({});
  });

  it("clears a prior attention hold from Wait dismissals when attention ends", () => {
    const next = reconcileWaitedUsageLimits(
      { "agent-1": 1_700_000_000 },
      { "agent-1": { resetsAt: 1_700_000_000, attention: true } },
      { "agent-1": { resetsAt: 1_700_000_000, attention: false } },
    );
    expect(next).toEqual({});
  });

  it("keeps a Wait dismissal while the same hold continues without attention", () => {
    const next = reconcileWaitedUsageLimits(
      { "agent-1": 1_700_000_000 },
      { "agent-1": { resetsAt: 1_700_000_000, attention: false } },
      { "agent-1": { resetsAt: 1_700_000_000, attention: false } },
    );
    expect(next).toEqual({ "agent-1": 1_700_000_000 });
  });

  it("drops dismissals for agents whose hold ended", () => {
    const next = reconcileWaitedUsageLimits({ "agent-1": 1_700_000_000 }, {}, {});
    expect(next).toEqual({});
  });
});
