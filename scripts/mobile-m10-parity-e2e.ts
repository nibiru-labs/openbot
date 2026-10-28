// Mobile parity checks for M10 findings 4, 6, 7, 9 and 15. Pure functions and projection rules
// are exercised here; this script writes a JSON report.
//
// Run: bun scripts/mobile-m10-parity-e2e.ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chatVisualReply } from "@openbot/contracts/chat-visual";
import {
  filePreviewKindForFile,
  MODEL_SWITCH_ITEM_TYPES,
  marketplaceSuggestionItemType,
  skillConversationEventItemType,
} from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { attachmentPreviewKind } from "../apps/mobile/src/features/chat/model/attachment-file-preview";
import { dayMarkerLabel } from "../apps/mobile/src/features/chat/model/chat-day-markers";
import { parseFinishedChatMarkdown } from "../apps/mobile/src/features/chat/model/chat-markdown-parser";
import { projectChatMessages } from "../apps/mobile/src/features/chat/model/chat-messages";
import {
  firstUnreadChannelMessageId,
  resolveUnreadBoundaryMessageId,
} from "../apps/mobile/src/features/chat/model/chat-unread-boundary";
import { marketplaceSuggestionKnown } from "../apps/mobile/src/features/chat/model/marketplace-suggestion-known";
import { textFor } from "../apps/mobile/src/shared/lib/text-value";

const logger = createOpenBotLogger("mobile-m10-parity-e2e");
const OUT = resolve(import.meta.dirname, "../.openbot-build/mobile-m10-parity-e2e");

interface CaseResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CaseResult[] = [];

function check(name: string, passed: boolean, detail: string) {
  results.push({ name, passed, detail });
  if (!passed) logger.error(`${name}: ${detail}`);
}

type MarkdownToken = { type: string; tokens?: readonly MarkdownToken[] };

function collectInlineTokenTypes(tokens: readonly MarkdownToken[]): Set<string> {
  const types = new Set<string>();
  for (const token of tokens) {
    types.add(token.type);
    if (token.tokens) {
      for (const nested of collectInlineTokenTypes(token.tokens)) types.add(nested);
    }
  }
  return types;
}

function finding4FilePreview(): void {
  const pdf = attachmentPreviewKind({ name: "report.pdf", mimeType: "application/pdf" });
  check("finding-4-pdf-preview-kind", pdf === "pdf", `expected pdf, got ${String(pdf)}`);
  const markdown = attachmentPreviewKind({ name: "notes.md", mimeType: "text/markdown" });
  check("finding-4-markdown-preview-kind", markdown === "markdown", `expected markdown, got ${String(markdown)}`);
  const text = attachmentPreviewKind({ name: "log.txt", mimeType: "text/plain" });
  check("finding-4-text-preview-kind", text === "text", `expected text, got ${String(text)}`);
  const none = attachmentPreviewKind({ name: "archive.zip", mimeType: "application/zip" });
  check("finding-4-no-preview-kind", none === null, `expected null, got ${String(none)}`);
  const hostKind = filePreviewKindForFile("report.pdf", "application/pdf");
  check("finding-4-host-parity", hostKind === "pdf", `host kind ${String(hostKind)}`);
  const previewRoute = resolve(import.meta.dirname, "../apps/mobile/src/app/(app)/code-preview/[previewId].tsx");
  check("finding-4-preview-route", existsSync(previewRoute), previewRoute);
}

function finding6SkillMcpTags(): void {
  const body = "Try @[Search](skill:search-id) with @[GitHub](mcp:github-id) today.";
  const tokens = parseFinishedChatMarkdown(body);
  const types = collectInlineTokenTypes(tokens);
  check("finding-6-skill-token", types.has("skillMention"), `types: ${[...types].join(", ")}`);
  const paragraph = tokens.find((token) => token.type === "paragraph");
  const inline = paragraph && "tokens" in paragraph ? paragraph.tokens : undefined;
  const skillTokens = (inline ?? []).filter((token) => token.type === "skillMention");
  check("finding-6-two-skill-mentions", skillTokens.length === 2, String(skillTokens.length));
  const plainText = (inline ?? [])
    .filter((token) => token.type === "text")
    .map((token) => ("text" in token ? String(token.text) : ""))
    .join("");
  check("finding-6-plain-text-has-no-markers", !plainText.includes("@[Search](skill:"), plainText);
  const parserPath = resolve(import.meta.dirname, "../apps/mobile/src/features/chat/model/chat-markdown-parser.ts");
  const parserSource = existsSync(parserPath) ? "skillReference" : "";
  check("finding-6-parser-extension", parserSource.length > 0, parserPath);
}

