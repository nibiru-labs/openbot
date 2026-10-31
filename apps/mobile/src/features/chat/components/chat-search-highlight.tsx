import { Text } from "react-native";
import { useCSSVariable } from "uniwind";
import type { HighlightSegment } from "@/features/chat/model/chat-search";

/** Plain text with search-match backgrounds for one bubble. */
export function ChatSearchHighlightText({ segments, color }: { segments: readonly HighlightSegment[]; color: string }) {
  const highlight = String(useCSSVariable("--openbot-search-highlight") ?? "#fde047");
  const current = String(useCSSVariable("--openbot-search-current") ?? "#facc15");
  return (
    <Text selectable style={{ color, fontSize: 16, lineHeight: 22 }}>
      {segments.map((segment) =>
        segment.highlight ? (
          <Text
            key={`${segment.text}:${segment.current ? "current" : "match"}`}
            style={{
              color,
              backgroundColor: segment.current ? current : highlight,
            }}
          >
            {segment.text}
          </Text>
        ) : (
          segment.text
        ),
      )}
    </Text>
  );
}
