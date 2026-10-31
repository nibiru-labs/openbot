import type { TranslatedLocale } from "@openbot/i18n";
import type { JSX } from "@solidjs/web";
import { createContext, createEffect, type ParentProps, useContext } from "solid-js";
import { createTextValue, setActiveFormatLocale, setActiveLocale, type TextValue } from "./text-value";

export { currentText, type TextValue } from "./text-value";

const TextContext = createContext<TextValue>(
  createTextValue(
    () => "en",
    () => null,
  ),
  { name: "Text" },
);

export interface TextProviderProps {
  locale: TranslatedLocale;
  /** The locale of numbers and dates (`formatLocale` from `@openbot/i18n`). The default is `locale`. */
  formatLocale?: string | undefined;
}

export function TextProvider(props: ParentProps<TextProviderProps>): JSX.Element {
  const formatLocale = () => props.formatLocale ?? props.locale;
  const value = createTextValue(() => props.locale, formatLocale);
  createEffect(
    () => [props.locale, formatLocale()] as const,
    ([locale, format]) => {
      setActiveLocale(locale);
      setActiveFormatLocale(format);
    },
  );
  return <TextContext value={value}>{props.children}</TextContext>;
}

export function useText(): TextValue {
  return useContext(TextContext);
}
