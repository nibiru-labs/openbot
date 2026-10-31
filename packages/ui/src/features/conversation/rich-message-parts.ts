import { type ChatTagKind, chatTagReferences } from "@openbot/contracts/chat-tag-references";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import type { ComposerAgent, ComposerSkill, MessageCitation } from "../../data";
import { messageFileReferences } from "./FileReference";

export function messageCitationsByNumber(citations: MessageCitation[] | undefined): Map<number, MessageCitation> {
  return new Map((citations ?? []).map((citation) => [citation.number, citation]));
}

export function messageAttachmentsById(attachments: AttachmentSummary[] | undefined): Map<string, AttachmentSummary> {
  return new Map((attachments ?? []).map((attachment) => [attachment.id, attachment]));
}

type UnavailableTagKind = Exclude<ChatTagKind, "quote">;

export interface RichMessagePart {
  text: string;
  agent?: ComposerAgent | undefined;
  skill?: ComposerSkill;
  /**
   * An MCP server tag carries the name it was written with, and nothing looks it up. A message is a
   * record of what the user asked, and a server removed since does not make that record wrong.
   */
  mcpName?: string;
  /** Text the user quoted from a message of this chat. */
  quote?: { messageId: string; text: string };
  unavailableKind?: UnavailableTagKind;
  citation?: MessageCitation;
  attachment?: AttachmentSummary;
  sharedPath?: string;
  url?: string;
}

export function richMessageParts(
  body: string,
  agents: ComposerAgent[],
  skills: ComposerSkill[],
  citationsByNumber: Map<number, MessageCitation>,
  attachmentsById: Map<string, AttachmentSummary>,
): RichMessagePart[] {
  const parts: RichMessagePart[] = [];
  for (const taggedReference of semanticTagParts(body, agents, skills)) {
    if (
      taggedReference.agent ||
      taggedReference.skill ||
      taggedReference.mcpName ||
      taggedReference.quote ||
      taggedReference.unavailableKind
    ) {
      parts.push(taggedReference);
      continue;
    }
    for (const referencedPart of referencedMessageParts(taggedReference.text, attachmentsById)) {
      if (referencedPart.attachment || referencedPart.sharedPath) {
        parts.push(referencedPart);
        continue;
      }
      for (const part of linkedMessageParts(referencedPart.text)) {
        if (part.url) parts.push(part);
        else {
          for (const taggedPart of taggedMessageParts(part.text, agents)) {
            if (taggedPart.agent) {
              parts.push(taggedPart);
            } else {
              parts.push(...citedMessageParts(taggedPart.text, citationsByNumber));
            }
          }
        }
      }
    }
  }
  return parts;
}

function semanticTagParts(body: string, agents: ComposerAgent[], skills: ComposerSkill[]): RichMessagePart[] {
  const references = chatTagReferences(body);
  if (references.length === 0) return [{ text: body }];
  const parts: RichMessagePart[] = [];
  let cursor = 0;
  for (const reference of references) {
    if (reference.start > cursor) parts.push({ text: body.slice(cursor, reference.start) });
    if (reference.kind === "agent") {
      const agent = agents.find((candidate) => candidate.id === reference.id);
      parts.push(agent ? { text: agent.name, agent } : { text: reference.name, unavailableKind: "agent" });
    } else if (reference.kind === "mcp") {
      parts.push({ text: reference.name, mcpName: reference.name });
    } else if (reference.kind === "quote") {
      parts.push({ text: reference.name, quote: { messageId: reference.id, text: reference.name } });
    } else {
      const skill = skills.find(
        (candidate) => candidate.skillId === reference.id && candidate.state !== "needs-repair",
      );
      parts.push(skill ? { text: skill.name, skill } : { text: reference.name, unavailableKind: "skill" });
    }
    cursor = reference.end;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor) });
  return parts;
}

