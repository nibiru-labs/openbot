import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/agent";

export const messages = {
  "status.agent.dispatchApproval":
    "Este envio de código inclui uma operação de risco. Revise o cartão e os argumentos antes de aprová-lo.",
  "status.agent.dispatchStarted":
    "Trabalho de programação iniciado: {title}. Computador anfitrião: {host}. Execução: {runId}.",
  "status.agent.dispatchFinished":
    "Trabalho de programação encerrado: {title}. Computador anfitrião: {host}. Resultado: {status}. Revise o resultado antes de relatar sucesso.",
  "status.agent.dispatchNoResult": "O executor do openswarm terminou sem arquivo de resultado.",
  "status.agent.claudeWriteOutside":
    "Gravar em {path}, fora do espaço de trabalho do agente, da pasta compartilhada e das pastas temporárias.",
  "status.agent.contextCleared": "Contexto limpo. Um novo chat começa aqui.",
  "status.agent.modelSwitchedForLimit": "Limite de uso atingido. O modelo mudou para {model}.",
  "status.agent.modelReturnedAfterLimit": "O limite de uso terminou. O modelo voltou para {model}.",
  "status.agent.pausedHourBudget":
    "Orçamento de tokens atingido: {used} tokens na última hora (limite {limit}). O trabalho novo espera até você continuar.",
  "status.agent.pausedTurnBudget":
    "Parado após uma etapa: este turno usou {used} tokens (limite {limit}). O trabalho é mantido. Continue para seguir adiante.",
  "status.agent.pausedPlanLimit":
    "O limite do plano parou este turno. O trabalho é mantido e continua quando o limite termina.",
  "status.agent.marketplaceSuggested": "App da loja sugerido: {app}.",
  "status.agent.screenCaptureScreen": "Capturar a tela principal e enviar a imagem ao modelo do agente.",
  "status.agent.screenCaptureDisplay": "Capturar o monitor {name} e enviar a imagem ao modelo do agente.",
  "status.agent.screenCaptureWindow": "Capturar a janela {name} e enviar a imagem ao modelo do agente.",
  "status.agent.screenCaptureRegion":
    "Capturar a área da tela em {x}, {y}, {width} × {height} pontos e enviar a imagem ao modelo do agente.",
  "status.agent.screenCaptureProgress": "Pedindo para capturar a tela…",
  "status.agent.screenCaptureReviewing": "Analisando a captura de tela…",
  "status.agent.starting": "Iniciando as CLIs dos agentes locais…",
} as const satisfies PartialTranslation<typeof source>;
