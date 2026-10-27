import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/agent";

export const messages = {
  "status.agent.dispatchApproval":
    "Cet envoi de code comprend une opération à risque. Vérifiez sa carte et ses arguments avant de l’approuver.",
  "status.agent.dispatchStarted": "Travail de programmation démarré : {title}. Hôte : {host}. Exécution : {runId}.",
  "status.agent.dispatchFinished":
    "Travail de programmation terminé : {title}. Hôte : {host}. Résultat : {status}. Vérifiez le résultat avant d’annoncer une réussite.",
  "status.agent.dispatchNoResult": "L’exécuteur openswarm s’est terminé sans fichier de résultat.",
  "status.agent.claudeWriteOutside":
    "Écrire {path}, hors de l’espace de travail de l’agent, du dossier partagé et des dossiers temporaires.",
  "status.agent.contextCleared": "Contexte effacé. Une nouvelle discussion commence ici.",
  "status.agent.modelSwitchedForLimit": "Limite d’utilisation atteinte. Passage à {model}.",
  "status.agent.modelReturnedAfterLimit": "Limite d’utilisation terminée. Retour à {model}.",
  "status.agent.pausedHourBudget":
    "Budget de tokens atteint : {used} tokens dans la dernière heure (limite {limit}). Le nouveau travail attend que vous continuiez.",
  "status.agent.pausedTurnBudget":
    "Arrêté après une étape : ce tour a utilisé {used} tokens (limite {limit}). Le travail est conservé. Continuez pour reprendre.",
  "status.agent.pausedPlanLimit":
    "La limite du plan a arrêté ce tour. Le travail est conservé et reprend quand la limite prend fin.",
  "status.agent.marketplaceSuggested": "Application de la Marketplace suggérée : {app}.",
  "status.agent.screenCaptureScreen": "Capturer l’écran principal et envoyer l’image au modèle de l’agent.",
  "status.agent.screenCaptureDisplay": "Capturer l’écran {name} et envoyer l’image au modèle de l’agent.",
  "status.agent.screenCaptureWindow": "Capturer la fenêtre {name} et envoyer l’image au modèle de l’agent.",
  "status.agent.screenCaptureRegion":
    "Capturer la zone de l’écran à {x}, {y}, {width} × {height} points et envoyer l’image au modèle de l’agent.",
  "status.agent.screenCaptureProgress": "Demande de capture d’écran…",
  "status.agent.screenCaptureReviewing": "Analyse de la capture d’écran…",
  "status.agent.starting": "Démarrage des CLI d’agents locaux…",
} as const satisfies PartialTranslation<typeof source>;
