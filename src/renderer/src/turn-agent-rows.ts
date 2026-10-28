import type { AgentContextState, AgentWaitsSnapshot, QueueSnapshot } from "@openbot/contracts/ipc";

/** Per-agent turn runtime fields that used to live in separate keyed records. */
export interface AgentTurnRow {
  activeTurn?: string | null;
  turnProgress?: { turnId: string; detail: string };
  failedTurn?: string;
  contextState?: AgentContextState;
  usageLimit?: number | null;
  waitedUsageLimit?: number | null;
  queue?: QueueSnapshot;
  waits?: AgentWaitsSnapshot;
}

export interface TurnRowSeed {
  activeTurns?: Record<string, string | null>;
  turnProgress?: Record<string, { turnId: string; detail: string } | undefined>;
  failedTurns?: Record<string, string | undefined>;
  queues?: Record<string, QueueSnapshot>;
}

export function seedAgentTurnRows(seed: TurnRowSeed | null | undefined): Record<string, AgentTurnRow> {
  if (!seed) return {};
  const rows: Record<string, AgentTurnRow> = {};
  for (const [agentId, activeTurn] of Object.entries(seed.activeTurns ?? {})) {
    rows[agentId] = { ...rows[agentId], activeTurn };
  }
  for (const [agentId, turnProgress] of Object.entries(seed.turnProgress ?? {})) {
    if (turnProgress) rows[agentId] = { ...rows[agentId], turnProgress };
  }
  for (const [agentId, failedTurn] of Object.entries(seed.failedTurns ?? {})) {
    if (failedTurn) rows[agentId] = { ...rows[agentId], failedTurn };
  }
  for (const [agentId, queue] of Object.entries(seed.queues ?? {})) {
    rows[agentId] = { ...rows[agentId], queue };
  }
  return rows;
}

export function agentTurnFieldRecord<K extends keyof AgentTurnRow>(
  rows: Record<string, AgentTurnRow>,
  field: K,
): Record<string, NonNullable<AgentTurnRow[K]>> {
  const record: Record<string, NonNullable<AgentTurnRow[K]>> = {};
  for (const [agentId, row] of Object.entries(rows)) {
    const value = row[field];
    if (value !== undefined) record[agentId] = value;
  }
  return record;
}

export function withoutAgentRow<T>(rows: Record<string, T>, agentId: string): Record<string, T> {
  if (!(agentId in rows)) return rows;
  const next = { ...rows };
  delete next[agentId];
  return next;
}
