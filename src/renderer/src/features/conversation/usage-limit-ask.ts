import { type AgentProviderRef, isKnownAgentProvider } from "@openbot/contracts/agent-providers";
import { type AgentBackupModels, sameAgentModelChoice } from "@openbot/contracts/ipc";
import type { BackupModelOption } from "@openbot/ui/features/conversation/BackupModels";
import type { UsageLimitHold } from "../agents/waited-usage-limits";

export interface UsageLimitAskVisibilityInput {
  serverKind: "local" | "remote" | undefined;
  agent:
    | {
        id: string;
        provider: AgentProviderRef;
        backupModels?: AgentBackupModels | null;
      }
    | undefined;
  limit: UsageLimitHold | undefined;
  /** True when the user chose Wait for this hold's reset time. */
  waitedDismissed: boolean;
  hasQueuedMessage: boolean;
  readyOptions: readonly BackupModelOption[];
}

/** Whether the chat should show the usage-limit ask card for the active agent. Local only. */
export function shouldShowUsageLimitAsk(input: UsageLimitAskVisibilityInput): boolean {
  const agent = input.agent;
  if (!agent || input.serverKind !== "local" || !isKnownAgentProvider(agent.provider)) return false;
  const limit = input.limit;
  if (!limit) return false;
  if (!limit.attention && input.waitedDismissed) return false;
  if (!input.hasQueuedMessage && !limit.attention) return false;
  if (input.readyOptions.length === 0 && !limit.attention) return false;
  const backupModels = agent.backupModels;
  if (
    !limit.attention &&
    backupModels?.automatic &&
    backupModels.order.some((choice) =>
      input.readyOptions.some((option) => sameAgentModelChoice(option.choice, choice)),
    )
  )
    return false;
  return true;
}
