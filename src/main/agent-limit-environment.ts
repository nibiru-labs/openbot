import { resolveAgentRosterLimit } from "@openbot/contracts/agent-roster-limits";

/**
 * The agent roster limit of this host, from `OPENBOT_AGENT_LIMIT`. The main process enforces it
 * where agents enter the host (imports and instance transfers); the default is
 * `INPUT_LIMITS.agents`.
 */
export function agentLimitForHost(): number {
  return resolveAgentRosterLimit(process.env.OPENBOT_AGENT_LIMIT);
}
