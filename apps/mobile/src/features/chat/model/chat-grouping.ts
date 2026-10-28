/*
 * The rule that decides when a run of messages by one sender reads as one block. The desktop chat
 * uses the same rule, so a chat reads the same way on the phone and on the computer. The phone has
 * no day separators, so a row never opens a run by a new day.
 */

/**
 * How long a run of messages by one sender stays one block. Beyond it the time returns, because a
 * reply an hour later is a new turn of the conversation, not a continuation.
 */
const CHAT_GROUPING_WINDOW_MS = 5 * 60_000;

/** A row of the transcript, as the fields the grouping rule reads. */
export interface SenderRunRow {
  /** The id of the row. */
  id: string;
  /** Who wrote the row: the reader, an agent or another member. */
  author: string;
  /** When the host stored the row. */
  createdAt?: string;
  /** False for a row that carries no time the reader can see, such as an activity marker. */
  drawsTime: boolean;
}

/** Do two messages fall close enough together to stay one block? An unreadable time says no. */
function withinGroupingWindow(previousIso: string | undefined, currentIso: string | undefined): boolean {
  if (previousIso === undefined || currentIso === undefined) return false;
  const previous = new Date(previousIso).getTime();
  const current = new Date(currentIso).getTime();
  if (Number.isNaN(previous) || Number.isNaN(current)) return false;
  return current - previous <= CHAT_GROUPING_WINDOW_MS;
}

/**
 * Does this row continue the run above it, and so draw no time of its own?
 *
 * `previous` is absent for the first row of the transcript, which always opens a run.
 * `previousDrawsTime` is false for a row that carries no time the reader can see, such as an
 * activity marker: the run it interrupts cannot continue under it.
 */
export function continuesSenderRun(
  previous: SenderRunRow | undefined,
  current: SenderRunRow,
  options: { previousDrawsTime: boolean },
): boolean {
  if (previous === undefined || !options.previousDrawsTime) return false;
  if (previous.author !== current.author) return false;
  return withinGroupingWindow(previous.createdAt, current.createdAt);
}

/**
 * The sender of a row of the chat, as the grouping rule reads it: the reader, another member of
 * the chat, or an agent. A row that is not a message has no sender.
 */
export function chatRunAuthor(message: {
  kind: string;
  author?: "user" | "agent";
  /** Another person who wrote the message in an agent chat. */
  sender?: { id: string };
  /** The author of a channel message: its agent, or a person. */
  speaker?: { id: string };
}): string {
  if (message.kind !== "message") return "";
  if (message.author === "user") return "user";
  if (message.sender) return `member:${message.sender.id}`;
  return message.speaker?.id ?? "agent";
}

/**
 * The rows that continue the run above them. A row in the set draws no time of its own: the run
 * carries one time at its top, as on the desktop.
 */
export function senderRuns(rows: readonly SenderRunRow[]): ReadonlySet<string> {
  const grouped = new Set<string>();
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    if (continuesSenderRun(previous, row, { previousDrawsTime: previous?.drawsTime === true })) grouped.add(row.id);
  });
  return grouped;
}
