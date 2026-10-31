import type { ChatTagKind } from "@openbot/contracts/chat-tag-references";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { Blocks, Button, Puzzle, TextQuote } from "@openbot/ui";
import { ReferenceChip } from "@openbot/ui/reference-chip";
import { usesTouchLayout } from "@openbot/ui/utils";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, createUniqueId, For, Show, untrack } from "solid-js";
import type { ComposerAgent, ComposerSkill, MessageCitation } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";
import { AnchoredTooltip } from "./AnchoredTooltip";
import { AttachmentReferenceVisual, attachmentReferenceTone } from "./AttachmentReference";
import { LinkIcon } from "./ConversationIcons";
import {
  messageAttachmentsById,
  messageCitationsByNumber,
  plainTextPart,
  richMessageParts,
  safeBrowserUrl,
} from "./rich-message-parts";
import {
  sameStreamingTailOffsets,
  splitStreamingTrail,
  streamingTailOffsets,
  streamingTrailReach,
  useStreamingReveal,
} from "./streamingReveal";

export {
  messageAttachmentsById,
  messageCitationsByNumber,
  richMessageParts,
  safeBrowserUrl,
} from "./rich-message-parts";

export interface RichMessageTextProps {
  body: string;
  agents: ComposerAgent[];
  skills?: ComposerSkill[] | undefined;
  attachments?: AttachmentSummary[] | undefined;
  citations?: MessageCitation[] | undefined;
  /** Built once per message; when set, `citations` is not read for parsing. */
  citationsByNumber?: Map<number, MessageCitation> | undefined;
  /** Built once per message; when set, `attachments` is not read for parsing. */
  attachmentsById?: Map<string, AttachmentSummary> | undefined;
  onSelectAgent: (agentId: string) => void;
  onOpenLink: (url: string) => void;
  onOpenAttachment?: ((attachment: AttachmentSummary) => void) | undefined;
  onOpenSharedFile?: ((path: string) => void) | undefined;
  onOpenWorkspaceFile?: ((path: string) => void) | undefined;
  /** Shows the passage that a quote tag names. Without it, a quote is a chip that does nothing. */
  onOpenQuote?: ((messageId: string, text: string) => void) | undefined;
  showCitationFooter?: boolean;
  /** The characters of a streaming body after this text. It fades the words revealed last. */
  streamingTailAfter?: number | undefined;
  /**
   * False shows only the link icon, so that no linked site is asked for its favicon. Use it for
   * text that another person wrote, such as the instructions of a shared agent.
   */
  linkFavicons?: boolean | undefined;
}

const UNAVAILABLE_TAG_LABELS = {
  agent: "chat.tag.unavailableAgent",
  skill: "chat.tag.unavailableSkill",
  mcp: "chat.tag.unavailableMcp",
} as const satisfies Record<UnavailableTagKind, AppTextKey>;

/* A quote carries its own text, so it never depends on something that can go away. */
type UnavailableTagKind = Exclude<ChatTagKind, "quote">;

