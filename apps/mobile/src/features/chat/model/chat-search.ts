import { markdownPlainText } from "@openbot/contracts/markdown-preview-text";
import type { ChatBubbleMessage, ChatMessage } from "./chat-messages";

export interface ChatSearchMatch {
  messageId: string;
  start: number;
  end: number;
}

/** Lowercased text. When lowercasing changed the length, each unit keeps its source offsets. */
interface LowercaseText {
  text: string;
  starts?: number[];
  ends?: number[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The query as a pattern whose spaces match any run of whitespace, as the desktop search does. */
function searchPattern(query: string): RegExp | null {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean).map(escapeRegExp);
  return terms.length > 0 ? new RegExp(terms.join("\\s+"), "gu") : null;
}

function lowercase(source: string): LowercaseText {
  const whole = source.toLocaleLowerCase();
  if (whole.length === source.length) return { text: whole };
  const characters = Array.from(source, (character) => ({ character, lower: character.toLocaleLowerCase() }));
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const { character, lower } of characters) {
    for (let unit = 0; unit < lower.length; unit += 1) {
      starts.push(offset);
      ends.push(offset + character.length);
    }
    offset += character.length;
  }
  const text = starts.length === whole.length ? whole : characters.map(({ lower }) => lower).join("");
  return { text, starts, ends };
}

/** The searchable text of a bubble: its body without markup. */
export function chatSearchText(message: ChatBubbleMessage): string {
  return markdownPlainText(message.body);
}

/** Finds every match of `query` in the loaded chat bubbles, in chat order. */
export function findChatSearchMatches(messages: readonly ChatMessage[], query: string): ChatSearchMatch[] {
  const pattern = searchPattern(query);
  if (!pattern) return [];
  const matches: ChatSearchMatch[] = [];
  for (const message of messages) {
    if (message.kind !== "message" || !message.body.trim()) continue;
    const text = chatSearchText(message);
    const lower = lowercase(text);
    for (const found of lower.text.matchAll(pattern)) {
      const matchStart = lower.starts?.[found.index] ?? found.index;
      const lastUnit = found.index + found[0].length - 1;
      const matchEnd = lower.ends?.[lastUnit] ?? lastUnit + 1;
      matches.push({ messageId: message.id, start: matchStart, end: matchEnd });
    }
  }
  return matches;
}

export interface HighlightSegment {
  text: string;
  highlight: boolean;
  current: boolean;
}

/** Splits plain text into normal and highlighted segments for one bubble. */
export function chatSearchHighlightSegments(
  text: string,
  ranges: readonly { start: number; end: number }[],
  active?: { start: number; end: number },
): HighlightSegment[] {
  if (ranges.length === 0) return [{ text, highlight: false, current: false }];
  const points = new Set<number>([0, text.length]);
  for (const range of ranges) {
    points.add(Math.max(0, range.start));
    points.add(Math.min(text.length, range.end));
  }
  const sorted = [...points].sort((left, right) => left - right);
  const segments: HighlightSegment[] = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const start = sorted[index] ?? 0;
    const end = sorted[index + 1] ?? text.length;
    if (start >= end) continue;
    const piece = text.slice(start, end);
    const highlight = ranges.some((range) => range.start < end && range.end > start);
    const current = active ? active.start < end && active.end > start : false;
    segments.push({ text: piece, highlight, current });
  }
  return segments.length > 0 ? segments : [{ text, highlight: false, current: false }];
}
