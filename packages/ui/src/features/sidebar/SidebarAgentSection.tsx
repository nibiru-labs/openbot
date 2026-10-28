/**
 * One section - the unassigned one included. A custom section stays visible while empty so it can
 * be dropped into.
 *
 * The unassigned section keeps its heading only once a custom section exists. Before that it is the
 * whole list, and "Unassigned" names it against nothing.
 */

import { SIDEBAR_UNASSIGNED_SECTION_ID } from "@openbot/contracts/ipc";
import { Match, Show, Switch } from "solid-js";
import { useText } from "../../text";
import { SidebarAgentRow } from "./SidebarAgentRow";
import { SidebarChannelRow } from "./SidebarChannelRow";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { SidebarVirtualList } from "./SidebarVirtualList";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarAgentSection(sectionProps: { sectionId: string }) {
  const { customSectionById, dragOffset, filteredChatsBySection, props, sectionDragClasses, sectionIsCollapsed } =
    useSidebarScope();
  const { t } = useText();
  const sectionId = () => sectionProps.sectionId;
  const chats = () => filteredChatsBySection().get(sectionId()) ?? [];
  const custom = () => customSectionById().get(sectionId());
  const name = () =>
    sectionId() === SIDEBAR_UNASSIGNED_SECTION_ID ? t("sidebar.section.unassigned") : (custom()?.name ?? "");
  const headed = () => Boolean(custom()) || props.layout.sections.length > 0;
  const collapsed = () => headed() && sectionIsCollapsed(sectionId());
  return (
    <Show when={name() && (chats().length > 0 || custom())}>
      <section
        class={["sidebar-chat-group sidebar-section", sectionDragClasses(sectionId())]}
        style={`--sidebar-drag-y: ${dragOffset(sectionId()).y}px;`}
        aria-label={name()}
        data-section-id={sectionId()}
      >
        <Show when={headed()}>
          <SidebarSectionHeader sectionId={sectionId()} name={name()} />
        </Show>
        <div
          class="sidebar-section-collapse"
          data-collapsed={collapsed() ? "" : undefined}
          aria-hidden={collapsed() ? "true" : undefined}
          inert={collapsed() ? true : undefined}
        >
          <SidebarVirtualList
            bodyId={`sidebar-section-body-${sectionId()}`}
            items={chats}
            getKey={(chat) => chat.id}
            hidden={collapsed}
            pinnedIndex={() => {
              const activeId = props.activeAgentId ?? props.activeChannelId;
              if (!activeId) return -1;
              return chats().findIndex((chat) => chat.id === activeId);
            }}
            renderItem={(chat, _index, virtual) => {
              const item = chat();
              return (
                <Switch>
                  <Match when={item.kind === "agent" ? item.agent : undefined}>
                    {(agent) => <SidebarAgentRow agent={agent()} virtual={virtual} />}
                  </Match>
                  <Match when={item.kind === "channel" ? item.channel : undefined}>
                    {(channel) => <SidebarChannelRow channel={channel()} virtual={virtual} />}
                  </Match>
                </Switch>
              );
            }}
          />
        </div>
      </section>
    </Show>
  );
}
