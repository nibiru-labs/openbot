import type { ChannelMessage } from "@openbot/contracts/ipc";
import {
  CONVERSATION_PLAN_ITEM_TYPE,
  CONVERSATION_SUBAGENTS_ITEM_TYPE,
  channelRoutingConversationEvent,
} from "@openbot/contracts/ipc";

/** A row shown in the chat list. Thinking steps are already removed. */
export interface TranscriptRow {
  id: string;
  kind: string;
  createdAt?: string;
}

/**
 * The row the unread divider stands on. When the stored id is not loaded, the id is kept so a later
 * page load can still place the divider.
 */
export function resolveUnreadBoundaryMessageId(
  rows: readonly TranscriptRow[],
  firstUnreadMessageId: string | null,
): string | null {
  if (!firstUnreadMessageId) return null;
  const start = rows.findIndex((row) => row.id === firstUnreadMessageId);
  if (start < 0) return firstUnreadMessageId;
  return rows[start]?.id ?? null;
}

function foldedChannelEntry(entry: ChannelMessage): boolean {
  return entry.message.author === "assistant" && entry.message.itemType === "commentary";
}

function channelEntryCountsAsUnread(entry: ChannelMessage, memberId: string | null): boolean {
  if (foldedChannelEntry(entry)) return false;
  const routing = channelRoutingConversationEvent(entry.message);
  if (routing) return false;
  if (entry.message.itemType === CONVERSATION_PLAN_ITEM_TYPE) return false;
  if (entry.message.itemType === CONVERSATION_SUBAGENTS_ITEM_TYPE) return false;
  const self = entry.author.kind === "member" && entry.author.id === memberId;
  return !self;
}

/**
 * The first unread channel message on the loaded page, from the list unread count. The rule matches
 * desktop `firstUnreadChannelMessageId`.
 */
export function firstUnreadChannelMessageId(
  entries: readonly ChannelMessage[],
  unreadCount: number,
  memberId: string | null,
): string | null {
  if (unreadCount <= 0) return null;
  const shown = entries.filter((entry) => !foldedChannelEntry(entry));
  let remaining = unreadCount;
  for (let index = shown.length - 1; index >= 0; index -= 1) {
    const entry = shown[index];
    if (!entry || !channelEntryCountsAsUnread(entry, memberId)) continue;
    remaining -= 1;
    if (remaining === 0) return entry.id;
  }
  return shown[0]?.id ?? null;
}
