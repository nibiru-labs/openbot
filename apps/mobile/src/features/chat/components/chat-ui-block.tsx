import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type ConversationUiBlock,
  isSecretFormField,
  UI_BLOCK_LIMITS,
  UI_BLOCK_SUBMIT_ACTION_ID,
  UI_BLOCK_TEXT_ACTION_ID,
  UI_CHOICE_VALUES_KEY,
  type UiAction,
  type UiBlockResponse,
  type UiBlockSpec,
  type UiBlockState,
  type UiBlockStatus,
  type UiFormField,
  validateUiBlockResponse,
} from "@openbot/contracts/ui-blocks";
import type { MobileTextKey } from "@openbot/i18n/mobile";
import { Button, Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import Check from "lucide-react-native/icons/check";
import CircleCheck from "lucide-react-native/icons/circle-check";
import Clock3 from "lucide-react-native/icons/clock-3";
import LoaderCircle from "lucide-react-native/icons/loader-circle";
import X from "lucide-react-native/icons/x";
import { type ReactNode, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { ChatMarkdown } from "@/features/chat/components/chat-markdown";
import { actionStyle, ChatUiBlockHoldButton } from "@/features/chat/components/chat-ui-block-hold-button";
import type { UiBlockPromptController } from "@/features/chat/components/use-ui-block-prompt";
import { selectionColorProps } from "@/shared/lib/selection-color";
import { useText } from "@/shared/lib/text";

const DEFAULT_HOLD_MS = 800;
const STATUS_LABEL = {
  pending: "uiBlock.status.pending",
  answered: "uiBlock.status.answered",
  expired: "uiBlock.status.expired",
  closed: "uiBlock.status.closed",
} as const satisfies Record<UiBlockStatus, MobileTextKey>;

function sendResponse(
  spec: UiBlockSpec,
  response: UiBlockResponse,
  onRespond: ((response: UiBlockResponse) => void) | undefined,
): boolean {
  const valid = validateUiBlockResponse(spec, response);
  if (valid === null || !onRespond) return false;
  onRespond(valid);
  return true;
}

function optionLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function BlockCard({
  title,
  subtitle,
  status,
  outcome,
  danger,
  busy,
  error,
  onSkip,
  disabled,
  children,
}: {
  title?: string;
  subtitle?: string;
  status: UiBlockStatus;
  outcome?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string;
  onSkip?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { t } = useText();
  const [muted, warning] = useThemeColor(["muted", "warning"]);
  const outcomeText =
    outcome ??
    (status === "expired" ? t("uiBlock.outcome.expired") : status === "closed" ? t("uiBlock.outcome.closed") : "");
  return (
    <View
      className={`max-w-[88%] self-start gap-3 rounded-[30px] px-4 py-3 ${danger ? "border border-danger/40" : "bg-control/60"}`}
      style={{ borderCurve: "circular" }}
    >
      <View className="flex-row items-start gap-2">
        <View className="min-w-0 flex-1 gap-1">
          {title ? (
            <Typography weight="medium" accessibilityRole="header">
              {title}
            </Typography>
          ) : null}
          {subtitle ? (
            <Typography type="body-sm" className="text-text-secondary">
              {subtitle}
            </Typography>
          ) : null}
        </View>
        <View className="shrink-0 rounded-full bg-control px-2 py-1">
          <View className="flex-row items-center gap-1">
            {status === "pending" ? <LoaderCircle color={String(warning)} size={14} /> : null}
            {status === "answered" ? <Check color={String(muted)} size={14} /> : null}
            <Typography type="body-xs" className="text-text-secondary">
              {t(STATUS_LABEL[status])}
            </Typography>
          </View>
        </View>
      </View>
      {children}
      {status === "pending" && (error || onSkip) ? (
        <View className="gap-2">
          {error ? (
            <Typography type="body-xs" accessibilityRole="alert">
              {error}
            </Typography>
          ) : null}
          {onSkip ? (
            <Button variant="ghost" size="sm" isDisabled={busy || disabled} onPress={onSkip}>
              <Button.Label>{t("uiBlock.skip")}</Button.Label>
            </Button>
          ) : null}
        </View>
      ) : null}
      {status !== "pending" && outcomeText ? (
        <View className="flex-row items-center gap-2">
          {status === "answered" ? <CircleCheck color={String(muted)} size={16} /> : null}
          {status === "expired" ? <Clock3 color={String(muted)} size={16} /> : null}
          {status === "closed" ? <X color={String(muted)} size={16} /> : null}
          <Typography type="body-sm" className="min-w-0 flex-1 text-text-secondary">
            {outcomeText}
          </Typography>
        </View>
      ) : null}
    </View>
  );
}

function ConfirmBlock({
  spec,
  state,
  controller,
}: {
  spec: Extract<UiBlockSpec, { type: "confirm" }>;
  state: UiBlockState;
  controller?: UiBlockPromptController;
}) {
  const { t } = useText();
  const [foreground] = useThemeColor(["foreground"]);
  const frozen = state.status !== "pending";
  const locked = frozen || controller?.disabled;
  const holdMs = spec.confirmHold ?? DEFAULT_HOLD_MS;
  const holdsPrimary = spec.danger === true || spec.confirmHold !== undefined;
  const isHeld = (action: UiAction) =>
    actionStyle(action.style) === "danger" || (holdsPrimary && actionStyle(action.style) === "primary");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<UiAction>();
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const hintId = "confirm-hold-hint";

  function selectValue(select: string, options: string[]): string {
    const stored = frozen ? state.response?.values?.[select] : undefined;
    return stored !== undefined ? String(stored) : (selected[select] ?? options[0] ?? "");
  }

  function respond(action: UiAction): void {
    if (locked || !controller?.respond) return;
    setConfirming(undefined);
    const values: Record<string, string> = {};
    for (const field of spec.fields ?? []) {
      if ("select" in field) values[field.select] = selected[field.select] ?? field.options[0] ?? "";
    }
    sendResponse(
      spec,
      { actionId: action.id, ...(Object.keys(values).length > 0 ? { values } : {}) },
      controller.respond,
    );
  }

  return (
    <BlockCard
      title={spec.title}
      status={state.status}
      outcome={state.outcome}
      danger={spec.danger}
      busy={controller?.busy}
      error={controller?.error}
      onSkip={controller?.skip}
      disabled={controller?.disabled}
    >
      {(spec.fields?.length ?? 0) > 0 ? (
        <View className="gap-2">
          {spec.fields?.map((field) => (
            <View key={field.label} className="gap-1">
              <Typography type="body-xs" className="text-text-secondary">
                {field.label}
              </Typography>
              {"select" in field ? (
                <View className="flex-row flex-wrap gap-2">
                  {field.options.map((option) => (
                    <Button
                      key={option}
                      variant={selectValue(field.select, field.options) === option ? "primary" : "ghost"}
                      size="sm"
                      isDisabled={locked}
                      onPress={() => setSelected((current) => ({ ...current, [field.select]: option }))}
                    >
                      <Button.Label>{option}</Button.Label>
                    </Button>
                  ))}
                </View>
              ) : (
                <Typography>{field.value}</Typography>
              )}
            </View>
          ))}
        </View>
      ) : null}
      {spec.preview ? (
        <View className="gap-1">
          <Typography type="body-xs" className="text-text-secondary">
            {t("uiBlock.confirm.previewLabel")}
          </Typography>
          <View className={previewExpanded ? undefined : "max-h-40 overflow-hidden"}>
            <ChatMarkdown body={spec.preview} finished color={foreground} selectable={false} linkFavicons={false} />
          </View>
          <Button variant="ghost" size="sm" onPress={() => setPreviewExpanded((open) => !open)}>
            <Button.Label>
              {previewExpanded ? t("uiBlock.confirm.hideFullPreview") : t("uiBlock.confirm.showFullPreview")}
            </Button.Label>
          </Button>
        </View>
      ) : null}
      {!frozen ? (
        <View className="gap-2">
          {anyHeldHint(spec, isHeld) ? (
            <Typography type="body-xs" className="text-text-secondary" nativeID={hintId}>
              {t("uiBlock.confirm.holdHint")}
            </Typography>
          ) : null}
          {confirming ? (
            <View className="gap-2">
              <Typography>{t("uiBlock.confirm.prompt", { action: confirming.label })}</Typography>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  variant={actionStyle(confirming.style) === "danger" ? "danger" : "primary"}
                  onPress={() => respond(confirming)}
                >
                  <Button.Label>{t("uiBlock.confirm.accept")}</Button.Label>
                </Button>
                <Button variant="ghost" onPress={() => setConfirming(undefined)}>
                  <Button.Label>{t("common.cancel")}</Button.Label>
                </Button>
              </View>
            </View>
          ) : (
            <View className="flex-row flex-wrap gap-2">
              {spec.actions.map((action) =>
                isHeld(action) ? (
                  <ChatUiBlockHoldButton
                    key={action.id}
                    holdMs={holdMs}
                    style={actionStyle(action.style)}
                    disabled={locked}
                    describedBy={hintId}
                    onComplete={() => (action.confirm ? setConfirming(action) : respond(action))}
                    onClickWithoutHold={() => setConfirming(action)}
                  >
                    {action.label}
                  </ChatUiBlockHoldButton>
                ) : (
                  <Button
                    key={action.id}
                    variant={
                      actionStyle(action.style) === "danger"
                        ? "danger"
                        : actionStyle(action.style) === "primary"
                          ? "primary"
                          : "secondary"
                    }
                    isDisabled={locked}
                    onPress={() => (action.confirm ? setConfirming(action) : respond(action))}
                  >
                    <Button.Label>{action.label}</Button.Label>
                  </Button>
                ),
              )}
            </View>
          )}
        </View>
      ) : null}
    </BlockCard>
  );
}

function anyHeldHint(spec: Extract<UiBlockSpec, { type: "confirm" }>, isHeld: (action: UiAction) => boolean): boolean {
  return spec.actions.some(isHeld);
}

function QuickRepliesBlock({
  spec,
  state,
  controller,
}: {
  spec: Extract<UiBlockSpec, { type: "quick_replies" }>;
  state: UiBlockState;
  controller?: UiBlockPromptController;
}) {
  const { t } = useText();
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);
  const frozen = state.status !== "pending";
  const locked = frozen || controller?.disabled;
  const [picked, setPicked] = useState<string>();
  const [draft, setDraft] = useState("");
  const chosen = frozen ? state.response?.actionId : controller?.error ? undefined : picked;

  function choose(id: string): void {
    if (locked || !controller?.respond) return;
    if (sendResponse(spec, { actionId: id }, controller.respond)) setPicked(id);
  }

  function sendText(): void {
    const text = draft.trim();
    if (locked || text === "" || !controller?.respond) return;
    if (sendResponse(spec, { actionId: UI_BLOCK_TEXT_ACTION_ID, text }, controller.respond)) {
      setPicked(UI_BLOCK_TEXT_ACTION_ID);
    }
  }

  return (
    <View className="max-w-[88%] self-start gap-2">
      {spec.title ? <Typography weight="medium">{spec.title}</Typography> : null}
      <View className="flex-row flex-wrap gap-2">
        {spec.options.map((option) => (
          <Button
            key={option.id}
            variant={chosen === option.id ? "primary" : "secondary"}
            size="sm"
            isDisabled={locked}
            accessibilityState={{ selected: chosen === option.id }}
            onPress={() => choose(option.id)}
          >
            <Button.Label>{option.label}</Button.Label>
          </Button>
        ))}
      </View>
      {spec.allowText === true && !frozen ? (
        <View className="flex-row items-center gap-2 rounded-[18px] bg-default px-3">
          <TextInput
            accessibilityLabel={t("uiBlock.quick.textLabel")}
            editable={!locked}
            maxLength={UI_BLOCK_LIMITS.fieldValue}
            placeholder={t("uiBlock.quick.textPlaceholder")}
            placeholderTextColor={muted}
            {...selectionColorProps(foreground)}
            className="min-h-12 min-w-0 flex-1 font-sans text-foreground"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={sendText}
          />
          <Button variant="ghost" size="sm" isDisabled={locked || !draft.trim()} onPress={sendText}>
            <Button.Label>{t("uiBlock.quick.send")}</Button.Label>
          </Button>
        </View>
      ) : null}
      {controller?.skip ? (
        <Button variant="ghost" size="sm" isDisabled={locked || controller.busy} onPress={controller.skip}>
          <Button.Label>{t("uiBlock.skip")}</Button.Label>
        </Button>
      ) : null}
      {controller?.error ? (
        <Typography type="body-xs" accessibilityRole="alert">
          {controller.error}
        </Typography>
      ) : null}
      {frozen && state.outcome ? (
        <Typography type="body-sm" className="text-text-secondary">
          {state.outcome}
        </Typography>
      ) : null}
    </View>
  );
}

function ChoiceBlock({
  spec,
  state,
  controller,
}: {
  spec: Extract<UiBlockSpec, { type: "choice" }>;
  state: UiBlockState;
  controller?: UiBlockPromptController;
}) {
  const { t } = useText();
  const frozen = state.status !== "pending";
  const locked = frozen || controller?.disabled;
  const multiple = spec.multiple === true;
  const [picked, setPicked] = useState<string[]>(() =>
    spec.options.filter((option) => option.selected).map((option) => option.id),
  );
  const stored = state.response?.values?.[UI_CHOICE_VALUES_KEY];
  const chosen = frozen && Array.isArray(stored) ? stored : picked;
  const isChosen = (id: string) => chosen.includes(id);

  function toggle(id: string): void {
    if (locked) return;
    if (!multiple) setPicked([id]);
    else setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  function submit(): void {
    if (locked || picked.length === 0 || !controller?.respond) return;
    const selected = spec.options.filter((option) => picked.includes(option.id)).map((option) => option.id);
    sendResponse(
      spec,
      { actionId: UI_BLOCK_SUBMIT_ACTION_ID, values: { [UI_CHOICE_VALUES_KEY]: selected } },
      controller.respond,
    );
  }

  return (
    <BlockCard
      title={spec.title}
      status={state.status}
      outcome={state.outcome}
      busy={controller?.busy}
      error={controller?.error}
      onSkip={controller?.skip}
      disabled={controller?.disabled}
    >
      <View className="gap-1">
        {spec.options.map((option, index) => (
          <Pressable
            key={option.id}
            accessibilityRole={multiple ? "checkbox" : "radio"}
            accessibilityState={{ checked: isChosen(option.id), disabled: locked }}
            className={`min-h-12 flex-row items-center gap-2 rounded-[18px] px-2 py-2 ${isChosen(option.id) ? "bg-control" : ""}`}
            disabled={locked}
            onPress={() => toggle(option.id)}
          >
            <View className="w-10 items-center justify-center rounded-xl bg-control">
              <Typography type="body-sm" weight="medium" className="text-text-secondary">
                {optionLetter(index)}
              </Typography>
            </View>
            <Typography type="body-sm" weight="medium" className="min-w-0 flex-1">
              {option.label}
            </Typography>
            {option.meta ? (
              <Typography type="body-xs" className="text-text-secondary">
                {option.meta}
              </Typography>
            ) : null}
          </Pressable>
        ))}
      </View>
      {!frozen ? (
        <View className="gap-2">
          <Button isDisabled={locked || picked.length === 0} onPress={submit}>
            <Button.Label>{spec.submit ?? t("uiBlock.choice.submit")}</Button.Label>
          </Button>
          <Typography type="body-xs" className="text-text-secondary">
            {picked.length === 0
              ? t("uiBlock.choice.noneSelected")
              : multiple
                ? t("uiBlock.choice.selectedCount", { count: picked.length })
                : ""}
          </Typography>
        </View>
      ) : null}
    </BlockCard>
  );
}

function FormBlock({
  spec,
  state,
  controller,
}: {
  spec: Extract<UiBlockSpec, { type: "form" }>;
  state: UiBlockState;
  controller?: UiBlockPromptController;
}) {
  const { t } = useText();
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);
  const frozen = state.status !== "pending";
  const locked = frozen || controller?.disabled;
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(spec.fields.map((field) => [field.id, field.value ?? ""])),
  );
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [rejected, setRejected] = useState(false);

  function currentValue(field: UiFormField): string {
    const stored = frozen ? state.response?.values?.[field.id] : undefined;
    return typeof stored === "string" ? stored : (draft[field.id] ?? "");
  }

  function setValue(field: UiFormField, value: string): void {
    setDraft((current) => ({ ...current, [field.id]: value }));
    setRejected(false);
    if (failed.has(field.id) && value.trim() !== "") {
      setFailed((current) => new Set([...current].filter((id) => id !== field.id)));
    }
  }

  function submit(): void {
    if (locked || !controller?.respond) return;
    const missing = spec.fields.filter((field) => field.required === true && currentValue(field).trim() === "");
    setFailed(new Set(missing.map((field) => field.id)));
    if (missing.length > 0) return;
    const values: Record<string, string> = {};
    for (const field of spec.fields) {
      const value = currentValue(field);
      if (value.trim() !== "") values[field.id] = field.kind === "date" ? value.trim() : value;
    }
    setRejected(!sendResponse(spec, { actionId: UI_BLOCK_SUBMIT_ACTION_ID, values }, controller.respond));
  }

  return (
    <BlockCard
      title={spec.title}
      status={state.status}
      outcome={state.outcome}
      busy={controller?.busy}
      error={rejected ? t("uiBlock.form.invalid") : controller?.error}
      onSkip={controller?.skip}
      disabled={controller?.disabled}
    >
      <View className="gap-3">
        {spec.fields.map((field) => (
          <View key={field.id} className="gap-1">
            <Typography type="body-sm" weight="medium">
              {field.label ?? field.id}
              {field.required ? " *" : ""}
            </Typography>
            {field.kind === "segmented" || field.kind === "select" ? (
              <View className="flex-row flex-wrap gap-2">
                {field.options.map((option) => (
                  <Button
                    key={option}
                    variant={currentValue(field) === option ? "primary" : "ghost"}
                    size="sm"
                    isDisabled={locked}
                    onPress={() =>
                      setValue(field, currentValue(field) === option && field.required !== true ? "" : option)
                    }
                  >
                    <Button.Label>{option}</Button.Label>
                  </Button>
                ))}
              </View>
            ) : field.kind === "textarea" ? (
              <TextInput
                multiline
                editable={!locked}
                maxLength={UI_BLOCK_LIMITS.fieldValue}
                placeholder={"placeholder" in field ? field.placeholder : undefined}
                placeholderTextColor={muted}
                {...selectionColorProps(foreground)}
                className="min-h-24 rounded-[18px] bg-default px-3 py-2 font-sans text-foreground"
                value={currentValue(field)}
                onChangeText={(value) => setValue(field, value)}
              />
            ) : (
              <TextInput
                editable={!locked}
                maxLength={field.kind === "date" ? INPUT_LIMITS.promptAnswerText : UI_BLOCK_LIMITS.fieldValue}
                placeholder={
                  field.kind === "date" ? "YYYY-MM-DD" : "placeholder" in field ? field.placeholder : undefined
                }
                placeholderTextColor={muted}
                secureTextEntry={isSecretFormField(field)}
                autoCapitalize="none"
                autoCorrect={false}
                {...selectionColorProps(foreground)}
                className="min-h-12 rounded-[18px] bg-default px-3 font-sans text-foreground"
                value={currentValue(field)}
                onChangeText={(value) => setValue(field, value)}
              />
            )}
            {failed.has(field.id) ? (
              <Typography type="body-xs" accessibilityRole="alert">
                {t("uiBlock.form.required")}
              </Typography>
            ) : null}
          </View>
        ))}
      </View>
      {!frozen ? (
        <Button isDisabled={locked} onPress={submit}>
          <Button.Label>{spec.submit ?? t("uiBlock.form.submit")}</Button.Label>
        </Button>
      ) : null}
    </BlockCard>
  );
}

function blockTitle(spec: UiBlockSpec): string {
  if (spec.type === "quick_replies") return spec.title ?? "";
  return spec.title;
}

export function ChatUiBlock({
  block,
  controller,
  canSend,
  onActivate,
}: {
  block: ConversationUiBlock;
  controller?: UiBlockPromptController;
  canSend: boolean;
  onActivate?: () => void;
}) {
  const { t } = useText();
  const state = controller?.state ?? block.state;
  const active = state.status === "pending";
  if (active && !controller && onActivate) {
    return (
      <View className="max-w-[88%] self-start gap-2 rounded-[30px] bg-control/60 px-4 py-3">
        <Typography>{blockTitle(block.spec)}</Typography>
        <Button variant="ghost" onPress={onActivate}>
          <Button.Label>{t("mobile.chat.question.answerForm")}</Button.Label>
        </Button>
      </View>
    );
  }
  const spec = block.spec;
  const shared = { spec, state, controller: active && canSend ? controller : undefined };
  switch (spec.type) {
    case "confirm":
      return <ConfirmBlock {...shared} spec={spec} />;
    case "quick_replies":
      return <QuickRepliesBlock {...shared} spec={spec} />;
    case "choice":
      return <ChoiceBlock {...shared} spec={spec} />;
    case "form":
      return <FormBlock {...shared} spec={spec} />;
  }
}