function referencedMessageParts(body: string, attachmentsById: Map<string, AttachmentSummary>): RichMessagePart[] {
  const references = messageFileReferences(body, [...attachmentsById.values()]);
  if (references.length === 0) return [{ text: body }];
  const parts: RichMessagePart[] = [];
  let cursor = 0;
  for (const reference of references) {
    if (reference.start > cursor) parts.push({ text: body.slice(cursor, reference.start) });
    if (reference.kind === "attachment") {
      parts.push({ text: reference.name, attachment: reference.attachment });
    } else {
      parts.push({ text: reference.name, sharedPath: reference.path });
    }
    cursor = reference.end;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor) });
  return parts;
}

function citedMessageParts(body: string, citationsByNumber: Map<number, MessageCitation>) {
  if (citationsByNumber.size === 0) return [{ text: body }];
  const parts: RichMessagePart[] = [];
  const expression = /\[(\d+)\]/gu;
  let cursor = 0;
  for (const match of body.matchAll(expression)) {
    const index = match.index ?? 0;
    const number = Number(match[1]);
    const citation = citationsByNumber.get(number);
    if (!citation) continue;
    if (index > cursor) parts.push({ text: body.slice(cursor, index) });
    parts.push({ text: match[0], citation });
    cursor = index + match[0].length;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor) });
  return parts.length > 0 ? parts : [{ text: body }];
}

function linkedMessageParts(body: string): RichMessagePart[] {
  const expression = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+)/giu;
  const parts: RichMessagePart[] = [];
  let cursor = 0;
  for (const match of body.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: body.slice(cursor, index) });
    const markdownUrl = match[2];
    const rawUrl = match[3];
    const rawLink = markdownUrl ?? rawUrl ?? "";
    const cleanLink = rawLink.replace(/[.,!?;:]+$/u, "");
    const url = safeBrowserUrl(cleanLink);
    if (!url) {
      parts.push({ text: match[0] });
    } else {
      parts.push({ text: match[1] ?? cleanLink, url });
      const trailingText = rawLink.slice(cleanLink.length);
      if (trailingText) parts.push({ text: trailingText });
    }
    cursor = index + match[0].length;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor) });
  return parts.length > 0 ? parts : [{ text: body }];
}

export function safeBrowserUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

interface AgentTagMatcher {
  expression: RegExp;
  agentsByName: Map<string, ComposerAgent>;
}

const agentTagMatchers = new WeakMap<ComposerAgent[], AgentTagMatcher>();

function agentTagMatcher(agents: ComposerAgent[]): AgentTagMatcher | null {
  if (agents.length === 0) return null;
  const cached = agentTagMatchers.get(agents);
  if (cached) return cached;
  const orderedAgents = [...agents].sort((left, right) => right.name.length - left.name.length);
  const matcher: AgentTagMatcher = {
    expression: new RegExp(
      `@(${orderedAgents.map((agent) => escapeExpression(agent.name)).join("|")})(?=$|[\\s.,!?;:()\\[\\]{}])`,
      "giu",
    ),
    agentsByName: new Map(orderedAgents.map((agent) => [agent.name.toLocaleLowerCase(), agent])),
  };
  agentTagMatchers.set(agents, matcher);
  return matcher;
}

function taggedMessageParts(body: string, agents: ComposerAgent[]) {
  if (!body.includes("@")) return [{ text: body, agent: undefined }];
  const matcher = agentTagMatcher(agents);
  if (!matcher) return [{ text: body, agent: undefined }];
  matcher.expression.lastIndex = 0;
  const parts: Array<{ text: string; agent: ComposerAgent | undefined }> = [];
  let cursor = 0;
  for (const match of body.matchAll(matcher.expression)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: body.slice(cursor, index), agent: undefined });
    const name = match[1] ?? "";
    const agent = matcher.agentsByName.get(name.toLocaleLowerCase());
    parts.push({ text: match[0], agent });
    cursor = index + match[0].length;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor), agent: undefined });
  return parts.length > 0 ? parts : [{ text: body, agent: undefined }];
}

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A part that shows its source text as it is, so its length counts body characters. */
export function plainTextPart(part: RichMessagePart): boolean {
  return !(
    part.agent ||
    part.skill ||
    part.mcpName ||
    part.quote ||
    part.unavailableKind ||
    part.citation ||
    part.attachment ||
    part.sharedPath
  );
}
