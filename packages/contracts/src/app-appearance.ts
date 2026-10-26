/**
 * The color scheme the user picks for the desktop app: follow the system, or keep it light or dark.
 * The main process sets `nativeTheme.themeSource` from it, so every window resolves
 * `prefers-color-scheme` to the scheme in use and the brand tokens follow.
 *
 * The identifiers cross the IPC boundary and are saved as written. Add one, never rename one: a
 * renamed identifier reads back as the default on the next launch.
 */
export const APP_APPEARANCES = ["system", "light", "dark"] as const;

export type AppAppearance = (typeof APP_APPEARANCES)[number];

export const DEFAULT_APP_APPEARANCE: AppAppearance = "system";

/** The preference as it is stored and as it crosses IPC. */
export interface AppAppearancePreference {
  appearance: AppAppearance;
}

export type SetAppAppearancePreferenceInput = AppAppearancePreference;

export function isAppAppearance(value: unknown): value is AppAppearance {
  return APP_APPEARANCES.some((appearance) => appearance === value);
}
