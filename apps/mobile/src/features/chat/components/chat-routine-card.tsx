import { router } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import CalendarClock from "lucide-react-native/icons/calendar-clock";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import { memo } from "react";
import { Pressable, View } from "react-native";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";

/** The chat the routine belongs to: an agent chat or a channel chat. */
export type RoutineChatOwner = { kind: "agent" | "channel"; id: string; serverId: string };

/**
 * The routine the agent created or changed. The card opens the routine, where its schedule is
 * edited, as the desktop card opens the routine from the chat.
 */
export const ChatRoutineCard = memo(function ChatRoutineCard({
  label,
  routineId,
  routineName,
  target,
}: {
  /** What happened to the routine, such as "Created routine". */
  label: string;
  routineId: string;
  routineName: string;
  target: RoutineChatOwner;
}) {
  const { t } = useText();
  const muted = useThemeColor("muted");
  const open = () => {
    void haptics.selection();
    router.push(
      target.kind === "agent"
        ? {
            pathname: "/server-routines/agent-routine",
            params: { agentId: target.id, serverId: target.serverId, recordId: routineId },
          }
        : {
            pathname: "/server-routines/channel-routine",
            params: { channelId: target.id, serverId: target.serverId, recordId: routineId },
          },
    );
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${routineName}`}
      accessibilityHint={t("mobile.chat.routine.open")}
      onPress={open}
      className="max-w-[88%] flex-row items-center gap-2 self-start rounded-2xl bg-control/40 px-3 py-2.5"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <CalendarClock color={String(muted)} size={16} strokeWidth={2} />
      <View className="flex-1">
        <Typography.Paragraph type="body-xs" className="text-muted">
          {label}
        </Typography.Paragraph>
        <Typography.Paragraph type="body-sm" weight="semibold" numberOfLines={2}>
          {routineName}
        </Typography.Paragraph>
      </View>
      <ChevronRight color={String(muted)} size={16} strokeWidth={2} />
    </Pressable>
  );
});
