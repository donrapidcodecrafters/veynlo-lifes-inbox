/**
 * Task apps a user can connect with a token they issue themselves.
 *
 * Appendix A lists nine task/reminder targets. Google Tasks and Microsoft To Do are built; Apple Reminders
 * is device-local and lives in the mobile app. The remaining six — Todoist, TickTick, Any.do, Notion,
 * Trello, Asana — have nothing.
 *
 * Three of those can be connected TODAY with no deployment credential of any kind, because they issue
 * personal access tokens the user creates in their own account settings. That is the same shape as the
 * IMAP app passwords: nothing to register, nothing to get approved, no client secret this deployment has
 * to hold. It is the difference between a connector that works and one that waits for a partner agreement.
 *
 *   Todoist  — API token, in Settings → Integrations → Developer
 *   Trello   — API key plus a token, from Trello's developer page
 *   Asana    — personal access token, in My Settings → Apps → Developer apps
 *
 * TickTick and Any.do are deliberately absent: both are OAuth-only, which needs a registered application
 * and therefore a credential this deployment does not have. Notion is absent for a different and more
 * interesting reason — Notion has no "task" concept. Tasks there are rows in a database whose columns the
 * user invented, so "which property is the due date" has no general answer. Guessing would produce
 * confidently wrong due dates, which is worse than not offering it.
 *
 * ---------------------------------------------------------------------------------------------------
 * A note on what is stored
 * ---------------------------------------------------------------------------------------------------
 * Each provider returns far more than this app uses. Only the title, due date and completion state are
 * kept — the same three fields the Google Tasks connector keeps — because that is what the product does
 * with a task. Descriptions, comments, attachments, assignees and project structure are left where they
 * are.
 */

/** The shape every provider is normalized into before anything touches the database. */
export interface NormalizedTask {
  externalId: string;
  title: string;
  /** YYYY-MM-DD, or null. Never a guess: a task with no due date has none. */
  dueDate: string | null;
  completed: boolean;
}

export interface TokenTaskProvider {
  key: string;
  label: string;
  /** What the user has to create, in that provider's own words. */
  credentialHint: string;
  credentialUrl: string | null;
  /** Trello needs an API key alongside the token; the others do not. */
  requiresApiKey: boolean;
  /** Where requests go. Held here so a test can point at a local server without touching the adapter. */
  apiBase: string;
}

export const TOKEN_TASK_PROVIDERS: TokenTaskProvider[] = [
  {
    key: "todoist",
    label: "Todoist",
    credentialHint: "Todoist issues an API token under Settings, Integrations, Developer. Copy it and paste it here.",
    credentialUrl: "https://app.todoist.com/app/settings/integrations/developer",
    requiresApiKey: false,
    apiBase: "https://api.todoist.com",
  },
  {
    key: "trello",
    label: "Trello",
    credentialHint: "Trello needs both an API key and a token, generated together on Trello's developer page.",
    credentialUrl: "https://trello.com/power-ups/admin",
    requiresApiKey: true,
    apiBase: "https://api.trello.com",
  },
  {
    key: "asana",
    label: "Asana",
    credentialHint: "Asana issues a personal access token under My Settings, Apps, Developer apps.",
    credentialUrl: "https://app.asana.com/0/my-apps",
    requiresApiKey: false,
    apiBase: "https://app.asana.com",
  },
];

export function findTokenTaskProvider(key: string): TokenTaskProvider | undefined {
  return TOKEN_TASK_PROVIDERS.find((p) => p.key === key);
}

export function listTokenTaskProviders(): TokenTaskProvider[] {
  return TOKEN_TASK_PROVIDERS;
}

/** A date that is already YYYY-MM-DD, or the date part of an ISO timestamp. Anything else is dropped. */
export function toDueDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (!match) return null;
  const date = match[1]!;
  // Reject a syntactically valid but impossible date rather than storing it.
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  return date;
}

function clampTitle(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 500);
}

/**
 * Todoist REST v2 — `GET /rest/v2/tasks` returns only OPEN tasks, so nothing here is ever completed.
 *
 * That is a real limitation rather than an oversight: Todoist's completed tasks live behind a separate
 * Sync API endpoint with its own pagination. Reporting `completed: false` for everything returned is
 * accurate for what this endpoint gives, and a task completed in Todoist simply stops appearing.
 */
export function normalizeTodoist(payload: unknown): NormalizedTask[] {
  if (!Array.isArray(payload)) return [];
  const out: NormalizedTask[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== "object") continue;
    const task = raw as Record<string, unknown>;
    const id = task.id;
    if (typeof id !== "string" && typeof id !== "number") continue;
    const due = task.due as Record<string, unknown> | null | undefined;
    out.push({
      externalId: String(id),
      title: clampTitle(task.content, "Untitled task"),
      dueDate: toDueDate(due?.date ?? due?.datetime),
      completed: task.is_completed === true,
    });
  }
  return out;
}

/** Trello — `GET /1/members/me/cards`. `dueComplete` is the card's own completion flag. */
export function normalizeTrello(payload: unknown): NormalizedTask[] {
  if (!Array.isArray(payload)) return [];
  const out: NormalizedTask[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== "object") continue;
    const card = raw as Record<string, unknown>;
    if (typeof card.id !== "string") continue;
    out.push({
      externalId: card.id,
      title: clampTitle(card.name, "Untitled card"),
      dueDate: toDueDate(card.due),
      completed: card.dueComplete === true || card.closed === true,
    });
  }
  return out;
}

/** Asana — `GET /api/1.0/tasks`. `due_on` is a date; `due_at` is a timestamp; either may be present. */
export function normalizeAsana(payload: unknown): NormalizedTask[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: NormalizedTask[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const task = raw as Record<string, unknown>;
    const gid = task.gid;
    if (typeof gid !== "string") continue;
    out.push({
      externalId: gid,
      title: clampTitle(task.name, "Untitled task"),
      dueDate: toDueDate(task.due_on ?? task.due_at),
      completed: task.completed === true,
    });
  }
  return out;
}
