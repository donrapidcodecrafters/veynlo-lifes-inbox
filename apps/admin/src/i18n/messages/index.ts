import type { AbstractIntlMessages } from "next-intl";
import type { SupportedUiLocale } from "@veynlo/core";
import en from "./en.json";

/** Mirrors apps/web's identical loader (see that app's i18n/messages/index.ts) — one entry per
 * `SUPPORTED_UI_LOCALES` value. Adding a locale: drop a `messages/<locale>.json` file with the same
 * keys, import it here, and add it to this map. */
const MESSAGES_BY_LOCALE: Record<SupportedUiLocale, AbstractIntlMessages> = {
  en,
};

export function loadMessages(locale: SupportedUiLocale): AbstractIntlMessages {
  return MESSAGES_BY_LOCALE[locale];
}
