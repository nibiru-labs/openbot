import { describe, expect, it } from "vitest";
import type { FleetTurnReservation } from "./fleet-turn-gate";
import { FleetTurnCommandTransport } from "./fleet-turn-transport";

const reservation: FleetTurnReservation = {
  run_id: "hub-test",
  token: "12345678901234567890123456789012",
  backend: "codex",
  provider: null,
};

function fake(script: string, timeoutMs = 2_000): FleetTurnCommandTransport {
  return new FleetTurnCommandTransport(process.execPath, ["-e", script], timeoutMs);
}

describe("FleetTurnCommandTransport", () => {
  it("sends an acquire and release as separate JSON requests", async () => {
    const transport = fake(`
      let input = '';
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        const request = JSON.parse(input);
        if (request.run_id !== 'hub-test' || request.token.length !== 32) process.exit(4);
        process.stdout.write(JSON.stringify(request.op === 'acquire'
          ? {ok:true, admitted:true} : {ok:true, released:true}));
      });
    `);
    expect(await transport.acquire(reservation)).toEqual({ admitted: true });
    await expect(transport.release(reservation)).resolves.toBeUndefined();
  });

  it("rejects malformed or rejected responses", async () => {
    await expect(fake("process.stdout.write('{}')").acquire(reservation)).rejects.toThrow("invalid response");
    await expect(fake("process.stdout.write('not-json')").acquire(reservation)).rejects.toThrow("invalid response");
    await expect(fake("process.stdout.write('{\"ok\":true}')").acquire(reservation)).rejects.toThrow(
      "admission response",
    );
  });

  it("rejects a lost acknowledgement and never prints coordinator output", async () => {
    const transport = fake("process.stdin.resume(); setTimeout(() => {}, 10000)", 50);
    await expect(transport.acquire(reservation)).rejects.toThrow("timed out");
  });

  it("rejects an oversized response", async () => {
    const transport = fake("process.stdout.write('x'.repeat(70000))");
    await expect(transport.acquire(reservation)).rejects.toThrow("too large");
  });
});
