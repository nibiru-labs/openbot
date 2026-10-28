/**
 * A section body that renders only the chat rows near the sidebar scroll view. While a native drag
 * runs, every row mounts so `measureSidebarDragSlots` can read them.
 */

import type { JSX } from "@solidjs/web";
import { type Accessor, createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { createListVirtualizer } from "../../components/createListVirtualizer";
import type { VirtualRowProps } from "../../components/VirtualListbox";
import { useSidebarScope } from "./sidebar-scope";

const OVERSCAN = 8;
/** 54px row height plus the 4px gap the CSS puts between items. */
const ROW_ESTIMATE = 58;
/** Short lists stay in normal flow; the virtualizer pays off above this. */
const STATIC_LIMIT = 30;

interface SidebarVirtualListProps<T> {
  bodyId: string;
  items: Accessor<T[]>;
  getKey: (item: T) => string;
  estimateSize?: number;
  hidden?: Accessor<boolean>;
  pinnedIndex?: Accessor<number>;
  renderItem: (item: Accessor<T>, index: Accessor<number>, virtual: VirtualRowProps | undefined) => JSX.Element;
}

function calculateScrollMargin(scrollElement: HTMLElement | undefined, listRoot: HTMLElement | undefined): number {
  if (!scrollElement || !listRoot) return 0;
  return Math.max(
    0,
    listRoot.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop,
  );
}

export function SidebarVirtualList<T>(props: SidebarVirtualListProps<T>) {
  const { draggingKind, getAgentList } = useSidebarScope();
  let listRoot: HTMLDivElement | undefined;
  const [scrollMargin, setScrollMargin] = createSignal(0);
  const estimate = () => props.estimateSize ?? ROW_ESTIMATE;

  const shouldVirtualize = createMemo(() => {
    if (props.hidden?.()) return false;
    if (draggingKind() !== undefined) return false;
    return props.items().length > STATIC_LIMIT;
  });

  const rows = createMemo(() => props.items().map((item) => ({ key: props.getKey(item), size: estimate() })));

  const virtualizer = createListVirtualizer({
    rows,
    getScrollElement: getAgentList,
    scrollMargin,
    pinnedIndex: () => (shouldVirtualize() ? (props.pinnedIndex?.() ?? -1) : -1),
    overscan: OVERSCAN,
  });

  const refreshScrollMargin = (): void => {
    setScrollMargin(calculateScrollMargin(getAgentList(), listRoot));
  };

  onSettled(() => {
    refreshScrollMargin();
    const list = getAgentList();
    list?.addEventListener("scroll", refreshScrollMargin, { passive: true });
    return () => list?.removeEventListener("scroll", refreshScrollMargin);
  });

  createEffect(
    () => ({ count: props.items().length, hidden: props.hidden?.() }),
    () => {
      queueMicrotask(refreshScrollMargin);
    },
  );

  return (
    <div
      ref={listRoot}
      id={props.bodyId}
      class="sidebar-section-body"
      data-virtualized={shouldVirtualize() ? "" : undefined}
      style={shouldVirtualize() ? { height: `${virtualizer.totalSize()}px` } : undefined}
    >
      <Show when={!props.hidden?.()}>
        <Show
          when={shouldVirtualize()}
          fallback={<For each={props.items()}>{(item, index) => props.renderItem(() => item, index, undefined)}</For>}
        >
          <For each={virtualizer.items()} keyed={(item) => item.key}>
            {(item) => {
              const index = () => item().index;
              const rowItem = () => props.items()[index()];
              return (
                <Show when={rowItem()}>
                  {(current) =>
                    props.renderItem(current, index, {
                      get "data-index"() {
                        return item().index;
                      },
                      get style() {
                        return { top: `${item().start - scrollMargin()}px` };
                      },
                      ref: virtualizer.measureElement,
                    })
                  }
                </Show>
              );
            }}
          </For>
        </Show>
      </Show>
    </div>
  );
}
