import type { RespondToPromptInput } from "@openbot/contracts/ipc";
import {
  type UiBlockResponse,
  type UiBlockState,
  uiBlockAnswersFromResponse,
  uiBlockFallbackQuestions,
  uiBlockOutcomeText,
} from "@openbot/contracts/ui-blocks";
import { useRef, useState } from "react";
import type { ChatMessage } from "@/features/chat/model/chat-messages";
import { haptics } from "@/shared/lib/haptics";
import { currentText } from "@/shared/lib/text";

export function useUiBlockPrompt(
  agentId: string,
  message: Extract<ChatMessage, { kind: "uiBlock" }> | undefined,
  canSend: boolean,
  respond: (agentId: string, input: RespondToPromptInput) => Promise<void>,
) {
  const scope = JSON.stringify([agentId, message?.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<UiBlockState>();
  const submitting = useRef(new Set<string>());

  const block = message?.block;
  const prompt = message?.prompt;
  const stored = block?.state.status === "pending" ? (sent ?? block.state) : block?.state;
  const state = (): UiBlockState | undefined => {
    if (!stored || !block) return stored;
    if (stored.status !== "answered" || !stored.response) return stored;
    const { format } = currentText();
    const outcome = uiBlockOutcomeText(block.spec, stored.response, format.list);
    return outcome.trim() ? { ...stored, outcome } : stored;
  };
  const disabled = !canSend || busy || state()?.status !== "pending" || !prompt || !block;

  async function send(answers: Record<string, string[]>, frozen: UiBlockState): Promise<void> {
    if (disabled || !prompt || submitting.current.has(scope)) return;
    submitting.current.add(scope);
    setBusy(true);
    setError(undefined);
    try {
      await respond(agentId, { requestId: prompt.requestId, answers });
      setSent(frozen);
      void haptics.notification("success");
    } catch {
      void haptics.notification("error");
      setError(currentText().t("uiBlock.error.answerFailed"));
    } finally {
      submitting.current.delete(scope);
      setBusy(false);
    }
  }

  function respondWith(response: UiBlockResponse): void {
    if (!block) return;
    const outcome = uiBlockOutcomeText(block.spec, response);
    void send(uiBlockAnswersFromResponse(block.spec, response), {
      status: "answered",
      response,
      ...(outcome.trim() ? { outcome } : {}),
    });
  }

  function skip(): void {
    if (!block) return;
    const answers = Object.fromEntries(uiBlockFallbackQuestions(block.spec).map((question) => [question.id, []]));
    void send(answers, { status: "closed" });
  }

  return {
    messageId: message?.id,
    block,
    state: state(),
    disabled,
    busy,
    error,
    respond: disabled ? undefined : respondWith,
    skip: disabled ? undefined : skip,
  };
}

export type UiBlockPromptController = ReturnType<typeof useUiBlockPrompt>;
