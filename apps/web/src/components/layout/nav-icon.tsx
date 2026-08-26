import type { NavItem } from "./nav-items";

const PATHS: Record<NavItem["icon"], string> = {
  home: "M3 11.5 12 4l9 7.5M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9",
  inbox: "M4 5h16v10.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Zm0 6h4.5l1.2 2.2a1 1 0 0 0 .88.5h2.84a1 1 0 0 0 .88-.5L15.5 11H20",
  ask: "M12 20a8 8 0 1 0-5.3-2L4 21l3-1.7A7.96 7.96 0 0 0 12 20Zm-1-9h2m-2 3.5h2M9.5 8.2a2.5 2.5 0 1 1 3.6 2.24c-.65.33-1.1.9-1.1 1.56",
  life: "M4 21V9l8-5 8 5v12M9 21v-6h6v6M4 9l8-5 8 5",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 1-.14 1.4l2 1.5-2 3.4-2.36-.8a7.5 7.5 0 0 1-2.4 1.4L14 21h-4l-.5-2.1a7.5 7.5 0 0 1-2.4-1.4l-2.36.8-2-3.4 2-1.5A7.4 7.4 0 0 1 4.6 12a7.4 7.4 0 0 1 .14-1.4l-2-1.5 2-3.4 2.36.8a7.5 7.5 0 0 1 2.4-1.4L10 3h4l.5 2.1a7.5 7.5 0 0 1 2.4 1.4l2.36-.8 2 3.4-2 1.5c.09.46.14.93.14 1.4Z",
};

export function NavIcon({ icon, className }: { icon: NavItem["icon"]; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[icon]} />
    </svg>
  );
}
