import { Button, ChevronDown } from "@openbot/ui";
import { createMemo, createSignal, createUniqueId, For, untrack } from "solid-js";
import type { AgentMessage } from "../../data";
import { useText } from "../../text";

/** One disclosure for the notes of a turn. Streaming updates keep its open state. */
export function ResponseProcess(props: { message: AgentMessage; defaultOpen?: boolean }) {
  const { t } = useText();
  const panelId = createUniqueId();
  const [open, setOpen] = createSignal(untrack(() => props.defaultOpen ?? false));
  const notes = createMemo(() => (props.message.items ?? [props.message.body]).filter((note) => note.trim()));
  return (
    <section
      class="task-list response-process"
      data-open={open() ? "" : undefined}
      data-chat-search-message={props.message.id}
      data-chat-search-group={props.message.itemIds?.join(" ")}
    >
      <Button
        type="button"
        variant="ghost"
        class="task-list-header"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={panelId}
        data-cuelume-tap={open() ? "close" : "open"}
        onClick={() => setOpen((value) => !value)}
      >
        <span class="task-list-title">{t("chat.responseProcess.title")}</span>
        <ChevronDown class="task-list-chevron" aria-hidden="true" />
      </Button>
      <div id={panelId} hidden={!open()}>
        <ol class="response-process-notes">
          <For each={notes()} keyed={false} fallback={<li>{t("chat.responseProcess.empty")}</li>}>
            {(note) => <li>{note()}</li>}
          </For>
        </ol>
      </div>
    </section>
  );
}
