"use client";

import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

type ResourceGrantRight = "view" | "edit" | "manage";

interface ResourceGrant {
  grant: { id: string; expiresAt: string | null; right?: ResourceGrantRight; message?: string | null };
  granteeEmail: string;
}
interface ShareLink {
  id: string;
  expiresAt: string | null;
  hasPasscode: boolean;
}

/** §35 SHARE-007 "access history" — one row per successful view of this resource through a grant or a
 * public link (see SharingService.listAccessEvents/accessAuditEvents' own doc comments). */
interface AccessEvent {
  id: string;
  accessMethod: "grant" | "share_link";
  accessedAt: string;
  accessedByEmail: string | null;
}

const RIGHT_LABELS: Record<ResourceGrantRight, string> = { view: "Can view", edit: "Can edit", manage: "Can manage" };

/** SHARE-001 "preview exactly what recipient will see" — renders the arbitrary, resource-specific JSON
 * publicShareContent-shaped payload returned by GET .../share-preview. Deliberately generic (no per-
 * resource-type layout) since this one component is shared by lists/purchases/properties/vehicles/pets —
 * see this file's own top-of-file doc comment. */
function PreviewValue({ value }: { value: unknown }) {
  if (value == null) return <span className="text-tertiary">—</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-tertiary">None</span>;
    return (
      <ul className="ml-3 list-disc space-y-1">
        {value.map((item, i) => (
          <li key={i}>
            {typeof item === "object" && item !== null ? <PreviewObject value={item as Record<string, unknown>} /> : String(item)}
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") return <PreviewObject value={value as Record<string, unknown>} />;
  return <span className="text-primary">{String(value)}</span>;
}

function PreviewObject({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  return (
    <dl className="space-y-1">
      {entries.map(([key, v]) => (
        <div key={key} className="flex gap-2 text-xs">
          <dt className="shrink-0 font-medium text-secondary">{key}:</dt>
          <dd className="min-w-0">
            <PreviewValue value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002) — direct grants to another Veynlo account,
 * and passcode-optional public links. Generalized off documents/page.tsx's original `ShareDocumentPanel`
 * (that component's own name/shape, just parameterized by resource type now that SharingService backs
 * lists/purchases/properties/vehicles too — see services/api/src/modules/sharing/sharing.service.ts's own
 * doc comment). Mirrored on apps/mobile's own `ShareResourcePanel`.
 *
 * `collectionPath` is the resource's own API collection, e.g. "/v1/documents", "/v1/lists",
 * "/v1/purchases", "/v1/properties", "/v1/vehicles" — every one of them exposes the exact same
 * `:id/grants` / `:id/share-links` / `grants/:grantId` / `share-links/:linkId` shape (see each
 * controller's own sharing routes), so this component never needs to know what kind of resource it's
 * sharing, only where its collection lives.
 */
export function ShareResourcePanel({ resourceId, collectionPath, resourceLabel }: { resourceId: string; collectionPath: string; resourceLabel: string }) {
  const { data: grants, mutate: mutateGrants } = useSWR<ResourceGrant[]>(`${collectionPath}/${resourceId}/grants`, swrFetcher);
  const { data: links, mutate: mutateLinks } = useSWR<ShareLink[]>(`${collectionPath}/${resourceId}/share-links`, swrFetcher);
  const { data: accessEvents } = useSWR<AccessEvent[]>(`${collectionPath}/${resourceId}/access-log`, swrFetcher);
  const [email, setEmail] = useState("");
  // SHARE-001 "Set view/edit/manage" — defaults to "view", the only right that ever did anything before
  // this pass; edit/manage now have real write-path enforcement server-side (see SharingService/each
  // resource service's own doc comments).
  const [right, setRight] = useState<ResourceGrantRight>("view");
  // SHARE-001 "optional message" — a short note shown to the recipient on the shared resource's own detail
  // page ("Note from <granter>: ..."), capped to match CreateResourceGrantDtoSchema's own limit.
  const [message, setMessage] = useState("");
  // SHARE-001 "expiration" — an empty string means "until revoked" (unchanged default); the numeric
  // options mirror the day-count granularity FAM-006's caregiver-grant expiry and CreateShareLinkDto's own
  // `expiresInDays` already use elsewhere in this app.
  const [expiresInDays, setExpiresInDays] = useState("");
  const [grantError, setGrantError] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [creatingLink, setCreatingLink] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [newLinkUrl, setNewLinkUrl] = useState<string | null>(null);
  // SHARE-001 "preview exactly what recipient will see" — fetched from the same redacted read path the
  // recipient's own view eventually uses (e.g. AssetsService.publicVehicleContent), so what's shown here
  // is genuinely what they'll see, not a guess.
  const [preview, setPreview] = useState<unknown>(undefined);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  async function loadPreview() {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPreview(await api.get(`${collectionPath}/${resourceId}/share-preview`));
    } catch (err) {
      setPreviewError(err instanceof ApiError ? err.message : "Couldn't load a preview. Please try again.");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function addGrant(e: FormEvent) {
    e.preventDefault();
    setGranting(true);
    setGrantError(null);
    try {
      await api.post(`${collectionPath}/${resourceId}/grants`, {
        granteeEmail: email,
        right,
        expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
        message: message.trim() || undefined,
      });
      setEmail("");
      setRight("view");
      setMessage("");
      setExpiresInDays("");
      mutateGrants();
    } catch (err) {
      setGrantError(err instanceof ApiError ? err.message : "Couldn't share with that email. Please try again.");
    } finally {
      setGranting(false);
    }
  }

  async function revokeGrant(grantId: string, granteeEmail: string) {
    if (!window.confirm(`Stop sharing this ${resourceLabel} with ${granteeEmail}?`)) return;
    await api.delete(`${collectionPath}/grants/${grantId}`);
    mutateGrants();
  }

  async function addLink(e: FormEvent) {
    e.preventDefault();
    setCreatingLink(true);
    setLinkError(null);
    setNewLinkUrl(null);
    try {
      const { token } = await api.post<{ id: string; token: string }>(`${collectionPath}/${resourceId}/share-links`, {
        passcode: passcode.trim() || undefined,
      });
      setNewLinkUrl(`${window.location.origin}/share/${token}`);
      setPasscode("");
      mutateLinks();
    } catch (err) {
      setLinkError(err instanceof ApiError ? err.message : "Couldn't create a share link. Please try again.");
    } finally {
      setCreatingLink(false);
    }
  }

  async function revokeLink(linkId: string) {
    if (!window.confirm("Revoke this share link? Anyone using it loses access immediately.")) return;
    await api.delete(`${collectionPath}/share-links/${linkId}`);
    setNewLinkUrl(null);
    mutateLinks();
  }

  return (
    <div className="space-y-4 border-t border-border-subtle pt-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-tertiary">See exactly what a recipient would get before you share.</p>
        <Button type="button" size="sm" variant="secondary" onClick={loadPreview}>
          Preview what they&apos;ll see
        </Button>
      </div>
      {previewOpen && (
        <div className="space-y-2 rounded-lg border border-border-default bg-surface-subtle p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-secondary">Recipient preview</p>
            <button onClick={() => setPreviewOpen(false)} className="text-xs text-tertiary hover:underline">
              Close
            </button>
          </div>
          {previewLoading && <p className="text-xs text-tertiary">Loading…</p>}
          {previewError && <p className="text-xs text-critical">{previewError}</p>}
          {!previewLoading && !previewError && preview !== undefined && <PreviewValue value={preview} />}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium text-secondary">Share with someone&apos;s Veynlo account</p>
        {/* HH-002 "Changing privacy explains consequences before saving" — a short, concrete sentence
            about what the action actually does, shown above the form rather than only after submitting. */}
        <p className="text-xs text-tertiary">
          They&apos;ll get {RIGHT_LABELS[right].toLowerCase()} access to this {resourceLabel} until you remove them below.
        </p>
        {grants && grants.length > 0 && (
          <ul className="space-y-1">
            {grants.map((g) => (
              <li key={g.grant.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-primary" title={g.granteeEmail}>
                  {g.granteeEmail}
                  <span className="ml-1.5 text-tertiary">
                    — {RIGHT_LABELS[g.grant.right ?? "view"]}, {g.grant.expiresAt ? `expires ${new Date(g.grant.expiresAt).toLocaleDateString()}` : "until revoked"}
                  </span>
                  {g.grant.message && <span className="block text-tertiary">Note: {g.grant.message}</span>}
                </span>
                <button onClick={() => revokeGrant(g.grant.id, g.granteeEmail)} className="shrink-0 text-critical hover:underline">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addGrant} className="flex flex-wrap gap-2">
          <input
            type="email"
            placeholder="their@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="h-8 flex-1 rounded-lg border border-border-default bg-surface px-2 text-xs text-primary"
          />
          <select
            value={right}
            onChange={(e) => setRight(e.target.value as ResourceGrantRight)}
            aria-label="Access level"
            className="h-8 rounded-lg border border-border-default bg-surface px-2 text-xs text-primary"
          >
            <option value="view">Can view</option>
            <option value="edit">Can edit</option>
            <option value="manage">Can manage</option>
          </select>
          <select
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            aria-label="Access expires"
            className="h-8 rounded-lg border border-border-default bg-surface px-2 text-xs text-primary"
          >
            <option value="">Until revoked</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </select>
          <input
            type="text"
            placeholder="Optional note to them"
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, 500))}
            className="h-8 min-w-[10rem] flex-1 rounded-lg border border-border-default bg-surface px-2 text-xs text-primary"
          />
          <Button type="submit" size="sm" loading={granting} disabled={!email.trim()}>
            Share
          </Button>
        </form>
        {grantError && <p className="text-xs text-critical">{grantError}</p>}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-secondary">Public link</p>
        <p className="text-xs text-tertiary">
          Anyone with the link{" "}
          {passcode.trim() ? "and the passcode " : ""}
          can view this {resourceLabel} without a Veynlo account — treat it like handing over a copy. Highly sensitive items can&apos;t use a public link.
        </p>
        {links && links.length > 0 && (
          <ul className="space-y-1">
            {links.map((l) => (
              <li key={l.id} className="flex items-center justify-between text-xs">
                <span className="text-tertiary">{l.hasPasscode ? "Passcode-protected link" : "Open link"}</span>
                <button onClick={() => revokeLink(l.id)} className="text-critical hover:underline">
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addLink} className="flex gap-2">
          <input
            type="text"
            placeholder="Optional passcode"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            className="h-8 flex-1 rounded-lg border border-border-default bg-surface px-2 text-xs text-primary"
          />
          <Button type="submit" size="sm" variant="secondary" loading={creatingLink}>
            Create link
          </Button>
        </form>
        {linkError && <p className="text-xs text-critical">{linkError}</p>}
        {newLinkUrl && (
          <p className="rounded-lg bg-positive-subtle px-2 py-1.5 text-xs text-positive-subtle-text">
            {newLinkUrl} — copy this now, it won&apos;t be shown again.
          </p>
        )}
      </div>

      {/* §35 SHARE-007 "access history" — who's actually looked at this, not just who currently has
          access (the grants/links lists above already cover that). Only rendered once there's at least
          one event, so a never-viewed share doesn't show an empty, confusing section. */}
      {accessEvents && accessEvents.length > 0 && (
        <div className="space-y-2 border-t border-border-subtle pt-3">
          <p className="text-xs font-medium text-secondary">Who&apos;s viewed this</p>
          <ul className="space-y-1">
            {accessEvents.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-primary">
                  {e.accessedByEmail ?? "Someone via the public link"}
                </span>
                <span className="shrink-0 text-tertiary">{new Date(e.accessedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
