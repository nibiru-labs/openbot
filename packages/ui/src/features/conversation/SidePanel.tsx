import type { AppTextKey } from "@openbot/i18n";
import {
  AudioLines,
  Button,
  buttonVariants,
  DropdownMenu,
  Folder,
  Maximize2,
  MessageCircleQuestionMark,
  Minimize2,
  PanelRight,
  Plus,
  Settings,
  Workflow,
  X,
} from "@openbot/ui";
import { ComputerIcon } from "@openbot/ui/features/conversation/ConversationIcons";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { For, flush, onSettled, Show } from "solid-js";

/**
 * A pane of the side panel. Each open pane has a tab at the top of the panel. A side question opens
 * from the composer only, and a subagent from its row in the chat, so the launcher and Add do not
 * list them.
 */
export type SidePanelPane = "browser" | "files" | "settings" | "question" | "voice" | "subagent";

const PANE_LABELS: Record<SidePanelPane, AppTextKey> = {
  browser: "conversation.sidePanel.pane.browser",
  files: "conversation.sidePanel.pane.files",
  settings: "conversation.sidePanel.pane.settings",
  question: "conversation.sidePanel.pane.question",
  voice: "conversation.sidePanel.pane.voice",
  subagent: "conversation.sidePanel.pane.subagent",
};

/** The same glyphs as the rest of the app: the browser is the computer. */
function PaneIcon(props: { pane: SidePanelPane }): JSX.Element {
  switch (props.pane) {
    case "browser":
      return <ComputerIcon />;
    case "files":
      return <Folder aria-hidden="true" />;
    case "settings":
      return <Settings aria-hidden="true" />;
    case "question":
      return <MessageCircleQuestionMark aria-hidden="true" />;
    case "voice":
      return <AudioLines aria-hidden="true" />;
    case "subagent":
      return <Workflow aria-hidden="true" />;
  }
}

/** The region the header panel button opens and closes. */
export const CONVERSATION_SIDE_PANEL_ID = "conversation-side-panel";

export interface SidePanelToggleProps {
  open: boolean;
  /** The name of the agent that controls the browser now. */
  actingAgentName?: string | undefined;
  onToggle: () => void;
}

/** The panel button at the end of the chat header. Its dot shows browser control. */
export function SidePanelToggle(props: SidePanelToggleProps) {
  const { t } = useText();
  const label = () => {
    if (props.actingAgentName !== undefined)
      return t("conversation.header.browserActing", { name: props.actingAgentName });
    if (props.open) return t("conversation.sidePanel.close");
    return t("conversation.sidePanel.open");
  };
  return (
    <Button
      variant="ghost"
      type="button"
      class={[
        "header-panel-toggle side-panel-toggle",
        { "computer-button-agent-active": props.actingAgentName !== undefined },
      ]}
      aria-label={label()}
      title={label()}
      aria-expanded={props.open ? "true" : "false"}
      aria-controls={CONVERSATION_SIDE_PANEL_ID}
      onClick={() => props.onToggle()}
    >
      <PanelRight aria-hidden="true" class="size-[14px]" />
      <Show when={props.actingAgentName !== undefined}>
        <span class="computer-control-dot" aria-hidden="true" />
      </Show>
    </Button>
  );
}

export interface SidePanelHeaderProps {
  /** The open panes, in tab order. */
  panes: readonly SidePanelPane[];
  selected: SidePanelPane | null;
  /** The panes that this chat can open. */
  available: readonly SidePanelPane[];
  maximized: boolean;
  /** The name of the settings pane, when it holds other settings than an agent's. */
  settingsLabel?: string | undefined;
  onSelect: (pane: SidePanelPane) => void;
  onClose: (pane: SidePanelPane) => void;
  onToggleMaximized: () => void;
  onCollapse: () => void;
}

/**
 * The top row of the side panel: a tab for each open pane, then Add and Maximize. The tab icon is
 * also the close button of the tab; hover or focus shows its X. Add lists only the panes that are not
 * open, and goes away when all of them are.
 *
 * The tabs are one tab stop. The arrow keys, Home and End select a tab; Delete closes it. The close
 * button is for the pointer only, so the tab row holds only pane switches. The panes are labeled
 * regions of their own, not tab panels.
 */
