import {
  AGENT_MEMORY_LIMITS,
  type AgentMemoryLimit,
  APP_APPEARANCES,
  type AppAppearance,
  type AppVariant,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
  SwitchField,
} from "@openbot/ui";
import type { GeneralSettingsValue } from "@openbot/ui/features/settings/app-settings";
import { LanguageSelect } from "@openbot/ui/features/settings/LanguageSelect";
import { LogoColorPicker } from "@openbot/ui/features/settings/LogoColorPicker";
import { SendShortcutSelect } from "@openbot/ui/features/settings/SendShortcutSelect";
import { useText } from "@openbot/ui/text";
import { Show } from "solid-js";
import { useAppearanceChoice } from "../../appearance";
import { useI18n } from "../../i18n-context";
import { useLogoColorChoice } from "../../logo-color";

const APPEARANCE_KEYS = {
  system: "settings.colorScheme.system",
  light: "settings.colorScheme.light",
  dark: "settings.colorScheme.dark",
} as const satisfies Record<AppAppearance, AppTextKey>;

const linkTargetOptions: GeneralSettingsValue["externalLinkTarget"][] = ["Default browser", "OpenBot"];

/**
 * The saved value is the English name, because it is what `app-settings.ts` persists and what the
 * main process compares against. Only the label a reader sees is translated.
 */
const LINK_TARGET_KEYS = {
  "Default browser": "settings.externalLinks.defaultBrowser",
  OpenBot: "settings.externalLinks.openbot",
} as const satisfies Record<GeneralSettingsValue["externalLinkTarget"], AppTextKey>;

interface SettingsGeneralTabProps {
  value: GeneralSettingsValue;
  /** The device with the keyboard, naming ⌘ or Ctrl in the shortcut option. */
  platform?: "darwin" | "win32" | "linux" | undefined;
  /** A dev or preview build keeps its own logo color, so the logo color row says so. */
  variant: AppVariant;
  /** The dialog element the Select popovers portal into, captured when the tab was created. */
  selectMount: HTMLElement | undefined;
  onUpdateSetting: <Key extends keyof GeneralSettingsValue>(key: Key, value: GeneralSettingsValue[Key]) => void;
  onUpdateSettings: (patch: Partial<GeneralSettingsValue>) => void;
}

