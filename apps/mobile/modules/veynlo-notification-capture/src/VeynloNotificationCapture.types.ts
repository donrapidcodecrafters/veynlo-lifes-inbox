export interface CapturedNotification {
  title: string;
  text: string;
  /** Epoch milliseconds — Android's StatusBarNotification.postTime. */
  postedAt: number;
  /**
   * Which app posted it.
   *
   * Empty for anything queued before the per-app allowlist existed — those were captured under the old
   * SMS-only rule and carry no package. Treat "" as "unknown", never as a package to match on.
   */
  packageName: string;
}

/** One installed app, as offered in the picker. */
export interface InstalledApp {
  packageName: string;
  /** What the launcher calls it — what a person would recognise. */
  label: string;
  /**
   * Preinstalled by the manufacturer or carrier. Shown as a hint, never used to hide anything: a carrier's
   * own app is often exactly the one sending account and delivery notifications.
   */
  isSystemApp: boolean;
}
