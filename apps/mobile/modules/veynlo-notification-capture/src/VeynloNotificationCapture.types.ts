export interface CapturedNotification {
  title: string;
  text: string;
  /** Epoch milliseconds — Android's StatusBarNotification.postTime. */
  postedAt: number;
}
