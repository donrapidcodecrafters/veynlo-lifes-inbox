export interface NavItem {
  href: string;
  // §38.2 "Locale: all user-facing strings externalized" — a translation key into the "nav"
  // namespace (see i18n/messages/en.json), resolved via useTranslations("nav") in app-shell.tsx,
  // rather than a hardcoded label string.
  labelKey: "home" | "inbox" | "ask" | "life" | "settings";
  icon: "home" | "inbox" | "ask" | "life" | "settings";
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/home", labelKey: "home", icon: "home" },
  { href: "/inbox", labelKey: "inbox", icon: "inbox" },
  { href: "/ask", labelKey: "ask", icon: "ask" },
  { href: "/life", labelKey: "life", icon: "life" },
  { href: "/settings", labelKey: "settings", icon: "settings" },
];
