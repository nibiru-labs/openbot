import { router } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import { Pressable, View } from "react-native";
import { MOBILE_PLUGINS } from "@/features/marketplace/model/plugin-catalog.generated";
import { CONNECTOR_TITLE_KEYS, isMobileConnectorId } from "@/features/servers/model/connectors";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";
import type { ChatMessage } from "../model/chat-messages";
import { marketplaceSuggestionKnown } from "../model/marketplace-suggestion-known";

/**
 * The Marketplace app an agent suggested. Connect opens the same connect flow as Marketplace,
 * or the connector screen for a messaging connector.
 */
export function ChatMarketplaceSuggestion({
  message,
  serverId,
}: {
  message: Extract<ChatMessage, { kind: "marketplace-suggestion" }>;
  serverId: string;
}) {
  const { t, sourceText } = useText();
  const [muted, accent] = useThemeColor(["muted", "accent"]);
  const plugin = MOBILE_PLUGINS.find((candidate) => candidate.slug === message.appId);
  const connector = isMobileConnectorId(message.appId) ? message.appId : null;
  const name = plugin?.name ?? (connector ? t(CONNECTOR_TITLE_KEYS[connector]) : message.appId);
  const detail = plugin?.tagline ?? sourceText(message.text);
  const known = marketplaceSuggestionKnown(message.appId);
  const open = () => {
    void haptics.impact("soft");
    if (plugin) router.push({ pathname: "/marketplace-listing/connect", params: { serverId, slug: plugin.slug } });
    else if (connector) router.push({ pathname: "/server-settings/connector", params: { serverId, id: connector } });
  };
  return (
    <View className="max-w-full py-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("mobile.chat.suggestion.cardLabel", { name })}
        accessibilityHint={known ? t("mobile.chat.suggestion.connectHint") : undefined}
        accessibilityState={{ disabled: !known }}
        disabled={!known}
        className="flex-row items-center gap-3 rounded-2xl border border-border bg-control p-3"
        onPress={known ? open : undefined}
      >
        <View className="min-w-0 flex-1 gap-1">
          <Typography.Paragraph type="body-sm" className="font-semibold text-foreground">
            {name}
          </Typography.Paragraph>
          <Typography.Paragraph type="body-xs" className="text-muted" numberOfLines={2}>
            {detail}
          </Typography.Paragraph>
        </View>
        {known ? (
          <View className="flex-row items-center gap-1">
            <Typography.Paragraph type="body-sm" style={{ color: accent }}>
              {t("mobile.marketplace.app.connect")}
            </Typography.Paragraph>
            <ChevronRight size={18} color={muted} />
          </View>
        ) : (
          <Typography.Paragraph type="body-xs" className="text-muted">
            {sourceText(message.text)}
          </Typography.Paragraph>
        )}
      </Pressable>
    </View>
  );
}
