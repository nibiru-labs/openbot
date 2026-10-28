/**
 * The People section. It takes its id as a prop rather than importing the constant because the
 * section list is what decides where People sits in the order, and `data-section-id` has to carry
 * the same id the layout used - see `SIDEBAR_DRAG_SELECTORS`.
 */

import { Badge, Button } from "@openbot/ui";
import { Show } from "solid-js";
import { useText } from "../../text";
import { TeamPersonAvatar, teamMemberName } from "../team/TeamPersonAvatar";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { SidebarVirtualList } from "./SidebarVirtualList";
import { sidebarMessageTime } from "./sidebar-filtering";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarPeopleSection(sectionProps: { sectionId: string }) {
  const {
    directThreadByMember,
    dragOffset,
    orderedPeople,
    movePersonByKeyboard,
    props,
    sectionDragClasses,
    sectionIsCollapsed,
    sidebarClickIsSuppressed,
    startPersonDragging,
    stopSidebarDragging,
  } = useSidebarScope();
  const { t, format } = useText();
  const presence = (online: boolean) => (online ? t("sidebar.people.online") : t("sidebar.people.offline"));
  const sectionId = () => sectionProps.sectionId;
  const collapsed = () => sectionIsCollapsed(sectionId());
  return (
    <Show when={props.showPeople !== false && orderedPeople().length > 0}>
      <section
        class={["sidebar-chat-group sidebar-section", sectionDragClasses(sectionId())]}
        style={`--sidebar-drag-y: ${dragOffset(sectionId()).y}px;`}
        aria-label={t("sidebar.section.people")}
        data-section-id={sectionId()}
        onFocusIn={() => props.onPreloadDirectConversation?.()}
        onPointerEnter={() => props.onPreloadDirectConversation?.()}
      >
        <SidebarSectionHeader sectionId={sectionId()} name={t("sidebar.section.people")} />
        <div
          class="sidebar-section-collapse"
          data-collapsed={collapsed() ? "" : undefined}
          aria-hidden={collapsed() ? "true" : undefined}
          inert={collapsed() ? true : undefined}
        >
          <SidebarVirtualList
            bodyId={`sidebar-section-body-${sectionId()}`}
            items={orderedPeople}
            getKey={(member) => member.id}
            hidden={collapsed}
            pinnedIndex={() => {
              const activeId = props.activeDirectMemberId;
              if (!activeId) return -1;
              return orderedPeople().findIndex((member) => member.id === activeId);
            }}
            renderItem={(member, _index, virtual) => {
              const thread = () => directThreadByMember().get(member().id);
              return (
                /* biome-ignore lint/a11y/noStaticElementInteractions: Native drag belongs to the wrapper around the accessible button. */
                <div
                  class={["sidebar-person-item", { "sidebar-drag-shifting": dragOffset(member().id).y !== 0 }]}
                  data-index={virtual?.["data-index"]}
                  style={{
                    ...virtual?.style,
                    "--sidebar-drag-y": `${dragOffset(member().id).y}px`,
                  }}
                  ref={virtual?.ref}
                  data-person-id={member().id}
                  draggable={props.compact ? "false" : "true"}
                  onDragStart={(event: DragEvent & { currentTarget: HTMLElement }) =>
                    startPersonDragging(event, member())
                  }
                  onDragEnd={stopSidebarDragging}
                >
                  <Button
                    variant="ghost"
                    type="button"
                    class={["agent-row person-row", { "agent-row-active": props.activeDirectMemberId === member().id }]}
                    aria-label={`${teamMemberName(member())}. ${thread()?.lastMessage.text ?? presence(member().online)}`}
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    aria-pressed={props.activeDirectMemberId === member().id ? "true" : "false"}
                    data-cuelume-tap="navigate"
                    data-cuelume-emphasis="normal"
                    onClick={(event: MouseEvent) => {
                      if (sidebarClickIsSuppressed(event)) return;
                      props.onPreloadDirectConversation?.();
                      props.onSelectPerson(member().id);
                    }}
                    onKeyDown={(event: KeyboardEvent) => {
                      if (!event.altKey) return;
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        movePersonByKeyboard(member().id, -1);
                      } else if (event.key === "ArrowDown") {
                        event.preventDefault();
                        movePersonByKeyboard(member().id, 1);
                      }
                    }}
                  >
                    <span class="agent-row-avatar">
                      <TeamPersonAvatar member={member()} motion="hover" />
                      <Show when={(thread()?.unreadCount ?? 0) > 0}>
                        <Badge class="person-unread-badge" variant="primary-light" aria-hidden="true">
                          {Math.min(thread()?.unreadCount ?? 0, 99)}
                        </Badge>
                      </Show>
                    </span>
                    <span class="agent-row-copy">
                      <span class="agent-row-heading">
                        <strong>{teamMemberName(member())}</strong>
                        <span>{thread() ? sidebarMessageTime(thread()?.updatedAt ?? "", format) : ""}</span>
                      </span>
                      <span class="agent-row-preview">{thread()?.lastMessage.text ?? presence(member().online)}</span>
                    </span>
                    <Show when={(thread()?.unreadCount ?? 0) > 0}>
                      <span class="sr-only">{t("sidebar.people.unread", { count: thread()?.unreadCount ?? 0 })}</span>
                    </Show>
                  </Button>
                </div>
              );
            }}
          />
        </div>
      </section>
    </Show>
  );
}
