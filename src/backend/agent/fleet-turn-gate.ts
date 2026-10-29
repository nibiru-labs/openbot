import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  earlyCompletion: string | null;
}

/**
 * A local boundary for an external coordinator. The journal precedes every
 * request because an interrupted SSH response does not prove it was rejected.
 * A stale journal requires an operator to inspect the executor before recovery.
 */
export class FleetTurnGate {
  readonly #slots = new Map<string, Slot>();
  #recoveryRequired: boolean;

  constructor(
    readonly directory: string,
    readonly transport: FleetTurnTransport,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.#recoveryRequired = readdirSync(directory).some((name) => name.endsWith(".json"));
  }

  get recoveryRequired(): boolean {
    return this.#recoveryRequired;
  }

  async begin(
    threadId: string,
    backend: FleetTurnReservation["backend"],
    provider: FleetTurnReservation["provider"],
  ): Promise<boolean> {
    if (this.#recoveryRequired) throw new Error("Fleet admission requires recovery.");
    if (!threadId || this.#slots.has(threadId)) throw new Error("Thread already has a fleet admission.");
    const id = randomUUID().replaceAll("-", "");
    const reservation: FleetTurnReservation = {
      run_id: `hub-${id}`,
      token: randomUUID().replaceAll("-", ""),
      backend,
      provider,
    };
    const path = join(this.directory, `${id}.json`);
    const slot: Slot = { threadId, reservation, path, state: "acquiring", turnId: null, earlyCompletion: null };
    this.#slots.set(threadId, slot);
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ threadId, ...reservation }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const parent = openSync(this.directory, "r");
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } catch (error) {
      this.#slots.delete(threadId);
      // The journal might have been created before the failure. Do not send
      // an acquire request and require inspection before another attempt.
      this.#recoveryRequired = true;
      throw error;
    }
    try {
      const result = await this.transport.acquire(reservation);
      if (result.admitted === false) {
        unlinkSync(path);
        this.#slots.delete(threadId);
        return false;
      }
      if (result.admitted !== true) throw new Error("Invalid fleet admission response.");
      slot.state = "admitted";
      return true;
    } catch (error) {
      slot.state = "uncertain";
      this.#recoveryRequired = true;
      throw error;
    }
  }

  /** Call immediately before the provider receives the start request. */
  sent(threadId: string): void {
    const slot = this.#require(threadId);
    if (slot.state !== "admitted") throw new Error("Fleet admission is not ready.");
    slot.state = "sent";
  }

  async started(threadId: string, turnId: string): Promise<void> {
    const slot = this.#require(threadId);
    if (slot.state !== "sent" || !turnId || (slot.turnId && slot.turnId !== turnId)) {
      throw new Error("Fleet turn identity does not match.");
    }
    slot.turnId = turnId;
    if (slot.earlyCompletion === turnId) await this.#release(slot);
  }

  async completed(threadId: string, turnId: string): Promise<void> {
    const slot = this.#slots.get(threadId);
    if (slot?.state !== "sent" || !turnId) return;
    if (!slot.turnId) {
      slot.earlyCompletion = turnId;
      return;
    }
    if (slot.turnId === turnId) await this.#release(slot);
  }

  /** This is safe only while the start request has not been sent. */
  async cancelBeforeSend(threadId: string): Promise<void> {
    const slot = this.#require(threadId);
    if (slot.state !== "admitted") throw new Error("Provider start may already have run.");
    await this.#release(slot);
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

  async #release(slot: Slot): Promise<void> {
    slot.state = "releasing";
    try {
      await this.transport.release(slot.reservation);
      unlinkSync(slot.path);
      this.#slots.delete(slot.threadId);
    } catch (error) {
      slot.state = "uncertain";
      this.#recoveryRequired = true;
      throw error;
    }
  }
}
