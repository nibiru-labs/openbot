import { INPUT_LIMITS } from "./input-limits";
import { isDynamicRecord, isOneOf, isString } from "./runtime-values";

export type AgentMemoryOrigin = "automatic" | "manual";

/**
 * The part of a memory that does not name its owner. One store and one panel serve both an agent
 * and a channel, and this is the shape they share; `AgentMemory` and `ChannelMemory` only add the
 * owner id. Neither of those two names changes shape.
 */
export interface MemoryEntry {
  id: string;
  text: string;
  origin: AgentMemoryOrigin;
  sourceTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMemory extends MemoryEntry {
  agentId: string;
}

export function isMemoryEntry(value: unknown): value is MemoryEntry {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    value.id.length > 0 &&
    value.id.length <= INPUT_LIMITS.identifier &&
    isString(value.text) &&
    value.text.length > 0 &&
    value.text.length <= INPUT_LIMITS.agentMemoryText &&
    isOneOf(["automatic", "manual"] as const, value.origin) &&
    (value.sourceTurnId === null ||
      (isString(value.sourceTurnId) &&
        value.sourceTurnId.length > 0 &&
        value.sourceTurnId.length <= INPUT_LIMITS.identifier)) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

export function isAgentMemory(value: unknown): value is AgentMemory {
  return (
    isDynamicRecord(value) &&
    isMemoryEntry(value) &&
    isString(value.agentId) &&
    value.agentId.length > 0 &&
    value.agentId.length <= INPUT_LIMITS.identifier
  );
}

export interface CreateAgentMemoryInput {
  agentId: string;
  text: string;
}

export interface UpdateAgentMemoryInput {
  agentId: string;
  memoryId: string;
  text: string;
}

export interface DeleteAgentMemoryInput {
  agentId: string;
  memoryId: string;
}

/**
 * The choices for how many memories one agent can hold on this computer. The first is the default,
 * which was the only cap before the setting existed. A lower cap never deletes memories: an agent
 * over it keeps them and only cannot add another.
 */
export const AGENT_MEMORY_LIMITS = [INPUT_LIMITS.agentMemories, 128, 256, 512] as const;
export type AgentMemoryLimit = (typeof AGENT_MEMORY_LIMITS)[number];
export const DEFAULT_AGENT_MEMORY_LIMIT: AgentMemoryLimit = INPUT_LIMITS.agentMemories;

export function isAgentMemoryLimit(value: unknown): value is AgentMemoryLimit {
  return isOneOf(AGENT_MEMORY_LIMITS, value);
}

/** The app setting, as it is stored and as it crosses IPC. */
export interface AgentMemoryLimitPreference {
  limit: AgentMemoryLimit;
}

/**
 * Where an agent's memory lives. `openbot` is the built-in store: essential memories go into the
 * prompt and the memory tools are offered. `off` turns the built-in store off for the agent: no
 * saved-memory block goes into the prompt and no memory tool is offered or runs. Entries already
 * stored stay in the database untouched, so the source can be turned back on.
 */
export const AGENT_MEMORY_SOURCES = ["openbot", "off"] as const;
export type AgentMemorySource = (typeof AGENT_MEMORY_SOURCES)[number];
export const DEFAULT_AGENT_MEMORY_SOURCE: AgentMemorySource = "openbot";

export function isAgentMemorySource(value: unknown): value is AgentMemorySource {
  return isOneOf(AGENT_MEMORY_SOURCES, value);
}

/** The app setting for the memory source, as it is stored and as it crosses IPC. */
export interface AgentMemorySourcePreference {
  source: AgentMemorySource;
}

/**
 * The memory source that applies to an agent: its own value when it has one, the app setting
 * otherwise. Local-only, like the other agent fields that follow an account default.
 */
export function agentMemorySource(
  agent: { memorySource?: AgentMemorySource | undefined },
  appSource: AgentMemorySource,
): AgentMemorySource {
  return agent.memorySource ?? appSource;
}

/**
 * The limit of one server's agents (`agent-memory-limit-v1`) and the values that host permits. A
 * newer host can permit other values, so they are numbers here, not `AgentMemoryLimit`.
 */
export interface HostAgentMemoryLimit {
  limit: number;
  choices: number[];
}

export function hostAgentMemoryLimit({ limit }: AgentMemoryLimitPreference): HostAgentMemoryLimit {
  return { limit, choices: [...AGENT_MEMORY_LIMITS] };
}

/** On the wire the route codec has already checked the fields; this fails closed on anything else. */
export function decodeHostAgentMemoryLimit(value: unknown): HostAgentMemoryLimit {
  const count = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item) && item > 0;
  if (!isDynamicRecord(value) || !count(value.limit) || !Array.isArray(value.choices) || !value.choices.every(count))
    throw new Error("Invalid agent memory limit.");
  return { limit: value.limit, choices: [...value.choices] };
}

/** Selection metadata stays separate from the released memory shape. */
export interface AgentMemorySelection {
  memoryId: string;
  inclusion: "essential" | "searchable";
  userControlled: boolean;
  revision: number;
}

export interface AgentMemorySelectionChange {
  memoryId: string;
  inclusion: "essential" | "searchable" | "automatic";
  expectedRevision: number;
}

export interface AgentMemorySelectionState {
  selections: AgentMemorySelection[];
  usedBytes: number;
  budgetBytes: number;
}

export interface SetAgentMemoryInclusionInput {
  agentId: string;
  changes: AgentMemorySelectionChange[];
}

export function isAgentMemorySelection(value: unknown): value is AgentMemorySelection {
  return (
    isDynamicRecord(value) &&
    isString(value.memoryId) &&
    value.memoryId.length > 0 &&
    value.memoryId.length <= INPUT_LIMITS.identifier &&
    isOneOf(["essential", "searchable"] as const, value.inclusion) &&
    typeof value.userControlled === "boolean" &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
  );
}

export function isAgentMemorySelectionState(value: unknown): value is AgentMemorySelectionState {
  return (
    isDynamicRecord(value) &&
    Array.isArray(value.selections) &&
    value.selections.every(isAgentMemorySelection) &&
    new Set(value.selections.map((entry) => entry.memoryId)).size === value.selections.length &&
    typeof value.usedBytes === "number" &&
    Number.isSafeInteger(value.usedBytes) &&
    value.usedBytes >= 0 &&
    value.budgetBytes === 8192 &&
    value.usedBytes <= value.budgetBytes
  );
}
