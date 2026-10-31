import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import Zap from "lucide-react-native/icons/zap";
import { memo } from "react";
import { View, type ViewStyle } from "react-native";
import { useText } from "@/shared/lib/text";
import { ChatGlassButton } from "./chat-glass-icon-button";

/**
 * "Stop and send": the button above the composer while a turn runs and the composer holds a
 * message. It stops the work and sends the message, as the desktop does in one step. The phone has
 * no route that does both, so the button stops the turn and sends after it.
 */
export const ChatStopAndSendButton = memo(function ChatStopAndSendButton({
  fallbackBackground,
  liquidGlassAvailable,
  onPress,
}: {
  fallbackBackground: ViewStyle["backgroundColor"];
  liquidGlassAvailable: boolean;
  onPress: () => void;
}) {
  const { t } = useText();
  const muted = useThemeColor("muted");
  const label = t("mobile.chat.composer.stopAndSend");
  return (
    <View className="mb-2 items-center">
      <ChatGlassButton
        accessibilityLabel={label}
        className="h-11 flex-row items-center gap-2 px-4"
        fallbackBackground={fallbackBackground}
        height={44}
        liquidGlassAvailable={liquidGlassAvailable}
        onPress={onPress}
      >
        <Zap color={String(muted)} size={16} strokeWidth={2} />
        <Typography.Paragraph type="body-sm" weight="semibold">
          {label}
        </Typography.Paragraph>
      </ChatGlassButton>
    </View>
  );
});
