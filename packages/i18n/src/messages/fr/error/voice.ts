import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/voice";

export const messages = {
  "error.voice.downloadFailed": "Impossible de télécharger le modèle vocal. Réessayez.",
  "error.voice.downloadStopped": "Le téléchargement du modèle vocal a été arrêté.",
  "error.voice.runtimeUnavailable": "La transcription vocale locale n’est pas disponible sur cette plateforme.",
  "error.voice.busy": "Une transcription vocale est déjà en cours.",
  "error.voice.modelUnavailable": "Le modèle vocal est indisponible.",
  "error.voice.transcriptionTimedOut": "La transcription vocale a expiré.",
  "error.voice.prepareRequired":
    "La transcription vocale locale est indisponible. Exécutez `bun run voice:prepare` et redémarrez OpenBot.",
  "error.voice.transcriptionFailed": "OpenBot n’a pas pu transcrire cet enregistrement.",
  "error.voice.cloud.keyRequired": "Ajoutez votre clé API ElevenLabs dans Réglages → Voix.",
  "error.voice.cloud.keyRejected": "ElevenLabs n’a pas accepté la clé API. Vérifiez la clé dans Réglages → Voix.",
  "error.voice.cloud.quotaExceeded": "Votre quota ElevenLabs est épuisé.",
  "error.voice.cloud.rateLimited": "ElevenLabs est occupé. Réessayez dans un instant.",
  "error.voice.cloud.termsRequired":
    "Acceptez les conditions d’ElevenLabs dans votre compte ElevenLabs, puis réessayez.",
  "error.voice.cloud.streamEnded": "Le flux de dictée s’est arrêté. Enregistrez à nouveau.",
  "error.voice.cloud.tooLong": "L’enregistrement est trop long.",
  "error.voice.cloud.keySaveFailed": "Impossible d’enregistrer la clé API ElevenLabs.",
  "error.voice.transcriptTooLong": "La transcription vocale est trop longue.",
} as const satisfies PartialTranslation<typeof source>;
