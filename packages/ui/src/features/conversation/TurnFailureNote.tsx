import { ErrorReference } from "../../error-reference";
import { useText } from "../../text";

/** Under a user message whose delivery failed. Shows a catalog reason and an optional code. */
export function TurnFailureNote(props: { reason?: string | undefined; reference?: string | null | undefined }) {
  const { t } = useText();
  const text = () => {
    const reason = props.reason?.trim();
    return reason || t("chat.turnFailure.fallback");
  };
  return (
    <p class="message-turn-failure" role="alert">
      <span>{text()}</span>
      <ErrorReference reference={props.reference ?? null} />
    </p>
  );
}
