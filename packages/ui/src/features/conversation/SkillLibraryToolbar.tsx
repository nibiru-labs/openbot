import { Button, SlidingRadioGroup } from "@openbot/ui";
import { Show } from "solid-js";
import { useText } from "../../text";

/** `localTab` defaults to true. It is false for an agent on a joined server: the library is on the host. */
export function SkillLibraryToolbar(props: {
  value: string;
  onChange: (value: string) => void;
  canCreate: boolean;
  onCreate: () => void;
  localTab?: boolean;
}) {
  const { t } = useText();
  return (
    <div class="agent-skills-toolbar">
      <SlidingRadioGroup.Root aria-label={t("skill.toolbar.source")} value={props.value} onChange={props.onChange}>
        <SlidingRadioGroup.Item value="all">{t("skill.toolbar.all")}</SlidingRadioGroup.Item>
        <Show when={props.localTab !== false}>
          <SlidingRadioGroup.Item value="local">{t("skill.toolbar.local")}</SlidingRadioGroup.Item>
        </Show>
        <SlidingRadioGroup.Item value="enabled">{t("skill.toolbar.enabled")}</SlidingRadioGroup.Item>
      </SlidingRadioGroup.Root>
      <Button size="sm" disabled={!props.canCreate} onClick={props.onCreate}>
        {t("skill.toolbar.create")}
      </Button>
    </div>
  );
}
