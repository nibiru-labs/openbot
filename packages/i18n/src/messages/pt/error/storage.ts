import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  "error.storage.unsupported": "Este servidor não oferece suporte a armazenamento.",
  "error.storage.agentMissing": "O agente não existe.",
  "error.storage.unreadableFile": "O OpenBot não consegue ler {path}. O arquivo está danificado.",
  "error.storage.openFailed": "O OpenBot não conseguiu abrir a pasta do espaço de trabalho.",
} as const satisfies PartialTranslation<typeof source>;