export function SidePanelHeader(props: SidePanelHeaderProps) {
  const { t } = useText();
  let tabList: HTMLFieldSetElement | undefined;
  const closedPanes = () => props.available.filter((pane) => !props.panes.includes(pane));
  const paneLabel = (pane: SidePanelPane) =>
    pane === "settings" && props.settingsLabel !== undefined ? props.settingsLabel : t(PANE_LABELS[pane]);
  const focusPaneTab = (pane: SidePanelPane) => {
    tabList?.querySelector<HTMLElement>(`[data-key="${pane}"]`)?.focus();
  };
  /** Delete closes the tab. The closed tab leaves the list, so focus moves to the tab that takes its place. */
  const onTabKeyDown = (event: KeyboardEvent, pane: SidePanelPane) => {
    const panes = props.panes;
    const index = panes.indexOf(pane);
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = panes[(index + 1) % panes.length];
      if (next) {
        props.onSelect(next);
        focusPaneTab(next);
      }
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = panes[(index - 1 + panes.length) % panes.length];
      if (next) {
        props.onSelect(next);
        focusPaneTab(next);
      }
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      const next = panes[0];
      if (next) {
        props.onSelect(next);
        focusPaneTab(next);
      }
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const next = panes[panes.length - 1];
      if (next) {
        props.onSelect(next);
        focusPaneTab(next);
      }
      return;
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    flush(() => props.onClose(pane));
    const next = props.panes[Math.min(index, props.panes.length - 1)];
    if (next) focusPaneTab(next);
  };
  return (
    <div id={CONVERSATION_SIDE_PANEL_ID} class="window-drag side-panel-header">
      <fieldset ref={tabList} class="side-panel-tabs" aria-label={t("conversation.sidePanel.label")}>
        <For each={props.panes}>
          {(pane) => {
            const label = () => paneLabel(pane);
            const selected = () => props.selected === pane;
            return (
              <div role="presentation" class="side-panel-tab no-drag" data-selected={selected() ? "true" : undefined}>
                <Button
                  variant="ghost"
                  type="button"
                  class="side-panel-tab-close"
                  tabindex={-1}
                  aria-hidden="true"
                  title={t("conversation.sidePanel.closePane", { name: label() })}
                  onClick={() => props.onClose(pane)}
                >
                  <span class="side-panel-tab-icon">
                    <PaneIcon pane={pane} />
                  </span>
                  <X class="side-panel-tab-x" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  class="side-panel-tab-select"
                  data-key={pane}
                  aria-pressed={selected() ? "true" : "false"}
                  aria-keyshortcuts="Delete"
                  title={label()}
                  onClick={() => props.onSelect(pane)}
                  onFocus={(event) => event.relatedTarget !== null && !selected() && props.onSelect(pane)}
                  onKeyDown={(event) => onTabKeyDown(event, pane)}
                >
                  <span class="side-panel-tab-label">{label()}</span>
                </Button>
              </div>
            );
          }}
        </For>
      </fieldset>
      <div class="side-panel-actions no-drag">
        <Show when={props.panes.length > 0 && closedPanes().length > 0}>
          <DropdownMenu.Root placement="bottom-end" gutter={4}>
            <DropdownMenu.Trigger
              class={buttonVariants({ variant: "ghost", size: "icon-sm" })}
              aria-label={t("conversation.sidePanel.add")}
              title={t("conversation.sidePanel.add")}
            >
              <Plus aria-hidden="true" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content>
                <For each={closedPanes()}>
                  {(pane) => (
                    <DropdownMenu.Item class="side-panel-menu-item" onSelectAfterClose={() => props.onSelect(pane)}>
                      <PaneIcon pane={pane} />
                      {paneLabel(pane)}
                    </DropdownMenu.Item>
                  )}
                </For>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </Show>
        <Show when={props.panes.length > 0}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t(props.maximized ? "conversation.sidePanel.restore" : "conversation.sidePanel.maximize")}
            title={t(props.maximized ? "conversation.sidePanel.restore" : "conversation.sidePanel.maximize")}
            aria-pressed={props.maximized ? "true" : "false"}
            onClick={() => props.onToggleMaximized()}
          >
            <Show when={props.maximized} fallback={<Maximize2 aria-hidden="true" />}>
              <Minimize2 aria-hidden="true" />
            </Show>
          </Button>
        </Show>
        {/* A maximized panel covers the chat header and its panel button, so Collapse takes its place. */}
        <Show when={props.maximized}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("conversation.sidePanel.close")}
            title={t("conversation.sidePanel.close")}
            onClick={() => props.onCollapse()}
          >
            <PanelRight aria-hidden="true" />
          </Button>
        </Show>
      </div>
    </div>
  );
}

/**
 * With no open pane, the side panel lists the panes it can open. When the last tab closes, the focus
 * goes with it, so the first pane button takes the focus.
 */
export function SidePanelLauncher(props: {
  available: readonly SidePanelPane[];
  /** As in `SidePanelHeader`. */
  settingsLabel?: string | undefined;
  onOpen: (pane: SidePanelPane) => void;
}) {
  const { t } = useText();
  let launcher: HTMLElement | undefined;
  onSettled(() => {
    if (document.activeElement === null || document.activeElement === document.body)
      launcher?.querySelector<HTMLElement>("button")?.focus();
  });
  return (
    <nav ref={launcher} class="side-panel-launcher" aria-label={t("conversation.sidePanel.launcher")}>
      <For each={props.available}>
        {(pane) => (
          <Button variant="secondary" class="side-panel-launch" onClick={() => props.onOpen(pane)}>
            <PaneIcon pane={pane} />
            {t("conversation.sidePanel.openPane", {
              name:
                pane === "settings" && props.settingsLabel !== undefined ? props.settingsLabel : t(PANE_LABELS[pane]),
            })}
          </Button>
        )}
      </For>
    </nav>
  );
}
