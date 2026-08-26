export interface NavItem {
  href: string;
  label: string;
  icon: "home" | "inbox" | "ask" | "life" | "settings";
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/home", label: "Home", icon: "home" },
  { href: "/inbox", label: "Inbox", icon: "inbox" },
  { href: "/ask", label: "Ask", icon: "ask" },
  { href: "/life", label: "Life", icon: "life" },
  { href: "/settings", label: "Settings", icon: "settings" },
];
