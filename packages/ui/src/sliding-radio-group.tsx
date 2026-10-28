import type { ComponentProps, JSX } from "@solidjs/web";
import { createEffect, onCleanup } from "solid-js";
import { RadioGroup } from "./complex";
import { cx } from "./utils";

export type SlidingRadioGroupRootProps = ComponentProps<typeof RadioGroup.Root> & {
  class?: string | undefined;
};

export type SlidingRadioGroupItemProps = ComponentProps<typeof RadioGroup.Item> & {
  class?: string | undefined;
  children: JSX.Element;
};

function SlidingRadioGroupRoot(props: SlidingRadioGroupRootProps) {
  const { class: className, ...others } = props;
  let group: HTMLElement | undefined;
  let pill: HTMLSpanElement | undefined;
  let chosen = -1;
  let placed = false;
  let readyFrame: number | undefined;
  let disposed = false;

  const placePill = (slide: boolean) => {
    if (!group || !pill) return;
    const control = group.querySelectorAll<HTMLElement>(".ui-sliding-tabs-trigger")[chosen];
    pill.hidden = !control;
    if (!control) return;
    const still = !slide || !placed;
    if (still) pill.dataset.initializing = "";
    pill.style.width = `${control.offsetWidth}px`;
    pill.style.transform = `translateX(${control.offsetLeft}px)`;
    if (still) {
      pill.getBoundingClientRect();
      delete pill.dataset.initializing;
    }
    placed = true;
  };

  createEffect(
    () => group?.querySelector<HTMLElement>('.ui-sliding-tabs-trigger[data-checked="true"]'),
    (control) => {
      if (!group || !control) return;
      const controls = [...group.querySelectorAll<HTMLElement>(".ui-sliding-tabs-trigger")];
      chosen = controls.indexOf(control);
      placePill(true);
    },
  );

  const resize = new ResizeObserver(() => placePill(false));
  onCleanup(() => {
    disposed = true;
    if (readyFrame !== undefined) window.cancelAnimationFrame(readyFrame);
    resize.disconnect();
  });

  return (
    <RadioGroup.Root
      {...others}
      ref={(element: HTMLElement) => {
        group = element;
        resize.observe(element);
      }}
      orientation={props.orientation ?? "horizontal"}
      class={cx("ui-sliding-tabs", className)}
    >
      <span
        ref={(element) => {
          pill = element;
          if (disposed) return;
          readyFrame = window.requestAnimationFrame(() => {
            if (!pill) return;
            void pill.offsetWidth;
            delete pill.dataset.initializing;
          });
        }}
        class="ui-sliding-tabs-pill"
        data-initializing=""
        aria-hidden="true"
      />
      {props.children}
    </RadioGroup.Root>
  );
}

function SlidingRadioGroupItem(props: SlidingRadioGroupItemProps) {
  const { class: className, children, ...others } = props;
  let control: HTMLElement | undefined;
  const resize = new ResizeObserver(() => {
    if (!control) return;
    const group = control.closest<HTMLElement>(".ui-sliding-tabs");
    if (!group) return;
    const pill = group.querySelector<HTMLElement>(".ui-sliding-tabs-pill");
    const checked = group.querySelector<HTMLElement>('.ui-sliding-tabs-trigger[data-checked="true"]');
    if (!pill || !checked) return;
    pill.style.width = `${checked.offsetWidth}px`;
    pill.style.transform = `translateX(${checked.offsetLeft}px)`;
  });
  onCleanup(() => resize.disconnect());

  return (
    <RadioGroup.Item {...others} class="ui-sliding-tabs-item">
      <RadioGroup.ItemInput />
      <RadioGroup.ItemControl
        ref={(element: HTMLElement) => {
          control = element;
          if (control) resize.observe(control);
        }}
        class={cx("ui-sliding-tabs-trigger", className)}
      >
        <RadioGroup.ItemLabel>{children}</RadioGroup.ItemLabel>
      </RadioGroup.ItemControl>
    </RadioGroup.Item>
  );
}

/** A single choice from many, with SlidingTabs visuals and a radiogroup role. */
export const SlidingRadioGroup = {
  Root: SlidingRadioGroupRoot,
  Item: SlidingRadioGroupItem,
};
