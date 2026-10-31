import { GlassView } from "expo-glass-effect";
import { Button, Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import ChevronDown from "lucide-react-native/icons/chevron-down";
import ChevronUp from "lucide-react-native/icons/chevron-up";
import Search from "lucide-react-native/icons/search";
import X from "lucide-react-native/icons/x";
import { useRef } from "react";
import { TextInput, type TextInputInstance, View } from "react-native";
import { haptics } from "@/shared/lib/haptics";
import { selectionColorProps } from "@/shared/lib/selection-color";
import { useText } from "@/shared/lib/text";

export function ChatSearchBar({
  query,
  onQueryChange,
  current,
  total,
  topInset,
  fallbackBackground,
  liquidGlassAvailable,
  onPrevious,
  onNext,
  onClose,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  current: number;
  total: number;
  topInset: number;
  fallbackBackground: string;
  liquidGlassAvailable: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const { t } = useText();
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);
  const input = useRef<TextInputInstance>(null);
  const position = total > 0 ? `${current + 1}/${total}` : "0/0";

  return (
    <View
      className="absolute inset-x-0 z-30 px-4"
      style={{ top: topInset + 8 }}
      accessibilityRole="search"
      accessibilityLabel={t("mobile.chat.search.label")}
    >
      <GlassView
        glassEffectStyle={liquidGlassAvailable ? "regular" : "none"}
        style={{
          backgroundColor: liquidGlassAvailable ? "transparent" : fallbackBackground,
          borderCurve: "continuous",
          borderRadius: 24,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
        }}
      >
        <Search color={String(muted)} size={18} />
        <TextInput
          ref={input}
          autoFocus
          accessibilityLabel={t("mobile.chat.search.input")}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("mobile.chat.search.input")}
          placeholderTextColor={muted}
          returnKeyType="search"
          {...selectionColorProps(foreground)}
          className="min-h-10 min-w-0 flex-1 font-sans text-foreground"
          value={query}
          onChangeText={onQueryChange}
          onSubmitEditing={onNext}
        />
        <Typography type="body-xs" className="text-text-secondary" accessibilityLiveRegion="polite">
          {position}
        </Typography>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          accessibilityLabel={t("mobile.chat.search.previous")}
          isDisabled={total === 0}
          onPress={() => {
            void haptics.selection();
            onPrevious();
          }}
        >
          <ChevronUp color={String(muted)} size={18} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          accessibilityLabel={t("mobile.chat.search.next")}
          isDisabled={total === 0}
          onPress={() => {
            void haptics.selection();
            onNext();
          }}
        >
          <ChevronDown color={String(muted)} size={18} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          accessibilityLabel={t("mobile.chat.search.close")}
          onPress={() => {
            void haptics.impact("soft");
            onClose();
          }}
        >
          <X color={String(muted)} size={18} />
        </Button>
      </GlassView>
    </View>
  );
}
