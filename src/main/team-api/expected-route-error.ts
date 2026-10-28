import { matchingSourceKeys } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";
import { HttpError } from "./http-error";

function hasCause(value: object): value is { readonly cause: unknown } {
  return "cause" in value;
}

/** Catalog text on the error or on a wrapped `cause`, when `runCauseEffect` did not unwrap it. */
function catalogMessage(error: unknown): string | null {
  if (error instanceof Error && matchingSourceKeys(error.message).length > 0) return error.message;
  if (error !== null && typeof error === "object" && hasCause(error)) {
    const { cause } = error;
    if (cause instanceof Error && matchingSourceKeys(cause.message).length > 0) return cause.message;
  }
  return null;
}

/**
 * Turns a refusal from a route service into `HttpError` when its message is catalog text. Raw
 * internal failures rethrow so the dispatcher answers 500 with a generic message.
 */
export function throwExpectedRouteError(error: unknown, status: number): never {
  if (error instanceof HttpError) throw error;
  const message = catalogMessage(error);
  if (message !== null) throw new HttpError(status, redactText(message));
  throw error;
}
