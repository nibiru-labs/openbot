import type { UiActionStyle } from "@openbot/contracts/ui-blocks";
import { Button } from "heroui-native";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

const BUTTON_VARIANT = {
  primary: "primary",
  secondary: "secondary",
  ghost: "ghost",
  danger: "danger",
} as const satisfies Record<UiActionStyle, "primary" | "secondary" | "ghost" | "danger">;

/** A button that sends only after it is held for `holdMs`, or after a second tap confirms. */
export function ChatUiBlockHoldButton({
  holdMs,
  style,
  disabled,
  describedBy,
  onComplete,
  onClickWithoutHold,
  children,
}: {
  holdMs: number;
  style: UiActionStyle;
  disabled?: boolean;
  describedBy?: string;
  onComplete: () => void;
  onClickWithoutHold: () => void;
  children: string;
}) {
  const [holding, setHolding] = useState(false);
  const completed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancel(): void {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }

  function start(): void {
    if (disabled || timer.current !== null) return;
    completed.current = false;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      completed.current = true;
      setHolding(false);
      onComplete();
    }, holdMs);
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={describedBy}
      disabled={disabled}
      onPressIn={start}
      onPressOut={cancel}
      onPress={() => {
        if (completed.current) {
          completed.current = false;
          return;
        }
        cancel();
        if (!disabled) onClickWithoutHold();
      }}
    >
      <Button variant={BUTTON_VARIANT[style]} isDisabled={disabled} pointerEvents="none">
        <View className="relative min-w-0 flex-1 overflow-hidden rounded-xl">
          {holding ? (
            <View
              className="absolute inset-y-0 left-0 bg-accent/30"
              style={{ width: "100%", opacity: 0.35 }}
              accessibilityElementsHidden
            />
          ) : null}
          <Button.Label>{children}</Button.Label>
        </View>
      </Button>
    </Pressable>
  );
}

export function actionStyle(style?: UiActionStyle): UiActionStyle {
  return style ?? "secondary";
}