export function RichMessageText(props: RichMessageTextProps) {
  const { t } = useText();
  const citationsByNumber = createMemo(() =>
    props.citationsByNumber ? props.citationsByNumber : messageCitationsByNumber(props.citations),
  );
  const attachmentsById = createMemo(() =>
    props.attachmentsById ? props.attachmentsById : messageAttachmentsById(props.attachments),
  );
  const parts = createMemo(() =>
    richMessageParts(props.body, props.agents, props.skills ?? [], citationsByNumber(), attachmentsById()),
  );
  const trail = useStreamingReveal();
  const tailAfter = createMemo(
    () =>
      streamingTailOffsets(
        parts().map((part) => (plainTextPart(part) ? part.text.length : Number.POSITIVE_INFINITY)),
        props.streamingTailAfter,
        streamingTrailReach(trail?.() ?? []),
      ),
    { equals: sameStreamingTailOffsets },
  );
  const citations = createMemo(() => (props.citations ?? []).filter((citation) => safeBrowserUrl(citation.url)));
  const tooltipId = `rich-message-tooltip-${createUniqueId()}`;
  const [tooltip, setTooltip] = createSignal<{
    anchor: HTMLElement;
    content: string;
    light: boolean;
  } | null>(null);

  const openTooltip = (anchor: HTMLElement, content: string, onlyWhenTruncated = false) => {
    // The chip, not its inline name, clips the name and shows the ellipsis.
    if (onlyWhenTruncated && anchor.scrollWidth <= anchor.clientWidth + 1) {
      setTooltip(null);
      return;
    }
    setTooltip({
      anchor,
      content,
      light: Boolean(anchor.closest('[data-slot="bubble"][data-author="user"]')),
    });
  };
  const closeTooltip = (anchor: HTMLElement) => {
    if (tooltip()?.anchor === anchor) setTooltip(null);
  };
  const closeTooltipOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (!(event.currentTarget instanceof HTMLElement)) return;
    closeTooltip(event.currentTarget);
  };

  return (
    <>
      <For each={parts()}>
        {(part, index) => {
          const attachment = part.attachment;
          const sharedPath = part.sharedPath;
          if (attachment || sharedPath) {
            const name = untrack(() => attachment?.name) ?? part.text;
            return (
              <Button
                variant="ghost"
                type="button"
                class="message-file-reference"
                data-file-tone={attachmentReferenceTone(name)}
                aria-label={attachment ? t("chat.file.openAttached", { name }) : t("chat.file.openShared", { name })}
                aria-describedby={tooltipId}
                data-cuelume-tap="open"
                onPointerEnter={(event) => openTooltip(event.currentTarget, name, true)}
                onMouseEnter={(event) => openTooltip(event.currentTarget, name, true)}
                onPointerLeave={(event) => closeTooltip(event.currentTarget)}
                onMouseLeave={(event) => closeTooltip(event.currentTarget)}
                onFocus={(event) => openTooltip(event.currentTarget, name, true)}
                onBlur={(event) => closeTooltip(event.currentTarget)}
                onKeyDown={closeTooltipOnEscape}
                onClick={(event) => {
                  if (!usesTouchLayout()) setTooltip(null);
                  else openTooltip(event.currentTarget, name, true);
                  if (attachment) props.onOpenAttachment?.(attachment);
                  else if (sharedPath) props.onOpenSharedFile?.(sharedPath);
                }}
              >
                <AttachmentReferenceVisual name={name} />
                <span class="inline-file-reference-name">{name}</span>
              </Button>
            );
          }
          if (part.url) {
            return (
              <MessageLink
                url={part.url}
                title={linkTitle(part.text, part.url)}
                favicon={props.linkFavicons !== false}
                onOpenLink={props.onOpenLink}
              >
                {part.text}
              </MessageLink>
            );
          }
          if (part.agent) {
            return (
              <ReferenceChip
                kind="agent"
                name={part.agent.name}
                class="message-reference-chip message-agent-tag"
                icon={<AgentAvatar agent={part.agent} />}
                onClick={() => props.onSelectAgent(part.agent?.id ?? "")}
              />
            );
          }
          if (part.skill) {
            return (
              <ReferenceChip class="message-reference-chip" kind="skill" name={part.skill.name} icon={<Puzzle />} />
            );
          }
          if (part.mcpName) {
            return <ReferenceChip class="message-reference-chip" kind="mcp" name={part.mcpName} icon={<Blocks />} />;
          }
          if (part.quote) {
            const quote = part.quote;
            const onOpenQuote = props.onOpenQuote;
            return (
              <ReferenceChip
                kind="quote"
                name={quote.text}
                class="message-reference-chip message-quote-tag"
                icon={<TextQuote />}
                onClick={onOpenQuote ? () => onOpenQuote(quote.messageId, quote.text) : undefined}
              />
            );
          }
          if (part.unavailableKind) {
            return (
              <span class="message-tag-unavailable">
                <span class="sr-only">{t(UNAVAILABLE_TAG_LABELS[part.unavailableKind])} </span>
                {part.text}
              </span>
            );
          }
          if (part.citation) {
            return (
              <span class="message-citation">
                <a
                  class="message-citation-mark"
                  href={part.citation.url}
                  data-cuelume-navigate=""
                  data-cuelume-emphasis="subtle"
                  aria-label={t("chat.citation.open", { number: part.citation.number, label: part.citation.label })}
                  aria-describedby={tooltipId}
                  onPointerEnter={(event) => openTooltip(event.currentTarget, part.citation?.label ?? "")}
                  onMouseEnter={(event) => openTooltip(event.currentTarget, part.citation?.label ?? "")}
                  onPointerLeave={(event) => closeTooltip(event.currentTarget)}
                  onMouseLeave={(event) => closeTooltip(event.currentTarget)}
                  onFocus={(event) => openTooltip(event.currentTarget, part.citation?.label ?? "")}
                  onBlur={(event) => closeTooltip(event.currentTarget)}
                  onKeyDown={closeTooltipOnEscape}
                  onClick={(event) => {
                    event.preventDefault();
                    setTooltip(null);
                    props.onOpenLink(part.citation?.url ?? "");
                  }}
                >
                  {part.citation.number}
                </a>
              </span>
            );
          }
          return (
            <Show when={tailAfter()[index()] !== undefined} fallback={part.text}>
              <StreamingTailText body={part.text} after={tailAfter()[index()] ?? 0} />
            </Show>
          );
        }}
      </For>
      <Show when={props.showCitationFooter !== false && citations().length > 0}>
        <span class="message-citation-footer">
          <For each={citations()}>
            {(citation) => (
              <a
                class="message-citation-ref"
                href={citation.url}
                data-cuelume-navigate=""
                data-cuelume-emphasis="subtle"
                aria-label={t("chat.citation.openSource", { number: citation.number, label: citation.label })}
                onClick={(event) => {
                  event.preventDefault();
                  props.onOpenLink(citation.url);
                }}
              >
                <span class="message-citation-mark">{citation.number}</span>
                <span class="message-citation-ref-label">{citation.label}</span>
                <span class="message-citation-separator" aria-hidden="true">
                  ·
                </span>
                <span class="message-citation-ref-host">{citation.host ?? citationHost(citation.url)}</span>
                <span class="message-citation-arrow" aria-hidden="true">
                  <CitationArrowIcon />
                </span>
              </a>
            )}
          </For>
        </span>
      </Show>
      <Show when={tooltip()}>
        {(activeTooltip) => (
          <AnchoredTooltip
            id={tooltipId}
            anchor={activeTooltip().anchor}
            content={activeTooltip().content}
            light={activeTooltip().light}
          />
        )}
      </Show>
    </>
  );
}

