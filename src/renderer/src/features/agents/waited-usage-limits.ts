/** A provider plan hold on one agent, as the runtime snapshot reports it. */
export interface UsageLimitHold {
  resetsAt: number | null;
  attention?: boolean;
}

/**
 * Keeps or drops each agent's "Wait" dismissal when usage limits change.
 *
 * A hold that ended drops its dismissal. A probe that needs attention, or one that did before,
 * clears the dismissal so the ask card can return.
 */
export function reconcileWaitedUsageLimits(
  current: Record<string, number | null>,
  prevLimits: Record<string, UsageLimitHold | undefined>,
  nextLimits: Record<string, UsageLimitHold | undefined>,
): Record<string, number | null> {
  const kept = Object.fromEntries(Object.entries(current).filter(([agentId]) => agentId in nextLimits));
  for (const [agentId, limit] of Object.entries(nextLimits)) {
    if (limit?.attention || prevLimits[agentId]?.attention) delete kept[agentId];
  }
  return kept;
}
