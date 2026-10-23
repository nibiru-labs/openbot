import {
  DEFAULT_LOCAL_SCRIPTS_NEW_AGENT_PREFERENCE,
  isLocalScriptsNewAgentPreference,
  type LocalScriptsNewAgentPreference,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

/**
 * The app setting that gives a new agent Local scripts from the start. The backend reads it each
 * time an agent is created on this computer, so it is held in memory after `load` rather than
 * read from disk each time.
 *
 * A file that is missing, unreadable as JSON or holds an unknown shape reads as off, which is
 * what every new agent did before the setting existed. Writes are chained for the reason
 * `update-preference-store.ts` chains its own: an earlier rename that lands last would persist
 * the value the user just changed.
 */
export class LocalScriptsNewAgentPreferenceStore {
  readonly #path: string;
  #preference: LocalScriptsNewAgentPreference = { ...DEFAULT_LOCAL_SCRIPTS_NEW_AGENT_PREFERENCE };
  #writes = Semaphore.makeUnsafe(1);

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): LocalScriptsNewAgentPreference | null =>
          isDynamicRecord(parsed) && parsed.version === 1 && isLocalScriptsNewAgentPreference(parsed)
            ? { allowForNewAgents: parsed.allowForNewAgents }
            : null,
        ),
      );
      if (Result.isSuccess(loaded)) {
        if (loaded.success) this.#preference = loaded.success;
      } else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get(): LocalScriptsNewAgentPreference {
    return { ...this.#preference };
  }

  readonly set = Effect.fn("LocalScriptsNewAgentPreference.set")(function* (
    this: LocalScriptsNewAgentPreferenceStore,
    { allowForNewAgents }: LocalScriptsNewAgentPreference,
  ) {
    yield* this.#writes.withPermit(
      Effect.uninterruptible(
        writePreferenceFile(this.#path, { version: 1, allowForNewAgents }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.#preference = { allowForNewAgents };
            }),
          ),
        ),
      ),
    );
    return this.get();
  });
}
