import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  "error.storage.unsupported": "Este servidor no admite almacenamiento.",
  "error.storage.agentMissing": "El agente no existe.",
  "error.storage.unreadableFile": "OpenBot no puede leer {path}. El archivo está dañado.",
  "error.storage.openFailed": "OpenBot no pudo abrir la carpeta del espacio de trabajo.",
} as const satisfies PartialTranslation<typeof source>;
