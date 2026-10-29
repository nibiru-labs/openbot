import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fleet turn configuration", () => {
  it("fails closed when the required configuration is missing", async () => {
    vi.stubEnv("OPENBOT_FLEET_CAPACITY_REQUIRED", "1");
    vi.stubEnv("OPENBOT_FLEET_CAPACITY_CONFIG", "");
    const { configuredFleetTurnGate } = await import("./fleet-turn-config");
    expect(() => configuredFleetTurnGate()).toThrow("configuration is required");
  });

  it("rejects relative coordinator commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-config-test-"));
    directories.push(dir);
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ journalDirectory: join(dir, "journal"), command: ["ssh"] }));
    vi.stubEnv("OPENBOT_FLEET_CAPACITY_CONFIG", file);
    const { configuredFleetTurnGate } = await import("./fleet-turn-config");
    expect(() => configuredFleetTurnGate()).toThrow();
  });
});
