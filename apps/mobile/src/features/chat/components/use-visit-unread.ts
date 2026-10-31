import { useRef } from "react";

export interface VisitUnreadState {
  unreadCount: number;
  firstUnreadMessageId: string | null;
}

/**
 * Keeps the unread boundary from when the chat opened. Marking read clears host read state, but the
 * divider stays until the reader opens another chat, as on desktop.
 */
export function useVisitUnread(conversationKey: string, readState: VisitUnreadState | undefined): VisitUnreadState {
  const visit = useRef<{ key: string; state: VisitUnreadState } | null>(null);
  const messageId = readState?.firstUnreadMessageId ?? null;
  const unreadCount = readState?.unreadCount ?? 0;
  if (visit.current?.key === conversationKey && !messageId && unreadCount <= 0) return visit.current.state;
  const state = { unreadCount, firstUnreadMessageId: messageId };
  visit.current = { key: conversationKey, state };
  return state;
}
