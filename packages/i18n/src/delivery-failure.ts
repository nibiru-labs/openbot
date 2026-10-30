import type { QueueDelivery } from "@openbot/contracts/ipc";
import { isFixedSourceText, matchingSourceKeys, sourceText } from "./source-text";

/** What a terminal delivery keeps after {@link encodeDeliveryFailure}. */
export interface StoredDeliveryFailure {
  error: string;
  errorDetail: string | null;
  reference: string | null;
}

const FALLBACK_KEY = "error.backend.deliveryFailed";

const CATALOG_PREFIXES = ["error.backend.", "error.provider.", "status."] as const;

function isCatalogSourceKey(key: string): boolean {
  return CATALOG_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Writes a catalog sentence for the failure kind in `error`, keeps redacted provider text in
 * `errorDetail`, and stores an optional copyable code in `reference`.
 */
export function encodeDeliveryFailure(
  message: string | null,
  reference: string | null = null,
  explicitDetail: string | null = null,
): StoredDeliveryFailure | null {
  if (message === null) return null;
  if (isFixedSourceText(message)) {
    return { error: message, errorDetail: explicitDetail, reference };
  }
  const keys = matchingSourceKeys(message);
  if (keys.some(isCatalogSourceKey)) {
    return { error: message, errorDetail: explicitDetail, reference };
  }
  return {
    error: sourceText(FALLBACK_KEY),
    errorDetail: explicitDetail ?? message,
    reference,
  };
}

/**
 * The sentence a client shows for a failed delivery. New rows localize the catalog text in
 * `error`. Old rows still hold raw provider text there and have no `errorDetail`.
 */
export function deliveryFailureMessage(
  delivery: Pick<QueueDelivery, "error" | "errorDetail" | "reference">,
  localizeSource: (text: string) => string,
): string | null {
  if (!delivery.error) return null;
  if (delivery.errorDetail !== undefined) return localizeSource(delivery.error);
  const localized = localizeSource(delivery.error);
  return localized !== delivery.error || isFixedSourceText(delivery.error) ? localized : delivery.error;
}
