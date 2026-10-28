import { ContextResetBusyError } from "@openbot/contracts/team-protocol/context-reset-v1";
import { matchingSourceKeys } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";
import { AgentSettingsRefused } from "../../backend/agent/agent-settings-refused";
import { InactiveAttentionRequest } from "../../backend/agent/inactive-attention-request";
import { HttpError } from "./http-error";

function hasCause(value: object): value is { readonly cause: unknown } {
  return "cause" in value;
}

function isExpectedConflict(error: unknown): boolean {
  if (
    error instanceof AgentSettingsRefused ||
    error instanceof ContextResetBusyError ||
    error instanceof InactiveAttentionRequest
  )
    return true;
  if (error !== null && typeof error === "object" && hasCause(error) && !(error instanceof Error)) {
    const { cause } = error;
    return (
      cause instanceof AgentSettingsRefused ||
      cause instanceof ContextResetBusyError ||
      cause instanceof InactiveAttentionRequest
    );
  }
  return false;
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
 * Catalog text for an expected 409 from automation when the refusal is user-facing. Raw internal
 * failures return null so the caller answers 500 without the message.
 */
export function expectedConflictMessage(error: unknown): string | null {
  if (!isExpectedConflict(error)) return null;
  return catalogMessage(error);
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
