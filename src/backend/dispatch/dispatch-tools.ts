import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { z } from "zod";
import { openBotToolFailure, openBotToolResult } from "../agent/routine-tools";
import { toolStep } from "../agent/tool-operation";
import type { DispatchService } from "./dispatch-service";

const name = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const dispatchWorkSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    card: z.string().trim().min(1).max(64_000),
    lane: name.optional(),
    host: name.optional(),
    backend: z.enum(["codex", "ocgo", "deepseek", "cursor", "pi"]).optional(),
    model: z.string().trim().min(1).max(256).optional(),
    verify: z.string().trim().min(1).max(4096).optional(),
    budgetMinutes: z.number().int().min(1).max(240).optional(),
  })
  .strict();
const runSchema = z.object({ runId: name }).strict();
export type DispatchWork = z.infer<typeof dispatchWorkSchema>;
export interface DispatchCaller {
  agentId: string;
  threadId: string;
  inExecutionThread: boolean;
  workspacePath: string;
  idempotencyKey: string;
}

export const DISPATCH_TOOL_DEFINITIONS = [
  {
    name: "dispatch_work",
    description:
      "Delegate a coding task card to an openswarm lane or detached executor. Returns runId and host after acceptance; the result wakes this chat later. Review its branch, commit, and verify evidence before reporting success. Code and the card go to the executor host and its model provider.",
    shape: dispatchWorkSchema.shape,
  },
  {
    name: "dispatch_status",
    description: "Read the status and result of a coding run dispatched from this chat.",
    shape: runSchema.shape,
  },
  {
    name: "dispatch_abort",
    description:
      "Request cancellation of a coding run dispatched from this chat. The final result arrives later; partial work can remain on its branch.",
    shape: runSchema.shape,
  },
] as const;
const NAMES = new Set<string>(DISPATCH_TOOL_DEFINITIONS.map((tool) => tool.name));

export const handleDispatchTool = Effect.fn("DispatchTools.handle")(function* (
  tool: string,
  args: unknown,
  caller: DispatchCaller,
  service: DispatchService,
) {
  if (!NAMES.has(tool)) return null;
  if (caller.inExecutionThread) return openBotToolFailure(sourceText("error.backend.dispatchOwnChat"));
  const operation = Effect.gen(function* () {
    if (tool === "dispatch_work") {
      const input = yield* toolStep(() => dispatchWorkSchema.parse(args));
      if (input.lane && (input.backend || input.model))
        return openBotToolFailure(sourceText("error.backend.dispatchLaneOptions"));
      return openBotToolResult(yield* service.dispatch(input, caller));
    }
    const input = yield* toolStep(() => runSchema.parse(args));
    return openBotToolResult(
      yield* tool === "dispatch_abort" ? service.abort(input.runId, caller) : service.status(input.runId, caller),
    );
  });
  return yield* operation.pipe(
    Effect.catchTag("DispatchFailed", () =>
      Effect.succeed(openBotToolFailure(sourceText("error.backend.dispatchCommand"))),
    ),
  );
});