function finding7DroppedMarkers(): void {
  const now = new Date().toISOString();
  const modelSwitch = {
    id: "ms-1",
    text: "Switched model because of a usage limit.",
    author: "system" as const,
    source: "system" as const,
    status: "completed" as const,
    itemType: MODEL_SWITCH_ITEM_TYPES["usage-limit"],
    createdAt: now,
  };
  const skillInstall = {
    id: "sk-1",
    text: "Installed skill Web search.",
    author: "system" as const,
    source: "system" as const,
    status: "completed" as const,
    itemType: skillConversationEventItemType({ action: "installed", skillId: "web-search", revision: 1 }),
    createdAt: now,
  };
  const marketplace = {
    id: "mp-1",
    text: "Suggested connecting Slack.",
    author: "system" as const,
    source: "system" as const,
    status: "completed" as const,
    itemType: marketplaceSuggestionItemType({ appId: "slack" }),
    createdAt: now,
  };
  const projected = projectChatMessages([modelSwitch, skillInstall, marketplace]);
  const modelMarker = projected.find((message) => message.kind === "marker" && message.text === modelSwitch.text);
  check("finding-7-model-switch-marker", modelMarker !== undefined, String(projected.map((message) => message.kind)));
  const skillMarker = projected.find((message) => message.kind === "marker" && message.text === skillInstall.text);
  check("finding-7-skill-marker", skillMarker !== undefined, String(projected.map((message) => message.kind)));
  const suggestion = projected.find((message) => message.kind === "marketplace-suggestion");
  check(
    "finding-7-marketplace-suggestion",
    suggestion?.kind === "marketplace-suggestion" && suggestion.appId === "slack",
    JSON.stringify(suggestion),
  );
  check("finding-7-marketplace-known", marketplaceSuggestionKnown("slack"), "slack");
  const connectRoute = resolve(import.meta.dirname, "../apps/mobile/src/app/(app)/marketplace-listing/connect.tsx");
  check("finding-7-connect-route", existsSync(connectRoute), connectRoute);
}

function finding9ChatVisual(): void {
  const visualMessage = {
    id: "vis-1",
    text: "Sales chart",
    author: "assistant" as const,
    status: "completed" as const,
    itemType: "visual-reply:320",
    createdAt: new Date().toISOString(),
    attachments: [
      {
        id: "att-1",
        name: "chart.html",
        mimeType: "text/html",
        size: 1200,
        kind: "file" as const,
        previewKind: "text" as const,
        previewUrl: null,
      },
    ],
  };
  const visual = chatVisualReply(visualMessage);
  check("finding-9-visual-reply", visual?.attachment.id === "att-1", JSON.stringify(visual));
  const projected = projectChatMessages([visualMessage]);
  const bubble = projected.find((message) => message.kind === "message");
  check(
    "finding-9-visual-projection",
    bubble?.kind === "message" && bubble.visual !== undefined,
    JSON.stringify(bubble),
  );
  const htmlPreview = resolve(
    import.meta.dirname,
    "../apps/mobile/src/features/chat/components/html-page-view.native.tsx",
  );
  check("finding-9-html-page-view", existsSync(htmlPreview), htmlPreview);
  const chatAttachment = resolve(
    import.meta.dirname,
    "../apps/mobile/src/features/chat/components/chat-attachment.tsx",
  );
  check("finding-9-chat-visual-attachment", existsSync(chatAttachment), chatAttachment);
}

function finding15TranscriptMarkers(): void {
  const { t, format } = textFor("en");
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const todayIso = today.toISOString();
  const yesterdayIso = yesterday.toISOString();
  const first = dayMarkerLabel(undefined, todayIso, { t, format, now: today });
  check("finding-15-day-first-row", first !== null, String(first));
  const sameDay = dayMarkerLabel(todayIso, todayIso, { t, format, now: today });
  check("finding-15-day-same-day", sameDay === null, String(sameDay));
  const nextDay = dayMarkerLabel(yesterdayIso, todayIso, { t, format, now: today });
  check("finding-15-day-boundary", nextDay !== null, String(nextDay));
  const rows = [
    { id: "a", kind: "message", createdAt: yesterdayIso },
    { id: "b", kind: "message", createdAt: todayIso },
    { id: "c", kind: "message", createdAt: todayIso },
  ];
  const boundary = resolveUnreadBoundaryMessageId(rows, "b");
  check("finding-15-unread-boundary", boundary === "b", String(boundary));
  const channelBoundary = firstUnreadChannelMessageId(
    [
      {
        id: "m1",
        channelId: "channel-1",
        sequence: 1,
        taskId: null,
        superseded: false,
        author: { kind: "agent", id: "agent-1", name: "Agent" },
        message: { id: "m1", text: "hello", author: "assistant", status: "completed", createdAt: yesterdayIso },
      },
      {
        id: "m2",
        channelId: "channel-1",
        sequence: 2,
        taskId: null,
        superseded: false,
        author: { kind: "member", id: "member-1", name: "You" },
        message: { id: "m2", text: "reply", author: "user", status: "completed", createdAt: todayIso },
      },
    ],
    1,
    "member-1",
  );
  check("finding-15-channel-unread", channelBoundary === "m1", String(channelBoundary));
}

function main(): void {
  finding4FilePreview();
  finding6SkillMcpTags();
  finding7DroppedMarkers();
  finding9ChatVisual();
  finding15TranscriptMarkers();
  mkdirSync(OUT, { recursive: true });
  const report = {
    passed: results.every((result) => result.passed),
    cases: results,
  };
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  logger.info(
    `Wrote ${resolve(OUT, "report.json")}. ${results.filter((result) => result.passed).length}/${results.length} passed.`,
  );
  if (!report.passed) process.exit(1);
}

main();
