import { type AppAppearancePreference, DEFAULT_APP_APPEARANCE, isAppAppearance } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Semaphore } from "effect";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

const DEFAULT_PREFERENCE: AppAppearancePreference = { appearance: DEFAULT_APP_APPEARANCE };

/**
 * The saved appearance, or the default. A file that is missing, unreadable or names a value this
 * build does not know reads as the default: a lost choice must not stop the app from starting.
 */
const readAppearancePreference = Effect.fn("AppearancePreference.read")((path: string) =>
  readPreferenceFile(path, (parsed): AppAppearancePreference => {
    if (!isDynamicRecord(parsed) || parsed.version !== 1 || !isAppAppearance(parsed.appearance))
      return { ...DEFAULT_PREFERENCE };
    return { appearance: parsed.appearance };
  }).pipe(Effect.catch(() => Effect.succeed({ ...DEFAULT_PREFERENCE }))),
);

const writeAppearancePreference = Effect.fn("AppearancePreference.write")(function* (
  path: string,
  preference: AppAppearancePreference,
) {
  yield* writePreferenceFile(path, { version: 1, appearance: preference.appearance });
  return { appearance: preference.appearance };
});

/**
 * The light or dark scheme of every window. The main process holds it because it sets
 * `nativeTheme.themeSource`, which the renderers read as `prefers-color-scheme`, and it tells each
 * window about a change through `subscribe`.
 */
export class AppearanceService {
  readonly #path: string;
  readonly #listeners = new Set<(preference: AppAppearancePreference) => void>();
  #preference: AppAppearancePreference = { ...DEFAULT_PREFERENCE };
  #writes = Semaphore.makeUnsafe(1);

  constructor(input: { path: string }) {
    this.#path = input.path;
  }

  get preference(): AppAppearancePreference {
    return { ...this.#preference };
  }

  /** Read the saved preference. Called once at startup, before the first window loads. */
  load(): Effect.Effect<AppAppearancePreference, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      this.#preference = yield* readAppearancePreference(this.#path);
      return this.preference;
    });
  }

  /** Serialized, as `LogoColorService.set` is, so two quick choices save the last one. */
  set(preference: AppAppearancePreference): Effect.Effect<AppAppearancePreference, PreferenceFileFailure> {
    return this.#writes.withPermit(this.#write(preference));
  }

  #write(preference: AppAppearancePreference): Effect.Effect<AppAppearancePreference, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      this.#preference = yield* writeAppearancePreference(this.#path, preference);
      for (const listener of this.#listeners) listener(this.preference);
      return this.preference;
    }).pipe(Effect.uninterruptible);
  }

  subscribe(listener: (preference: AppAppearancePreference) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
