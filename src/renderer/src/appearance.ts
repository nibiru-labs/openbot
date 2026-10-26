import { type AppAppearance, DEFAULT_APP_APPEARANCE } from "@openbot/contracts/ipc";
import { createSignal, onSettled } from "solid-js";
import { appPort } from "./app-port";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/**
 * Keeps `data-appearance` on the root element on the scheme in use, which selects the light brand
 * tokens. In the desktop app main sets `nativeTheme.themeSource` from the saved choice before the
 * renderer loads, so the media query already answers for it and the first paint is in the right
 * scheme. The preview and Storybook have no native theme, so a saved "light" or "dark" applies
 * directly there. The Dynamic Island and the highlight overlay do not call this and stay dark.
 */
export function syncAppearance(): () => void {
  const query = window.matchMedia(LIGHT_QUERY);
  let choice: AppAppearance = DEFAULT_APP_APPEARANCE;
  const apply = () => {
    const light = choice === "system" ? query.matches : choice === "light";
    document.documentElement.dataset.appearance = light ? "light" : "dark";
  };
  const choose = (next: AppAppearance) => {
    choice = next;
    apply();
  };
  apply();
  query.addEventListener("change", apply);
  void appPort()
    .getAppAppearancePreference()
    .then((preference) => choose(preference.appearance))
    .catch(() => undefined);
  const unsubscribe = appPort().onAppAppearancePreference((preference) => choose(preference.appearance));
  return () => {
    query.removeEventListener("change", apply);
    unsubscribe();
    delete document.documentElement.dataset.appearance;
  };
}

/** The Settings control state. Set optimistically, and reverted if main refuses the write. */
export function useAppearanceChoice() {
  const [appearance, setAppearance] = createSignal<AppAppearance>(DEFAULT_APP_APPEARANCE);
  let confirmed: AppAppearance = DEFAULT_APP_APPEARANCE;
  let latestRequest = 0;
  let pending = 0;

  /** A saved value from main. A choice that is still in flight is newer, so it stays on screen. */
  function confirm(next: AppAppearance): void {
    confirmed = next;
    if (pending === 0) setAppearance(next);
  }

  function changeAppearance(next: AppAppearance): void {
    const request = ++latestRequest;
    pending += 1;
    setAppearance(next);
    void appPort()
      .setAppAppearancePreference({ appearance: next })
      .then((preference) => {
        confirmed = preference.appearance;
        if (request === latestRequest) setAppearance(preference.appearance);
      })
      .catch(() => {
        if (request === latestRequest) setAppearance(confirmed);
      })
      .finally(() => {
        pending -= 1;
      });
  }

  onSettled(() => {
    void appPort()
      .getAppAppearancePreference()
      .then((preference) => confirm(preference.appearance))
      .catch(() => undefined);
    return appPort().onAppAppearancePreference((preference) => confirm(preference.appearance));
  });

  return { appearance, changeAppearance };
}