function StreamingTailText(props: { body: string; after: number }) {
  const trail = useStreamingReveal();
  const parts = createMemo(() => splitStreamingTrail(props.body, trail?.() ?? [], props.after));

  return (
    <>
      {parts().prefix}
      <For each={parts().chunks}>
        {(chunk) => (
          /* The block that holds the tail renders again on each step. A delay of minus the step's
             age continues its fade where it was, instead of starting it again. */
          <span
            class="t-stream-w"
            style={{ "animation-delay": `${Math.min(0, chunk.revealedAt - performance.now())}ms` }}
          >
            {chunk.text}
          </span>
        )}
      </For>
    </>
  );
}

export function MessageLink(props: {
  url: string;
  /** The native tooltip. Omit it when the link text already shows the URL. */
  title?: string | undefined;
  children: JSX.Element;
  /** False keeps the request for the linked site's favicon from being made. */
  favicon?: boolean;
  onOpenLink: (url: string) => void;
}) {
  return (
    <a
      class="message-link"
      href={props.url}
      data-cuelume-navigate=""
      data-cuelume-emphasis="subtle"
      title={props.title}
      onClick={(event) => {
        event.preventDefault();
        props.onOpenLink(props.url);
      }}
    >
      <span class="message-link-icon" aria-hidden="true">
        <LinkIcon />
        <Show when={props.favicon !== false}>
          <img
            src={faviconUrl(props.url)}
            alt=""
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
            onError={(event) => event.currentTarget.remove()}
          />
        </Show>
      </span>
      {props.children}
    </a>
  );
}

/** The URL as a tooltip, unless the link text is already that URL. */
export function linkTitle(text: string, url: string): string | undefined {
  return text === url || `${text}/` === url ? undefined : url;
}

function faviconUrl(value: string): string {
  return `${new URL(value).origin}/favicon.ico`;
}

function citationHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./u, "");
  } catch {
    return value;
  }
}

function CitationArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
    </svg>
  );
}
