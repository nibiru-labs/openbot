import { resolveAgentRosterLimit } from "@openbot/contracts/agent-roster-limits";

/**
 * The agent roster limit of this host, from `OPENBOT_AGENT_LIMIT`. Read at each admission so the
 * value the process started with is the value that applies; the default is `INPUT_LIMITS.agents`.
 */
export function agentRosterLimit(): number {
  return resolveAgentRosterLimit(process.env.OPENBOT_AGENT_LIMIT);
}
