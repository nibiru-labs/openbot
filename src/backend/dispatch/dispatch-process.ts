import { spawn } from "node:child_process";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Schema } from "effect";
import { assertAgentArgs, assertWindowsScriptArgs } from "../acp-agent-command";
import { cliSpawnTarget } from "../cli";
import { endProcessTree } from "../windows-process-tree";

export class DispatchFailed extends Schema.TaggedError<DispatchFailed>()("DispatchFailed", {
  cause: Schema.Defect(),
  reason: Schema.optional(Schema.String),
  step: Schema.optional(Schema.Literals(["spawn", "exit code", "parse", "save"])),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  timedOut: Schema.optional(Schema.Boolean),
}) {}

const logger = createOpenBotLogger("dispatch");

export const dispatchFailure = (options: {
  cause: unknown;
  reason: string;
  step: "spawn" | "exit code" | "parse" | "save";
  exitCode?: number | null;
  timedOut?: boolean;
}) => {
  const exitCode = options.exitCode ?? null;
  const timedOut = options.timedOut ?? false;
  logger.warn("The openswarm request failed.", { step: options.step, exitCode, timedOut });
  return new DispatchFailed({
    cause: options.cause,
    reason: options.reason,
    step: options.step,
    exitCode,
    timedOut,
  });
};

export interface DispatchCommandOutput {
  output: string;
  exitCode: number;
}

/** Owns one bounded CLI request. The detached executor belongs to openswarm. */
export const dispatchCommand = Effect.fn("DispatchProcess.command")(function* (binary: string, args: string[]) {
  yield* Effect.try({
    try: () => {
      assertAgentArgs(args);
      assertWindowsScriptArgs(binary, args);
    },
    catch: (cause) =>
      dispatchFailure({
        cause,
        reason: cause instanceof Error ? cause.message : sourceText("error.backend.dispatchSpawnFailed"),
        step: "spawn",
      }),
  });
  const target = cliSpawnTarget(binary, args);
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        spawn(target.command, target.args, {
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          windowsVerbatimArguments: target.windowsVerbatimArguments,
          windowsHide: true,
        }),
      catch: (cause) =>
        dispatchFailure({
          cause,
          reason: sourceText("error.backend.dispatchSpawnFailed"),
          step: "spawn",
        }),
    }),
    (child) =>
      Effect.callback<DispatchCommandOutput, DispatchFailed>((resume) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let complete = false;
        const finish = (value: Effect.Effect<DispatchCommandOutput, DispatchFailed>) => {
          if (complete) return;
          complete = true;
          resume(value);
        };
        child.stdout?.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            finish(
              Effect.fail(
                dispatchFailure({
                  cause: new Error("openswarm output exceeded the size limit"),
                  reason: sourceText("error.backend.dispatchOutputUnreadable"),
                  step: "parse",
                }),
              ),
            );
          } else chunks.push(chunk);
        });
        // CLI errors can contain card content or credentials. Never retain them.
        child.stderr?.resume();
        child.once("error", (cause) =>
          finish(
            Effect.fail(
              dispatchFailure({
                cause,
                reason: sourceText("error.backend.dispatchSpawnFailed"),
                step: "spawn",
              }),
            ),
          ),
        );
        child.once("close", (code) => {
          if (code !== 0) {
            finish(
              Effect.fail(
                dispatchFailure({
                  cause: new Error("openswarm exited unsuccessfully"),
                  reason:
                    code === null
                      ? sourceText("error.backend.dispatchExited")
                      : sourceText("error.backend.dispatchExitCode", { code }),
                  step: "exit code",
                  exitCode: code,
                }),
              ),
            );
          } else {
            finish(Effect.succeed({ output: Buffer.concat(chunks).toString("utf8"), exitCode: code }));
          }
        });
      }).pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () =>
            Effect.fail(
              dispatchFailure({
                cause: new Error("openswarm command timed out"),
                reason: sourceText("error.backend.dispatchTimeout"),
                step: "exit code",
                timedOut: true,
              }),
            ),
        }),
      ),
    (child) => endProcessTree(child).pipe(Effect.orDie),
  );
});
