import { INPUT_LIMITS } from "./input-limits";

/**
 * The most agents one host may hold, however its roster limit is configured. Payload shapes that
 * carry a whole roster (state snapshots, import and transfer previews) are bounded by this value,
 * not by the default limit: they have to stay decodable on a host that raised its own limit.
 * Admission is a separate question, answered by {@link resolveAgentRosterLimit} where agents are
 * actually created or imported.
 */
export const AGENT_ROSTER_MAX_LIMIT = 1_000;

/**
 * Resolve the agent roster limit of one host from the raw `OPENBOT_AGENT_LIMIT` value. The default
 * is `INPUT_LIMITS.agents`; a positive integer raises (or lowers) it for a local or self-hosted
 * instance, clamped to {@link AGENT_ROSTER_MAX_LIMIT}. An unset or unreadable value keeps the
 * default, so a typo can never leave a host unable to create agents at all.
 */
export function resolveAgentRosterLimit(rawValue: string | undefined): number {
  if (rawValue === undefined) return INPUT_LIMITS.agents;
  const parsed = Number(rawValue.trim());
  if (!Number.isInteger(parsed) || parsed < 1) return INPUT_LIMITS.agents;
  return Math.min(parsed, AGENT_ROSTER_MAX_LIMIT);
}
