import { prefersReducedMotion } from "@openbot/ui/utils";
import { createEffect, onCleanup, onSettled } from "solid-js";

interface SmoothHeightResizeOptions {
  container: () => HTMLElement | undefined;
  content: () => HTMLElement | undefined;
  enabled?: () => boolean;
  skip?: () => boolean;
}

/** True when a resize callback should read layout and maybe animate. Used by perf e2e. */
export function smoothHeightResizeWouldProcess(enabled?: () => boolean): boolean {
  return enabled?.() !== false && !prefersReducedMotion();
}

export function createSmoothHeightResize(options: SmoothHeightResizeOptions): void {
  let animation: Animation | undefined;
  let previousHeight: number | undefined;
  let observer: ResizeObserver | undefined;
  let observedContent: HTMLElement | undefined;

  const finishAnimation = (current?: Animation) => {
    if (current && animation !== current) return;
    animation = undefined;
    options.container()?.removeAttribute("data-resizing");
  };

  const cancelAnimation = () => {
    animation?.cancel();
    finishAnimation();
  };

  const disconnectObserver = () => {
    observer?.disconnect();
    observer = undefined;
    observedContent = undefined;
    previousHeight = undefined;
  };

  const onResize = () => {
    if (!smoothHeightResizeWouldProcess(options.enabled)) return;
    const container = options.container();
    const content = options.content();
    if (!container || !content) return;
    const nextHeight = content.getBoundingClientRect().height;
    const previous = previousHeight;
    previousHeight = nextHeight;
    if (previous === undefined || previous === nextHeight) return;
    if (options.skip?.()) {
      cancelAnimation();
      return;
    }

    const animatedHeight = Number.parseFloat(getComputedStyle(container).height);
    const startHeight = animation && Number.isFinite(animatedHeight) ? animatedHeight : previous;
    animation?.cancel();
    container.setAttribute("data-resizing", "true");
    const current = container.animate([{ height: `${startHeight}px` }, { height: `${nextHeight}px` }], {
      duration: resizeDuration(),
      easing: resizeEasing(),
    });
    animation = current;
    void current.finished.then(() => finishAnimation(current)).catch(() => undefined);
  };

  onSettled(() => {
    createEffect(
      () => smoothHeightResizeWouldProcess(options.enabled),
      (observing) => {
        if (!observing) {
          disconnectObserver();
          cancelAnimation();
          return;
        }
        const content = options.content();
        if (!content) {
          disconnectObserver();
          return;
        }
        observer ??= new ResizeObserver(onResize);
        if (observedContent !== content) {
          if (observedContent) observer.unobserve(observedContent);
          observer.observe(content);
          observedContent = content;
          previousHeight = undefined;
        }
      },
    );
    return () => disconnectObserver();
  });

  onCleanup(cancelAnimation);
}

function resizeDuration(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--openbot-duration-overlay").trim();
  if (value.endsWith("ms")) return Number.parseFloat(value) || 240;
  if (value.endsWith("s")) return (Number.parseFloat(value) || 0.24) * 1_000;
  return 240;
}

function resizeEasing(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--openbot-ease-out").trim() ||
    "cubic-bezier(0.23, 1, 0.32, 1)"
  );
}
