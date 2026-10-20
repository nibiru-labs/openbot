import { createHash } from "node:crypto";
import type { CustomProviderSource } from "./opencode-config";

/** A Pi models.json reference names this variable; the key itself stays in the spawned process. */
export function piProviderKeyVariable(providerId: string): string {
  return `OPENBOT_PI_API_KEY_${createHash("sha256").update(providerId).digest("hex").slice(0, 16).toUpperCase()}`;
}

/** Read saved custom endpoint keys at spawn, so Pi never needs a plaintext auth.json copy. */
export function piCustomProviderEnv(source: CustomProviderSource): Record<string, string> {
  return Object.fromEntries(
    source().flatMap((provider) => (provider.apiKey ? [[piProviderKeyVariable(provider.id), provider.apiKey]] : [])),
  );
}
