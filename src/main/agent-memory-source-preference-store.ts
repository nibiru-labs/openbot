import {
  type AgentMemorySourcePreference,
  DEFAULT_AGENT_MEMORY_SOURCE,
  isAgentMemorySource,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

/**
 * Where an agent's memory lives, for agents with no source of their own. The backend reads it each
 * time a prompt or a tool list is built, so it is held in memory after `load` rather than read
 * from disk each time.
 *
 * A file that is missing, unreadable as JSON or names a value that is not a choice reads as the
 * default, which was the only behaviour before the setting existed. Writes are chained for the
 * reason `update-preference-store.ts` chains its own.
 */
export class AgentMemorySourcePreferenceStore {
  readonly #path: string;
  #preference: AgentMemorySourcePreference = { source: DEFAULT_AGENT_MEMORY_SOURCE };
  #writes = Semaphore.makeUnsafe(1);

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): AgentMemorySourcePreference | null =>
          isDynamicRecord(parsed) && parsed.version === 1 && isAgentMemorySource(parsed.source)
            ? { source: parsed.source }
            : null,
        ),
      );
      if (Result.isSuccess(loaded)) {
        if (loaded.success) this.#preference = loaded.success;
      } else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get(): AgentMemorySourcePreference {
    return { ...this.#preference };
  }

  readonly set = Effect.fn("AgentMemorySourcePreference.set")(function* (
    this: AgentMemorySourcePreferenceStore,
    { source }: AgentMemorySourcePreference,
  ) {
    yield* this.#writes.withPermit(
      Effect.uninterruptible(
        writePreferenceFile(this.#path, { version: 1, source }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.#preference = { source };
            }),
          ),
        ),
      ),
    );
    return this.get();
  });
}

/** The memory source as Settings sets it. */
export interface AgentMemorySourceSetting {
  get(): AgentMemorySourcePreference;
  set(preference: AgentMemorySourcePreference): Effect.Effect<AgentMemorySourcePreference, PreferenceFileFailure>;
  /** Calls `listener` with each saved source, so the window of this computer shows a remote change. */
  subscribe(listener: (preference: AgentMemorySourcePreference) => void): () => void;
}

/** The developer instructions and the tool lists state the source, so a new source reloads every agent's threads. */
export function reloadingAgentMemorySource(
  store: AgentMemorySourcePreferenceStore,
  agents: { memorySourceChanged(): void },
): AgentMemorySourceSetting {
  const listeners = new Set<(preference: AgentMemorySourcePreference) => void>();
  return {
    get: () => store.get(),
    set: (preference) =>
      store.set(preference).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            agents.memorySourceChanged();
            for (const listener of listeners) listener(saved);
          }),
        ),
      ),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
