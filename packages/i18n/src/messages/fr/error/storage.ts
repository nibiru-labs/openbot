import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  // Storage errors.
  "error.storage.unsupported": "Ce serveur ne prend pas en charge le stockage.",
  "error.storage.agentMissing": "L’agent n’existe pas.",
  "error.storage.unreadableFile": "OpenBot ne peut pas lire {path}. Le fichier est endommagé.",
  "error.storage.openFailed": "OpenBot n’a pas pu ouvrir le dossier de l’espace de travail.",
} as const satisfies PartialTranslation<typeof source>;
