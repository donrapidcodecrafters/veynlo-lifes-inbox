import type { AbstractIntlMessages } from "next-intl";
import type { SupportedUiLocale } from "@veynlo/core";
import en from "./en.json";

/**
 * One entry per `SUPPORTED_UI_LOCALES` value (see `@veynlo/core`'s `util/locale.ts`). Adding a
 * locale: drop a `messages/<locale>.json` file next to `en.json` with the exact same keys, import
 * it here, and add it to this map — nothing else in the provider/loading path changes.
 */
const MESSAGES_BY_LOCALE: Record<SupportedUiLocale, AbstractIntlMessages> = {
  en,
};

export function loadMessages(locale: SupportedUiLocale): AbstractIntlMessages {
  return MESSAGES_BY_LOCALE[locale];
}
