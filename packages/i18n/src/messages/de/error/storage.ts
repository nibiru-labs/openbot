import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  "error.storage.unsupported": "Dieser Server unterstützt keinen Speicher.",
  "error.storage.agentMissing": "Der Agent existiert nicht.",
  "error.storage.unreadableFile": "OpenBot kann {path} nicht lesen. Die Datei ist beschädigt.",
  "error.storage.openFailed": "OpenBot konnte den Ordner des Arbeitsbereichs nicht öffnen.",
} as const satisfies PartialTranslation<typeof source>;
