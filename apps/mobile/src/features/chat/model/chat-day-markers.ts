import type { AppFormat, MobileTranslate } from "@openbot/i18n/mobile";

/** The clock a caller can replace, so a test does not depend on the day the test runs. */
export interface DayMarkerOptions {
  now?: Date;
  t: MobileTranslate;
  format: AppFormat;
}

function startOfDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function dayDifference(from: Date, to: Date): number {
  return Math.round((startOfDay(to) - startOfDay(from)) / 86_400_000);
}

function timeOf(value: Date, format: AppFormat): string {
  return format.date(value, { hour: "numeric", minute: "2-digit" });
}

function dateOf(value: Date, format: AppFormat): string {
  return format.date(value, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * The label for the separator above a message, or `null` when the message needs none. The rule
 * matches desktop `chat-day-markers.ts`.
 */
export function dayMarkerLabel(
  previousIso: string | undefined,
  currentIso: string,
  options: DayMarkerOptions,
): string | null {
  const current = new Date(currentIso);
  if (Number.isNaN(current.getTime())) return null;
  if (previousIso !== undefined) {
    const previous = new Date(previousIso);
    if (!Number.isNaN(previous.getTime()) && dayDifference(previous, current) === 0) return null;
  }
  const now = options.now ?? new Date();
  const age = dayDifference(current, now);
  const time = timeOf(current, options.format);
  if (age === 0) return options.t("mobile.chat.day.today", { time });
  if (age === 1) return options.t("mobile.chat.day.yesterday", { time });
  return options.t("mobile.chat.day.date", { date: dateOf(current, options.format), time });
}
