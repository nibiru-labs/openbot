import type { AgentMessage } from "@openbot/ui/data";
import type { VirtualItem } from "@tanstack/virtual-core";
import { groupAgentMessageMarkers, markOpenAgentMessages } from "./agent-message-timeline";
import {
  expandRoutineRunGroups,
  groupRoutineRunMarkers,
  type RoutineRunOpenState,
  routineRunTurnMessages,
} from "./routine-run-timeline";

export interface TimelineDeriveInput {
  drawnMessages: readonly AgentMessage[];
  storedMessages: readonly AgentMessage[];
  shownMessages: readonly AgentMessage[];
  openAgentMessages: ReadonlySet<string>;
  openRoutineRuns: RoutineRunOpenState;
  unreadBoundaryMessageId: string | null | undefined;
  compactionStartedAt: number | undefined;
}

export interface TimelineDerived {
  messages: AgentMessage[];
  indexById: Map<VirtualItem["key"], number>;
}

interface TimelineCache {
  structureKey: string;
  messageIdKey: string;
  derived: TimelineDerived;
}

let timelineCache: TimelineCache | undefined;

function timelineIdKey(messages: readonly AgentMessage[]): string {
  return messages.map((message) => message.id).join("\u0000");
}

function agentOpenKey(open: ReadonlySet<string>): string {
  return [...open].sort().join(",");
}

function routineRunOpenKey(open: RoutineRunOpenState): string {
  return [...open.entries()].map(([key, value]) => `${key}:${value ? 1 : 0}`).join(",");
}

function timelineStructureKey(input: TimelineDeriveInput): string {
  return [
    timelineIdKey(input.drawnMessages),
    agentOpenKey(input.openAgentMessages),
    routineRunOpenKey(input.openRoutineRuns),
    input.unreadBoundaryMessageId ?? "",
    input.compactionStartedAt ?? "",
  ].join("|");
}

/** Runs the grouping passes that build timeline rows from drawn messages. */
export function computeTimelineMessages(input: TimelineDeriveInput): AgentMessage[] {
  const group = (messages: readonly AgentMessage[]) =>
    groupRoutineRunMarkers(
      groupAgentMessageMarkers(messages, input.unreadBoundaryMessageId),
      input.unreadBoundaryMessageId,
    );
  const messages = markOpenAgentMessages(input.drawnMessages, input.openAgentMessages);
  const compactionStartedAt = input.compactionStartedAt;
  const boundary =
    compactionStartedAt === undefined
      ? -1
      : messages.findIndex((message) => message.createdAt && Date.parse(message.createdAt) > compactionStartedAt);
  const rows =
    boundary < 0 ? group(messages) : [...group(messages.slice(0, boundary)), ...group(messages.slice(boundary))];
  const turns = routineRunTurnMessages(input.storedMessages, input.shownMessages);
  return expandRoutineRunGroups(rows, messages, turns, input.openRoutineRuns);
}

function rowKeepsTimelineMarker(marker: AgentMessage["actionMarker"]): boolean {
  return (
    marker?.kind === "routine-run-group" || marker?.kind === "agent-message-group" || marker?.kind === "routine-run"
  );
}

/** Refreshes message bodies on cached rows when only content changed. */
function patchTimelineFromDrawn(cached: AgentMessage[], marked: readonly AgentMessage[]): AgentMessage[] {
  const freshById = new Map(marked.map((message) => [message.id, message]));
  let changed = false;
  const next = cached.map((row) => {
    const fresh = freshById.get(row.id);
    if (!fresh) return row;
    const marker = row.actionMarker;
    if (rowKeepsTimelineMarker(marker)) {
      if (row.body === fresh.body && row.streaming === fresh.streaming && marker === fresh.actionMarker) return row;
      changed = true;
      return { ...fresh, actionMarker: marker };
    }
    if (row.body === fresh.body && row.streaming === fresh.streaming && row.actionMarker === fresh.actionMarker) {
      return row;
    }
    changed = true;
    return marker && marker !== fresh.actionMarker ? { ...fresh, actionMarker: marker } : fresh;
  });
  return changed ? next : cached;
}

function buildIndexMap(
  previous: Map<VirtualItem["key"], number> | undefined,
  previousIdKey: string | undefined,
  messages: readonly AgentMessage[],
): Map<VirtualItem["key"], number> {
  const idKey = timelineIdKey(messages);
  if (previous && previousIdKey === idKey) return previous;
  if (previous && previousIdKey && idKey.startsWith(`${previousIdKey}\u0000`)) {
    for (let index = previous.size; index < messages.length; index += 1) {
      const message = messages[index];
      if (message) previous.set(message.id, index);
    }
    return previous;
  }
  return new Map(messages.map((message, index) => [message.id, index]));
}

/**
 * Builds timeline rows and an id index. Reuses the previous result when the message id list and
 * grouping inputs are unchanged, and only patches bodies for streaming updates.
 */
export function deriveTimeline(input: TimelineDeriveInput): TimelineDerived {
  const structureKey = timelineStructureKey(input);
  const marked = markOpenAgentMessages(input.drawnMessages, input.openAgentMessages);
  if (timelineCache?.structureKey === structureKey) {
    const messages = patchTimelineFromDrawn(timelineCache.derived.messages, marked);
    const indexById = buildIndexMap(timelineCache.derived.indexById, timelineCache.messageIdKey, messages);
    const messageIdKey = timelineIdKey(messages);
    if (messages === timelineCache.derived.messages && indexById === timelineCache.derived.indexById) {
      return timelineCache.derived;
    }
    const derived = { messages, indexById };
    timelineCache = { structureKey, messageIdKey, derived };
    return derived;
  }
  const messages = computeTimelineMessages(input);
  const messageIdKey = timelineIdKey(messages);
  const derived = { messages, indexById: buildIndexMap(undefined, undefined, messages) };
  timelineCache = { structureKey, messageIdKey, derived };
  return derived;
}

/** Clears module cache. Tests and benchmarks call this between runs. */
export function resetTimelineDeriveCache(): void {
  timelineCache = undefined;
}
