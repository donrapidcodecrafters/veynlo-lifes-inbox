/**
 * Runs before paint (inlined into <head>) so switching themes never flashes
 * the wrong palette. Mirrors the persistence contract in useTheme().
 */
export const THEME_STORAGE_KEY = "veynlo-theme";

export function themeInitScript(): string {
  return `(function() {
    try {
      var stored = localStorage.getItem("${THEME_STORAGE_KEY}");
      var mode = stored === "light" || stored === "dark" ? stored : "system";
      if (mode !== "system") {
        document.documentElement.setAttribute("data-theme", mode);
      }
    } catch (e) {}
  })();`;
}
