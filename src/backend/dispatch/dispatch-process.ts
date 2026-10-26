import { spawn } from "node:child_process";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Schema } from "effect";
import { shellQuote } from "../automation-command";
import { endProcessTree } from "../windows-process-tree";

export class DispatchFailed extends Schema.TaggedError<DispatchFailed>()("DispatchFailed", {
  cause: Schema.Defect(),
}) {}

/** Owns one bounded CLI request. The detached executor belongs to openswarm. */
export const dispatchCommand = Effect.fn("DispatchProcess.command")(function* (binary: string, args: string[]) {
  const shell = process.platform === "darwin" ? "/bin/zsh" : process.env.SHELL || "/bin/sh";
  // Every value is an argument, including cards, paths, and verify commands.
  const script = `exec ${[binary, ...args].map(shellQuote).join(" ")}`;
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        spawn(shell, [shell.endsWith("/sh") ? "-lc" : "-lic", script], {
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }),
      catch: (cause) => new DispatchFailed({ cause }),
    }),
    (child) =>
      Effect.callback<string, DispatchFailed>((resume) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let complete = false;
        const finish = (value: Effect.Effect<string, DispatchFailed>) => {
          if (complete) return;
          complete = true;
          resume(value);
        };
        const fail = () =>
          finish(Effect.fail(new DispatchFailed({ cause: new Error(sourceText("error.backend.dispatchCommand")) })));
        child.stdout?.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) fail();
          else chunks.push(chunk);
        });
        // CLI errors can contain card content or credentials. Never retain them.
        child.stderr?.resume();
        child.once("error", fail);
        child.once("close", (code) => {
          if (code !== 0) fail();
          else finish(Effect.succeed(Buffer.concat(chunks).toString("utf8")));
        });
      }).pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () =>
            Effect.fail(new DispatchFailed({ cause: new Error(sourceText("error.backend.dispatchCommand")) })),
        }),
      ),
    (child) => endProcessTree(child).pipe(Effect.orDie),
  );
});
