import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/voice";

export const messages = {
  "error.voice.downloadFailed": "Das Sprachmodell konnte nicht heruntergeladen werden. Versuche es erneut.",
  "error.voice.downloadStopped": "Der Download des Sprachmodells wurde gestoppt.",
  "error.voice.runtimeUnavailable": "Lokale Sprachtranskription ist auf dieser Plattform nicht verfügbar.",
  "error.voice.busy": "Eine Sprachtranskription läuft bereits.",
  "error.voice.modelUnavailable": "Das Sprachmodell ist nicht verfügbar.",
  "error.voice.transcriptionTimedOut": "Die Zeit für die Sprachtranskription ist abgelaufen.",
  "error.voice.prepareRequired":
    "Lokale Sprachtranskription ist nicht verfügbar. Führe `bun run voice:prepare` aus und starte OpenBot neu.",
  "error.voice.transcriptionFailed": "OpenBot konnte diese Aufnahme nicht transkribieren.",
  "error.voice.cloud.keyRequired": "Füge deinen ElevenLabs-API-Schlüssel unter Einstellungen → Diktat hinzu.",
  "error.voice.cloud.keyRejected":
    "ElevenLabs hat den API-Schlüssel nicht akzeptiert. Prüfe den Schlüssel unter Einstellungen → Diktat.",
  "error.voice.cloud.quotaExceeded": "Dein ElevenLabs-Kontingent ist aufgebraucht.",
  "error.voice.cloud.rateLimited": "ElevenLabs ist ausgelastet. Versuche es gleich noch einmal.",
  "error.voice.cloud.termsRequired":
    "Akzeptiere die Bedingungen von ElevenLabs in deinem ElevenLabs-Konto und versuche es dann erneut.",
  "error.voice.cloud.streamEnded": "Die Diktat-Übertragung wurde beendet. Nimm erneut auf.",
  "error.voice.cloud.tooLong": "Die Aufnahme ist zu lang.",
  "error.voice.cloud.keySaveFailed": "Der ElevenLabs-API-Schlüssel konnte nicht gespeichert werden.",
  "error.voice.transcriptTooLong": "Das Sprachprotokoll ist zu lang.",
} as const satisfies PartialTranslation<typeof source>;
