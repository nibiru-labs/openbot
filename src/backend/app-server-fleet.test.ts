import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetTurnGate, type FleetTurnTransport } from "./agent/fleet-turn-gate";
import { CodexAppServerClient } from "./app-server-client";
import { decodeRecordResponse } from "./protocol";

const fixtures: { client: CodexAppServerClient; dir: string }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await Effect.runPromise(fixture.client.stop());
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

function fixture(serverBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "openbot-fleet-client-"));
  const executable = join(dir, "fake-codex");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  ${serverBody}
});
`,
  );
  chmodSync(executable, 0o700);
  const transport: FleetTurnTransport = {
    acquire: vi.fn(async () => ({ admitted: true })),
    release: vi.fn(async () => {}),
  };
  const journal = join(dir, "journal");
  const gate = new FleetTurnGate(journal, transport);
  const client = new CodexAppServerClient(executable, 5_000, undefined, gate);
  fixtures.push({ client, dir });
  client.start();
  return { client, transport, journal, gate };
}

describe("Codex fleet admission", () => {
  it("holds admission until the confirmed turn ends, even if the notification arrives first", async () => {
    const { client, transport, journal } = fixture(`
      const threadId = request.params.threadId;
      send({method:'turn/started', params:{threadId, turn:{id:'turn-1'}}});
      send({method:'turn/completed', params:{threadId, turn:{id:'turn-1'}}});
      send({id:request.id, result:{turn:{id:'turn-1'}}});
    `);
    await Effect.runPromise(client.request("turn/start", { threadId: "thread-1" }, decodeRecordResponse));
    await vi.waitFor(() => expect(transport.release).toHaveBeenCalledTimes(1));
    expect(readdirSync(journal)).toEqual([]);
  });

  it("waits for a busy fleet before sending a turn", async () => {
    const { client, transport } = fixture(`send({id:request.id, result:{turn:{id:'turn-1'}}});`);
    vi.mocked(transport.acquire).mockResolvedValueOnce({ admitted: false });
    await Effect.runPromise(client.request("turn/start", { threadId: "thread-1" }, decodeRecordResponse));
    expect(transport.acquire).toHaveBeenCalledTimes(2);
    expect(transport.release).not.toHaveBeenCalled();
  });

  it("retains a reservation when the provider does not confirm the turn ID", async () => {
    const { client, transport, gate, journal } = fixture(`send({id:request.id, result:{}});`);
    await expect(
      Effect.runPromise(client.request("turn/start", { threadId: "thread-1" }, decodeRecordResponse)),
    ).rejects.toThrow();
    expect(gate.recoveryRequired).toBe(true);
    expect(transport.release).not.toHaveBeenCalled();
    expect(readdirSync(journal)).toHaveLength(1);
  });

  it("does not release a newer turn for a delayed completion of the previous turn", async () => {
    const { client, transport } = fixture(`
      const threadId = request.params.threadId;
      const id = request.id === 1 ? 'old-turn' : 'new-turn';
      if (request.id !== 1) send({method:'turn/completed', params:{threadId, turn:{id:'old-turn'}}});
      send({id:request.id, result:{turn:{id}}});
      setTimeout(() => send({method:'turn/completed', params:{threadId, turn:{id}}}), request.id === 1 ? 5 : 150);
    `);
    await Effect.runPromise(client.request("turn/start", { threadId: "thread-1" }, decodeRecordResponse));
    await vi.waitFor(() => expect(transport.release).toHaveBeenCalledTimes(1));
    await Effect.runPromise(client.request("turn/start", { threadId: "thread-1" }, decodeRecordResponse));
    expect(transport.release).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(transport.release).toHaveBeenCalledTimes(2));
  });

  it("fails closed for compaction until its lifecycle is guarded", async () => {
    const { client, transport } = fixture(`send({id:request.id, result:{}});`);
    await expect(
      Effect.runPromise(client.request("thread/compact/start", { threadId: "thread-1" }, decodeRecordResponse)),
    ).rejects.toThrow();
    expect(transport.acquire).not.toHaveBeenCalled();
  });

  it("retains a reservation when the provider exits with a live turn", async () => {
    const { client, transport, gate, journal } = fixture(`send({id:request.id, result:{turn:{id:'turn-1'}}});`);
    await Effect.runPromise(client.request("turn/start", { threadId: "thread-1" }, decodeRecordResponse));
    await Effect.runPromise(client.stop());
    expect(gate.recoveryRequired).toBe(true);
    expect(transport.release).not.toHaveBeenCalled();
    expect(readdirSync(journal)).toHaveLength(1);
  });

  it("stops an unadmitted provider turn", async () => {
    const { client, transport } = fixture(`
      send({method:'turn/started', params:{threadId:'unexpected', turn:{id:'turn-1'}}});
    `);
    await expect(Effect.runPromise(client.request("config/read", {}, decodeRecordResponse))).rejects.toThrow();
    expect(client.running).toBe(false);
    expect(transport.acquire).not.toHaveBeenCalled();
  });
});
