import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { OpenswarmSettings } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";
import { Effect, Exit, Schema, Scope, Semaphore } from "effect";
import { writeFileAtomically, writeJsonFileAtomically } from "../atomic-json-file";
import { isMissingFileError } from "../file-errors";
import { DispatchFailed, dispatchCommand } from "./dispatch-process";
import type { DispatchCaller, DispatchWork } from "./dispatch-tools";

const identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const terminalStatus = Schema.Literals([
  "done",
  "partial",
  "failed",
  "budget_exceeded",
  "stopped",
  "unroutable",
  "dry-run",
]);
const verifySchema = Schema.Struct({
  rc: Schema.optional(Schema.Number),
  cmd: Schema.optional(Schema.String),
  tail: Schema.optional(Schema.String),
  seconds: Schema.optional(Schema.Number),
  failing: Schema.optional(Schema.Array(Schema.String)),
});
const resultSchema = Schema.Struct({
  status: terminalStatus,
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  commit: Schema.optional(Schema.NullOr(Schema.String)),
  result: Schema.optional(Schema.NullOr(Schema.Struct({ summary: Schema.optional(Schema.String) }))),
  verify: Schema.optional(Schema.NullOr(verifySchema)),
});
const recordSchema = Schema.Struct({
  runId: identifier,
  host: identifier,
  agentId: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  binary: Schema.String,
  idempotencyKey: Schema.String,
  status: Schema.Union([terminalStatus, Schema.Literals(["running", "cancelling"])]),
  branch: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  summary: Schema.optional(Schema.String),
  verify: Schema.optional(Schema.NullOr(verifySchema)),
  delivered: Schema.Boolean,
});
export type DispatchRecord = typeof recordSchema.Type;
const stateSchema = Schema.Struct({ version: Schema.Literal(1), runs: Schema.Array(recordSchema) });
const infoSchema = Schema.Struct({
  id: identifier,
  state: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.NullOr(Schema.String)),
  result: Schema.NullOr(resultSchema),
});
const acknowledgement = Schema.Struct({ id: identifier });
const fleetSchema = Schema.Struct({
  hosts: Schema.Array(
    Schema.Struct({
      name: identifier,
      repos: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
});

const io = <A>(body: () => Promise<A>) =>
  Effect.tryPromise({ try: body, catch: (cause) => new DispatchFailed({ cause }) });
const step = <A>(body: () => A) => Effect.try({ try: body, catch: (cause) => new DispatchFailed({ cause }) });
const commandJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, output: string): S["Type"] => {
  for (const line of output.split(/\r?\n/u).reverse()) {
    try {
      return Schema.decodeUnknownSync(schema)(JSON.parse(line));
    } catch {
      // Login shell profiles can print text before openswarm's final JSON line.
    }
  }
  throw new Error("openswarm returned invalid JSON");
};
const isTerminal = (record: DispatchRecord) => record.status !== "running" && record.status !== "cancelling";
const expandHome = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

/** Redacts executor-controlled text again before it reaches the local dispatch record. */
export function redactDispatchRecord(record: DispatchRecord, redact: (text: string) => string): DispatchRecord {
  const safeText = (text: string) => redact(redactText(text));
  return {
    ...record,
    title: safeText(record.title),
    branch: record.branch === null ? null : safeText(record.branch),
    commit: record.commit === null ? null : safeText(record.commit),
    ...(record.summary === undefined ? {} : { summary: safeText(record.summary) }),
    ...(record.verify === undefined
      ? {}
      : {
          verify:
            record.verify === null
              ? null
              : {
                  ...record.verify,
                  ...(record.verify.cmd === undefined ? {} : { cmd: safeText(record.verify.cmd) }),
                  ...(record.verify.tail === undefined ? {} : { tail: safeText(record.verify.tail) }),
                  ...(record.verify.failing === undefined ? {} : { failing: record.verify.failing.map(safeText) }),
                },
        }),
  };
}

export interface DispatchServiceOptions {
  dataPath: string;
  settings(): OpenswarmSettings;
  redact(text: string): string;
  /** Persists the status message and mailbox delivery before it returns. */
  publish(record: DispatchRecord, terminal: boolean): Effect.Effect<void, DispatchFailed>;
  failed(agentId: string): void;
}

/** Owns durable run records and the watcher scope. Shutdown leaves executor work intact. */
export class DispatchService {
  readonly #options: DispatchServiceOptions;
  readonly #writes = Semaphore.makeUnsafe(1);
  readonly #watching = new Set<string>();
  #runs: DispatchRecord[] = [];
  #scope = Scope.makeUnsafe();
  #started = false;

  constructor(options: DispatchServiceOptions) {
    this.#options = options;
  }

  readonly start = Effect.fn("DispatchService.start")(function* (this: DispatchService) {
    if (this.#started) return;
    const contents = yield* io(() => readFile(join(this.#options.dataPath, "openbot-dispatch-v1.json"), "utf8")).pipe(
      Effect.catch((failure) => (isMissingFileError(failure.cause) ? Effect.succeed(null) : Effect.fail(failure))),
    );
    if (contents !== null) {
      const runs = [...(yield* step(() => Schema.decodeUnknownSync(stateSchema)(JSON.parse(contents)))).runs];
      const safeRuns = runs.map((record) => redactDispatchRecord(record, this.#options.redact));
      if (JSON.stringify(runs) !== JSON.stringify(safeRuns)) yield* this.#save(safeRuns);
      else this.#runs = safeRuns;
    }
    this.#started = true;
    for (const record of this.#runs) if (!record.delivered) yield* this.#watch(record.runId);
  });

  readonly dispose = Effect.fn("DispatchService.dispose")(function* (this: DispatchService) {
    this.#started = false;
    yield* Scope.close(this.#scope, Exit.void);
    this.#scope = Scope.makeUnsafe();
    this.#watching.clear();
  }).bind(this);

  readonly dispatch = Effect.fn("DispatchService.dispatch")(function* (
    this: DispatchService,
    input: DispatchWork,
    caller: DispatchCaller,
  ) {
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        if (!this.#started || caller.inExecutionThread)
          return yield* new DispatchFailed({ cause: new Error(sourceText("error.backend.dispatchOwnChat")) });
        const existing = this.#runs.find(
          (run) =>
            run.idempotencyKey === caller.idempotencyKey &&
            run.agentId === caller.agentId &&
            run.threadId === caller.threadId,
        );
        if (existing) return { runId: existing.runId, host: existing.host };
        const settings = this.#options.settings();
        const binary = expandHome(settings.binaryPath || "openswarm");
        const host = input.host ?? (settings.defaultHost || "local");
        const lane = input.lane ?? (input.backend || input.model ? "" : settings.defaultLane);
        const card = this.#options.redact(input.card);
        const title = this.#options.redact(input.title);
        const cardPath = join(this.#options.dataPath, "dispatch-cards", `${randomUUID()}.md`);
        let cwd = caller.workspacePath;
        if (host !== "local" && !lane) cwd = yield* this.#remoteRepository(host, cwd);
        const args = lane ? ["lane", "assign", lane] : ["run", "--detach", "--cwd", cwd];
        // Remote hosts cannot read this computer's card file. The CLI accepts the same card as --prompt.
        args.push(
          ...(host === "local" ? ["--task-file", cardPath] : ["--prompt", card]),
          "--title",
          title,
          "--budget-minutes",
          String(input.budgetMinutes ?? 40),
        );
        if (input.verify) args.push("--verify", this.#options.redact(input.verify));
        if (input.backend) args.push("--backend", input.backend);
        if (input.model) args.push("--model", input.model);
        const output =
          host === "local"
            ? yield* Effect.acquireUseRelease(
                writeFileAtomically(cardPath, card, { createDirectory: true }).pipe(
                  Effect.mapError((failure) => new DispatchFailed({ cause: failure.cause })),
                ),
                () => this.#command(binary, host, args),
                () => io(() => rm(cardPath, { force: true })).pipe(Effect.catch(() => Effect.void)),
              )
            : yield* this.#command(binary, host, args);
        const { id: runId } = yield* step(() => commandJson(acknowledgement, output));
        const record: DispatchRecord = {
          runId,
          host,
          agentId: caller.agentId,
          threadId: caller.threadId,
          title,
          binary,
          idempotencyKey: caller.idempotencyKey,
          status: "running",
          branch: null,
          commit: null,
          startedAt: new Date().toISOString(),
          delivered: false,
        };
        const saved = yield* Effect.result(this.#save([...this.#runs, record]));
        if (saved._tag === "Failure") {
          // Do not leave an accepted executor without a durable owner.
          yield* this.#command(binary, host, ["stop", runId]).pipe(Effect.catch(() => Effect.void));
          return yield* saved.failure;
        }
        yield* this.#options
          .publish(record, false)
          .pipe(Effect.catch(() => Effect.sync(() => this.#options.failed(record.agentId))));
        yield* this.#watch(runId);
        return { runId, host };
      }),
    );
  }, Effect.uninterruptible);

  readonly status = Effect.fn("DispatchService.status")(function* (
    this: DispatchService,
    runId: string,
    caller: DispatchCaller,
  ) {
    const record = yield* this.#owned(runId, caller);
    return {
      runId: record.runId,
      host: record.host,
      status: record.status,
      branch: record.branch,
      commit: record.commit,
      summary: record.summary,
      verify: record.verify,
      startedAt: record.startedAt,
    };
  });

  readonly abort = Effect.fn("DispatchService.abort")(function* (
    this: DispatchService,
    runId: string,
    caller: DispatchCaller,
  ) {
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const record = yield* this.#owned(runId, caller);
        if (isTerminal(record)) return { runId, host: record.host, status: record.status };
        yield* this.#command(record.binary, record.host, ["stop", runId]);
        yield* this.#save(this.#runs.map((run) => (run === record ? { ...run, status: "cancelling" } : run)));
        return { runId, host: record.host, status: "cancelling" };
      }),
    );
  }, Effect.uninterruptible);

  #owned(runId: string, caller: DispatchCaller) {
    return step(() => {
      const record = this.#runs.find(
        (run) => run.runId === runId && run.agentId === caller.agentId && run.threadId === caller.threadId,
      );
      if (!record || caller.inExecutionThread) throw new Error(sourceText("error.backend.dispatchUnknown"));
      return record;
    });
  }

  #command(binary: string, host: string, args: string[]) {
    return dispatchCommand(binary, host === "local" ? args : ["fleet", "exec", host, "--", ...args]);
  }

  #save(runs: DispatchRecord[]) {
    const safeRuns = runs.map((record) => redactDispatchRecord(record, this.#options.redact));
    return writeJsonFileAtomically(
      join(this.#options.dataPath, "openbot-dispatch-v1.json"),
      { version: 1, runs: safeRuns },
      { createDirectory: true },
    ).pipe(
      Effect.mapError((failure) => new DispatchFailed({ cause: failure.cause })),
      Effect.tap(() =>
        Effect.sync(() => {
          this.#runs = safeRuns;
        }),
      ),
    );
  }

  readonly #remoteRepository = Effect.fn("DispatchService.remoteRepository")(function* (
    this: DispatchService,
    host: string,
    cwd: string,
  ) {
    const root = process.env.OPENSWARM_HOME || join(homedir(), ".claude", "openswarm");
    const contents = yield* io(() => readFile(join(root, "fleet.json"), "utf8"));
    const fleet = yield* step(() => Schema.decodeUnknownSync(fleetSchema)(JSON.parse(contents)));
    const local = fleet.hosts.find((entry) => entry.name === "local");
    const key = Object.entries(local?.repos ?? {}).find(([, path]) => resolve(expandHome(path)) === resolve(cwd))?.[0];
    const remote = key ? fleet.hosts.find((entry) => entry.name === host)?.repos?.[key] : undefined;
    if (!remote) return yield* new DispatchFailed({ cause: new Error(sourceText("error.backend.dispatchRepository")) });
    return remote;
  });

  readonly #watch = Effect.fn("DispatchService.watch")(function* (this: DispatchService, runId: string) {
    if (this.#watching.has(runId)) return;
    this.#watching.add(runId);
    yield* this.#poll(runId).pipe(
      Effect.ensuring(Effect.sync(() => this.#watching.delete(runId))),
      Effect.forkIn(this.#scope, { startImmediately: false }),
    );
  });

  readonly #poll = Effect.fn("DispatchService.poll")(function* (this: DispatchService, runId: string) {
    while (this.#started) {
      const result = yield* Effect.result(this.#refresh(runId));
      if (result._tag === "Success" && result.success) return;
      // A transport failure is unknown, never a successful result. The next poll can reconnect.
      yield* Effect.sleep("2 seconds");
    }
  });

  readonly #refresh = Effect.fn("DispatchService.refresh")(function* (this: DispatchService, runId: string) {
    const current = this.#runs.find((run) => run.runId === runId);
    if (!current || current.delivered) return true;
    let finished = current;
    if (!isTerminal(current)) {
      // _run-info is openswarm's fleet result endpoint; runs --json omits summary and verify.
      const output = yield* this.#command(current.binary, current.host, ["fleet", "_run-info", runId]);
      const info = yield* step(() => commandJson(infoSchema, output));
      if (info.id !== runId) return false;
      if (info.result) {
        const safe = yield* step(() =>
          Schema.decodeUnknownSync(resultSchema)(JSON.parse(this.#options.redact(JSON.stringify(info.result)))),
        );
        finished = {
          ...current,
          status: safe.status,
          branch: safe.branch ?? null,
          commit: safe.commit ?? null,
          summary: safe.result?.summary?.slice(0, 16_000) ?? "",
          verify: safe.verify ?? null,
        };
      } else if (info.state === "dead") {
        finished = {
          ...current,
          status: "failed",
          branch: null,
          commit: info.commit ?? null,
          summary: sourceText("status.agent.dispatchNoResult"),
          verify: null,
        };
      } else {
        return false;
      }
    }
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.#runs.find((run) => run.runId === runId)?.delivered) return true;
        const safeFinished = redactDispatchRecord(finished, this.#options.redact);
        yield* this.#save(this.#runs.map((run) => (run.runId === runId ? safeFinished : run)));
        yield* this.#options.publish(safeFinished, true);
        yield* this.#save(this.#runs.map((run) => (run.runId === runId ? { ...safeFinished, delivered: true } : run)));
        return true;
      }),
    );
  });
}
