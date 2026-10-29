import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetTurnGate, type FleetTurnTransport } from "./fleet-turn-gate";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-turn-test-"));
  directories.push(dir);
  const transport: FleetTurnTransport = {
    acquire: vi.fn(async () => ({ admitted: true })),
    release: vi.fn(async () => {}),
  };
  return { dir, transport, gate: new FleetTurnGate(dir, transport) };
}

describe("FleetTurnGate", () => {
  it("keeps the reservation until the matching turn ends", async () => {
    const { gate, transport, dir } = fixture();
    expect(await gate.begin("thread", "codex", null)).toBe(true);
    const [journal] = readdirSync(dir);
    if (!journal) throw new Error("Missing fleet admission journal.");
    expect(statSync(join(dir, journal)).mode & 0o777).toBe(0o600);
    gate.sent("thread");
    await gate.started("thread", "turn-1");
    await gate.completed("thread", "old-turn");
    expect(transport.release).not.toHaveBeenCalled();
    await gate.completed("thread", "turn-1");
    expect(transport.release).toHaveBeenCalledTimes(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("handles completion before the start response is observed", async () => {
    const { gate, transport } = fixture();
    await gate.begin("thread", "codex", null);
    gate.sent("thread");
    await gate.completed("thread", "turn-1");
    expect(transport.release).not.toHaveBeenCalled();
    await gate.started("thread", "turn-1");
    expect(transport.release).toHaveBeenCalledTimes(1);
  });

  it("retains an uncertain acquisition across restart", async () => {
    const { gate, transport, dir } = fixture();
    vi.mocked(transport.acquire).mockRejectedValueOnce(new Error("connection lost"));
    await expect(gate.begin("thread", "codex", null)).rejects.toThrow("connection lost");
    expect(gate.recoveryRequired).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
    const restarted = new FleetTurnGate(dir, transport);
    await expect(restarted.begin("other", "codex", null)).rejects.toThrow("requires recovery");
    expect(transport.release).not.toHaveBeenCalled();
  });

  it("retains the journal for a malformed coordinator response", async () => {
    const { gate, transport, dir } = fixture();
    const malformed = Object.defineProperty({ admitted: true }, "admitted", { get: () => undefined });
    vi.mocked(transport.acquire).mockResolvedValueOnce(malformed);
    await expect(gate.begin("thread", "codex", null)).rejects.toThrow("Invalid fleet admission response");
    expect(gate.recoveryRequired).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("retains a sent start when the provider outcome is uncertain", async () => {
    const { gate, transport, dir } = fixture();
    await gate.begin("thread", "codex", null);
    gate.sent("thread");
    gate.uncertain("thread");
    await expect(gate.cancelBeforeSend("thread")).rejects.toThrow("may already have run");
    expect(transport.release).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("clears a denied reservation and permits another attempt", async () => {
    const { gate, transport, dir } = fixture();
    vi.mocked(transport.acquire).mockResolvedValueOnce({ admitted: false });
    expect(await gate.begin("thread", "codex", null)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(await gate.begin("thread", "codex", null)).toBe(true);
    await gate.cancelBeforeSend("thread");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("retains the journal when release acknowledgement is lost", async () => {
    const { gate, transport, dir } = fixture();
    await gate.begin("thread", "codex", null);
    gate.sent("thread");
    await gate.started("thread", "turn-1");
    vi.mocked(transport.release).mockRejectedValueOnce(new Error("connection lost"));
    await expect(gate.completed("thread", "turn-1")).rejects.toThrow("connection lost");
    expect(gate.recoveryRequired).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