export function SettingsGeneralTab(props: SettingsGeneralTabProps) {
  const i18n = useI18n();
  const linkTargetLabel = (value: GeneralSettingsValue["externalLinkTarget"] | undefined) =>
    value === undefined ? "" : i18n.t(LINK_TARGET_KEYS[value]);
  const logoColor = useLogoColorChoice();
  const appearance = useAppearanceChoice();
  return (
    <>
      <SettingsSection title={i18n.t("settings.appearance.title")}>
        <ItemGroup class="settings-modal-card">
          <Item data-settings-row="settings.language.title" class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{i18n.t("settings.language.title")}</ItemTitle>
              <ItemDescription>{i18n.t("settings.language.description")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <LanguageSelect value={i18n.language()} onChange={i18n.changeLanguage} mount={props.selectMount} />
            </ItemActions>
          </Item>
          <Item data-settings-row="settings.colorScheme.title" class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{i18n.t("settings.colorScheme.title")}</ItemTitle>
              <ItemDescription>{i18n.t("settings.colorScheme.description")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Select<AppAppearance>
                class="settings-modal-select"
                options={[...APP_APPEARANCES]}
                value={appearance.appearance()}
                onChange={(value) => value && appearance.changeAppearance(value)}
                placement="bottom-end"
                itemComponent={(selectProps) => (
                  <SelectItem item={selectProps.item}>{i18n.t(APPEARANCE_KEYS[selectProps.item.rawValue])}</SelectItem>
                )}
              >
                <SelectTrigger size="sm" aria-label={i18n.t("settings.colorScheme.title")}>
                  <SelectValue<AppAppearance>>
                    {(state) => {
                      const selected = state.selectedOption();
                      return selected ? i18n.t(APPEARANCE_KEYS[selected]) : "";
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent mount={props.selectMount} />
              </Select>
            </ItemActions>
          </Item>
          <Item data-settings-row="settings.logoColor.title" class="settings-modal-row settings-logo-color-row">
            <ItemContent>
              <ItemTitle>{i18n.t("settings.logoColor.title")}</ItemTitle>
              <ItemDescription>{i18n.t("settings.logoColor.description")}</ItemDescription>
              <Show when={props.variant !== "production"}>
                <ItemDescription>{i18n.t("settings.logoColor.buildNote")}</ItemDescription>
              </Show>
            </ItemContent>
            <LogoColorPicker value={logoColor.color()} onChange={logoColor.changeColor} />
          </Item>
        </ItemGroup>
      </SettingsSection>

      <SettingsSection title={i18n.t("settings.conversations.title")}>
        <ItemGroup class="settings-modal-card">
          <Item data-settings-row="settings.sendShortcut.title" class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{i18n.t("settings.sendShortcut.title")}</ItemTitle>
              <ItemDescription>{i18n.t("settings.sendShortcut.description")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <SendShortcutSelect
                value={props.value.sendShortcut}
                onChange={(mode) => props.onUpdateSetting("sendShortcut", mode)}
                devicePlatform={props.platform ?? "darwin"}
                mount={props.selectMount}
              />
            </ItemActions>
          </Item>
          <SwitchField
            data-settings-row="settings.busyMessage.title"
            checked={props.value.busyMessageMode === "steer"}
            onChange={(checked) => props.onUpdateSetting("busyMessageMode", checked ? "steer" : "queue")}
            label={i18n.t("settings.busyMessage.title")}
            description={i18n.t("settings.busyMessage.description")}
          />
          <Item data-settings-row="settings.agentMemoryLimit.title" class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{i18n.t("settings.agentMemoryLimit.title")}</ItemTitle>
              <ItemDescription>{i18n.t("settings.agentMemoryLimit.description")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Select<AgentMemoryLimit>
                class="settings-modal-select"
                options={[...AGENT_MEMORY_LIMITS]}
                value={props.value.agentMemoryLimit}
                onChange={(value) => value && props.onUpdateSetting("agentMemoryLimit", value)}
                placement="bottom-end"
                itemComponent={(selectProps) => (
                  <SelectItem item={selectProps.item}>{String(selectProps.item.rawValue)}</SelectItem>
                )}
              >
                <SelectTrigger size="sm" aria-label={i18n.t("settings.agentMemoryLimit.title")}>
                  <SelectValue<AgentMemoryLimit>>{(state) => String(state.selectedOption() ?? "")}</SelectValue>
                </SelectTrigger>
                <SelectContent mount={props.selectMount} />
              </Select>
            </ItemActions>
          </Item>
          <TokenLimitRow
            row="hour"
            value={props.value.tokenBudgetPerHour}
            choices={TOKEN_LIMIT_HOUR_CHOICES}
            selectMount={props.selectMount}
            onChange={(value) => props.onUpdateSetting("tokenBudgetPerHour", value)}
          />
          <TokenLimitRow
            row="turn"
            value={props.value.tokenBudgetPerTurn}
            choices={TOKEN_LIMIT_TURN_CHOICES}
            selectMount={props.selectMount}
            onChange={(value) => props.onUpdateSetting("tokenBudgetPerTurn", value)}
          />
          <Item data-settings-row="settings.externalLinks.title" class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{i18n.t("settings.externalLinks.title")}</ItemTitle>
              <ItemDescription>{i18n.t("settings.externalLinks.description")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Select<GeneralSettingsValue["externalLinkTarget"]>
                class="settings-modal-select"
                options={linkTargetOptions}
                value={props.value.externalLinkTarget}
                onChange={(value) => value && props.onUpdateSetting("externalLinkTarget", value)}
                placement="bottom-end"
                itemComponent={(selectProps) => (
                  <SelectItem item={selectProps.item}>{linkTargetLabel(selectProps.item.rawValue)}</SelectItem>
                )}
              >
                <SelectTrigger size="sm" aria-label={i18n.t("settings.externalLinks.title")}>
                  <SelectValue<GeneralSettingsValue["externalLinkTarget"]>>
                    {(state) => linkTargetLabel(state.selectedOption())}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent mount={props.selectMount} />
              </Select>
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsSection>

      <SettingsSection title={i18n.t("settings.appBehavior.title")}>
        <ItemGroup class="settings-modal-card">
          <SwitchField
            data-settings-row="settings.launchAtLogin.title"
            checked={props.value.launchAtLogin}
            onChange={(checked) => props.onUpdateSetting("launchAtLogin", checked)}
            label={i18n.t("settings.launchAtLogin.title")}
            description={i18n.t("settings.launchAtLogin.description")}
          />
          <SwitchField
            data-settings-row="settings.keepRemoteSessions.title"
            checked={props.value.keepRemoteSessions}
            onChange={(checked) => props.onUpdateSetting("keepRemoteSessions", checked)}
            label={i18n.t("settings.keepRemoteSessions.title")}
            description={i18n.t("settings.keepRemoteSessions.description")}
          />
          <SwitchField
            data-settings-row="settings.keepRunning.title"
            checked={props.value.keepRunningInBackground}
            onChange={(checked) => props.onUpdateSetting("keepRunningInBackground", checked)}
            label={i18n.t("settings.keepRunning.title")}
            description={i18n.t("settings.keepRunning.description")}
          />
          <SwitchField
            data-settings-row="settings.restoreWorkspace.title"
            checked={props.value.restoreLastWorkspace}
            onChange={(checked) => props.onUpdateSetting("restoreLastWorkspace", checked)}
            label={i18n.t("settings.restoreWorkspace.title")}
            description={i18n.t("settings.restoreWorkspace.description")}
          />
        </ItemGroup>
      </SettingsSection>

      <SettingsSection title={i18n.t("settings.permissions.title")}>
        <ItemGroup class="settings-modal-card">
          <SwitchField
            data-settings-row="settings.analytics.title"
            checked={props.value.productAnalytics}
            onChange={(checked) => props.onUpdateSetting("productAnalytics", checked)}
            label={i18n.t("settings.analytics.title")}
            description={i18n.t("settings.analytics.description")}
          />
        </ItemGroup>
      </SettingsSection>
    </>
  );
}

/** The limits the menu offers. 0 is no limit. A saved limit outside the list is offered too. */
const TOKEN_LIMIT_HOUR_CHOICES = [0, 5_000_000, 15_000_000, 30_000_000, 60_000_000, 150_000_000] as const;
const TOKEN_LIMIT_TURN_CHOICES = [0, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 25_000_000] as const;

const TOKEN_LIMIT_KEYS = {
  hour: {
    title: "settings.tokenBudget.hour.title",
    description: "settings.tokenBudget.hour.description",
  },
  turn: {
    title: "settings.tokenBudget.turn.title",
    description: "settings.tokenBudget.turn.description",
  },
} as const satisfies Record<"hour" | "turn", { title: AppTextKey; description: AppTextKey }>;

function TokenLimitRow(props: {
  row: "hour" | "turn";
  value: number;
  choices: readonly number[];
  selectMount: HTMLElement | undefined;
  onChange: (value: number) => void;
}) {
  const { t, format } = useText();
  const keys = TOKEN_LIMIT_KEYS[props.row];
  const options = () =>
    props.choices.includes(props.value) ? [...props.choices] : [...props.choices, props.value].sort((a, b) => a - b);
  const label = (value: number | undefined) =>
    value === undefined
      ? ""
      : value === 0
        ? t("settings.tokenBudget.unlimited")
        : t("settings.tokenBudget.option", { amount: format.compact(value) });
  return (
    <Item data-settings-row={keys.title} class="settings-modal-row">
      <ItemContent>
        <ItemTitle>{t(keys.title)}</ItemTitle>
        <ItemDescription>{t(keys.description)}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Select<number>
          class="settings-modal-select"
          options={options()}
          value={props.value}
          onChange={(value) => value !== null && value !== undefined && props.onChange(value)}
          placement="bottom-end"
          itemComponent={(selectProps) => (
            <SelectItem item={selectProps.item}>{label(selectProps.item.rawValue)}</SelectItem>
          )}
        >
          <SelectTrigger size="sm" aria-label={t(keys.title)}>
            <SelectValue<number>>{(state) => label(state.selectedOption() ?? undefined)}</SelectValue>
          </SelectTrigger>
          <SelectContent mount={props.selectMount} />
        </Select>
      </ItemActions>
    </Item>
  );
}
