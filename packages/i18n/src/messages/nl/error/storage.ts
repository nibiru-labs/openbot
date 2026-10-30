import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  "error.storage.unsupported": "Deze server ondersteunt geen opslag.",
  "error.storage.agentMissing": "De agent bestaat niet.",
  "error.storage.unreadableFile": "OpenBot kan {path} niet lezen. Het bestand is beschadigd.",
  "error.storage.openFailed": "OpenBot kon de map van de werkruimte niet openen.",
} as const satisfies PartialTranslation<typeof source>;
