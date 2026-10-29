import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { causeHelpers } from "../effect-boundary";

export class FleetTurnGateFailed extends Schema.TaggedError<FleetTurnGateFailed>()("FleetTurnGateFailed", {
  cause: Schema.Defect(),
}) {}
const { io, sync } = causeHelpers(FleetTurnGateFailed);

/** The coordinator owns the limits. Tokens are private release capabilities. */
export interface FleetTurnTransport {
  acquire(input: FleetTurnReservation): Promise<{ admitted: boolean }>;
  release(input: FleetTurnReservation): Promise<void>;
}

export interface FleetTurnReservation {
  readonly run_id: string;
  readonly token: string;
  readonly backend: "codex" | "pi" | "cursor" | "agy" | "copilot";
  readonly provider: "minimax-cn" | null;
}

interface Slot {
  readonly threadId: string;
  readonly reservation: FleetTurnReservation;
  readonly path: string;
  state: "acquiring" | "admitted" | "sent" | "releasing" | "uncertain";
  turnId: string | null;
  earlyCompletions: Set<string>;
}

/**
 * A local boundary for an external coordinator. The journal precedes every
 * request because an interrupted SSH response does not prove it was rejected.
 * A stale journal requires an operator to inspect the executor before recovery.
 */
export class FleetTurnGate {
  readonly #slots = new Map<string, Slot>();
  #recoveryRequired = false;

  private constructor(
    readonly directory: string,
    readonly transport: FleetTurnTransport,
  ) {}

  static open(directory: string, transport: FleetTurnTransport) {
    return sync(() => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const gate = new FleetTurnGate(directory, transport);
      gate.#recoveryRequired = readdirSync(directory).some((name) => name.endsWith(".json"));
      return gate;
    });
  }

  get recoveryRequired(): boolean {
    return this.#recoveryRequired;
  }

  begin(threadId: string, backend: FleetTurnReservation["backend"], provider: FleetTurnReservation["provider"]) {
    return Effect.gen({ self: this }, function* () {
      if (this.#recoveryRequired)
        return yield* Effect.fail(new FleetTurnGateFailed({ cause: new Error("Fleet admission requires recovery.") }));
      if (!threadId || this.#slots.has(threadId))
        return yield* Effect.fail(
          new FleetTurnGateFailed({ cause: new Error("Thread already has a fleet admission.") }),
        );
      const id = randomUUID().replaceAll("-", "");
      const reservation: FleetTurnReservation = {
        run_id: `hub-${id}`,
        token: randomUUID().replaceAll("-", ""),
        backend,
        provider,
      };
      const path = join(this.directory, `${id}.json`);
      const slot: Slot = { threadId, reservation, path, state: "acquiring", turnId: null, earlyCompletions: new Set() };
      this.#slots.set(threadId, slot);
      yield* sync(() => {
        const fd = openSync(path, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ threadId, ...reservation }));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        // Node cannot open directories for fsync on Windows. The journal file is flushed above;
        // directory-entry durability across a sudden Windows power loss is not guaranteed.
        if (process.platform !== "win32") {
          const parent = openSync(this.directory, "r");
          try {
            fsyncSync(parent);
          } finally {
            closeSync(parent);
          }
        }
      }).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            this.#slots.delete(threadId);
            // The journal might have been created before the failure. Do not send
            // an acquire request and require inspection before another attempt.
            this.#recoveryRequired = true;
          }),
        ),
      );
      return yield* Effect.gen({ self: this }, function* () {
        const result = yield* io(() => this.transport.acquire(reservation));
        if (result.admitted === false) {
          yield* sync(() => unlinkSync(path));
          this.#slots.delete(threadId);
          return false;
        }
        if (result.admitted !== true)
          return yield* Effect.fail(new FleetTurnGateFailed({ cause: new Error("Invalid fleet admission response.") }));
        slot.state = "admitted";
        return true;
      }).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            slot.state = "uncertain";
            this.#recoveryRequired = true;
          }),
        ),
      );
    }).pipe(Effect.uninterruptible);
  }

  /** Call immediately before the provider receives the start request. */
  sent(threadId: string): void {
    const slot = this.#require(threadId);
    if (slot.state !== "admitted") throw new Error("Fleet admission is not ready.");
    slot.state = "sent";
  }

  started(threadId: string, turnId: string) {
    return Effect.gen({ self: this }, function* () {
      const slot = this.#require(threadId);
      if (slot.state !== "sent" || !turnId || (slot.turnId && slot.turnId !== turnId)) {
        throw new Error("Fleet turn identity does not match.");
      }
      slot.turnId = turnId;
      if (slot.earlyCompletions.has(turnId)) yield* this.#release(slot);
    });
  }

  completed(threadId: string, turnId: string) {
    return Effect.gen({ self: this }, function* () {
      const slot = this.#slots.get(threadId);
      if (slot?.state !== "sent" || !turnId) return;
      if (!slot.turnId) {
        slot.earlyCompletions.add(turnId);
        return;
      }
      if (slot.turnId === turnId) yield* this.#release(slot);
    });
  }

  /** This is safe only while the start request has not been sent. */
  cancelBeforeSend(threadId: string) {
    return Effect.gen({ self: this }, function* () {
      const slot = this.#require(threadId);
      if (slot.state !== "admitted") throw new Error("Provider start may already have run.");
      yield* this.#release(slot);
    });
  }

  /** A lost provider or uncertain start must retain the coordinator slot. */
  uncertain(threadId: string): void {
    const slot = this.#require(threadId);
    slot.state = "uncertain";
    this.#recoveryRequired = true;
  }

  #require(threadId: string): Slot {
    const slot = this.#slots.get(threadId);
    if (!slot) throw new Error("No fleet admission for this thread.");
    return slot;
  }

  #release(slot: Slot) {
    return Effect.gen({ self: this }, function* () {
      slot.state = "releasing";
      yield* Effect.gen({ self: this }, function* () {
        yield* io(() => this.transport.release(slot.reservation));
        yield* sync(() => unlinkSync(slot.path));
        this.#slots.delete(slot.threadId);
      }).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            slot.state = "uncertain";
            this.#recoveryRequired = true;
          }),
        ),
      );
    }).pipe(Effect.uninterruptible);
  }
}
