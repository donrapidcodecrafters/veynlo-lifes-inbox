"use client";

import { useState } from "react";
import useSWR from "swr";
import { api, ApiError, swrFetcher } from "@/lib/api-client";

interface Merchant {
  id: string;
  displayName: string;
  domain: string | null;
  createdAt: string;
}

interface MergeLineageEntry {
  id: string;
  survivingMerchantId: string;
  mergedMerchantId: string;
  mergedMerchantSnapshot: { displayName: string };
  repointedPurchaseIds: string[];
  actorAdminId: string;
  mergedAt: string;
  unmergedAt: string | null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border-subtle bg-surface p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

export default function MerchantsPage() {
  const { data: merchants, mutate: mutateMerchants } = useSWR<Merchant[]>("/v1/admin/merchants", swrFetcher);
  const { data: duplicateGroups, mutate: mutateDuplicates } = useSWR<Merchant[][]>(
    "/v1/admin/merchants/duplicate-candidates",
    swrFetcher,
  );
  const { data: lineage, mutate: mutateLineage } = useSWR<MergeLineageEntry[]>("/v1/admin/merchants/merge-lineage", swrFetcher);

  const [survivingId, setSurvivingId] = useState("");
  const [mergedId, setMergedId] = useState("");
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeStatus, setMergeStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const merchantName = (id: string) => merchants?.find((m) => m.id === id)?.displayName ?? id;

  async function refreshAll() {
    await Promise.all([mutateMerchants(), mutateDuplicates(), mutateLineage()]);
  }

  async function runMerge(survivingMerchantId: string, mergedMerchantId: string) {
    setMergeError(null);
    setMergeStatus(null);
    setBusy(true);
    try {
      const result = await api.post<{ lineageId: string; repointedPurchaseCount: number }>("/v1/admin/merchants/merge", {
        survivingMerchantId,
        mergedMerchantId,
      });
      setMergeStatus(`Merged. ${result.repointedPurchaseCount} purchase(s) repointed.`);
      setSurvivingId("");
      setMergedId("");
      await refreshAll();
    } catch (err) {
      setMergeError(err instanceof ApiError ? err.message : "Merge failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runUnmerge(lineageId: string) {
    setBusy(true);
    setMergeError(null);
    setMergeStatus(null);
    try {
      const result = await api.post<{ restoredPurchaseCount: number }>(`/v1/admin/merchants/merge-lineage/${lineageId}/unmerge`);
      setMergeStatus(`Undone. ${result.restoredPurchaseCount} purchase(s) restored.`);
      await refreshAll();
    } catch (err) {
      setMergeError(err instanceof ApiError ? err.message : "Undo failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Section title="Likely duplicates">
        <p className="mb-4 text-sm text-tertiary">
          Grouped by a normalized name — a starting point to review, not an automatic merge.
        </p>
        {!duplicateGroups && <p className="text-sm text-tertiary">Loading…</p>}
        {duplicateGroups && duplicateGroups.length === 0 && (
          <p className="text-sm text-tertiary">No likely duplicates found.</p>
        )}
        {duplicateGroups && duplicateGroups.length > 0 && (
          <div className="space-y-3">
            {duplicateGroups.map((group) => {
              const [survivor, toMerge] = group;
              if (!survivor || !toMerge) return null;
              return (
                <div key={group.map((m) => m.id).join(",")} className="flex flex-wrap items-center gap-2 rounded-lg bg-subtle p-3">
                  {group.map((m) => (
                    <span key={m.id} className="rounded-full bg-surface px-2.5 py-1 text-xs font-medium text-primary">
                      {m.displayName}
                    </span>
                  ))}
                  <button
                    disabled={busy}
                    onClick={() => runMerge(survivor.id, toMerge.id)}
                    className="ml-auto rounded-lg border border-border-default px-3 py-1 text-xs font-medium text-secondary hover:bg-surface disabled:opacity-50"
                  >
                    Merge into &ldquo;{survivor.displayName}&rdquo;
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Merge manually">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-tertiary">Surviving merchant ID</span>
            <input
              value={survivingId}
              onChange={(e) => setSurvivingId(e.target.value)}
              placeholder="mer_..."
              className="h-10 w-64 rounded-lg border border-border-default bg-surface px-3.5 text-sm text-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-tertiary">Merchant ID to merge away</span>
            <input
              value={mergedId}
              onChange={(e) => setMergedId(e.target.value)}
              placeholder="mer_..."
              className="h-10 w-64 rounded-lg border border-border-default bg-surface px-3.5 text-sm text-primary"
            />
          </label>
          <button
            disabled={busy || !survivingId.trim() || !mergedId.trim()}
            onClick={() => runMerge(survivingId.trim(), mergedId.trim())}
            className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand hover:bg-brand-hover disabled:opacity-50"
          >
            Merge
          </button>
        </div>
        {mergeError && <p className="mt-3 text-sm text-critical-subtle-text">{mergeError}</p>}
        {mergeStatus && <p className="mt-3 text-sm text-positive-subtle-text">{mergeStatus}</p>}
      </Section>

      <Section title="All merchants">
        {!merchants && <p className="text-sm text-tertiary">Loading…</p>}
        {merchants && (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-tertiary">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Domain</th>
                <th className="pb-2 font-medium">ID</th>
              </tr>
            </thead>
            <tbody>
              {merchants.map((m) => (
                <tr key={m.id} className="border-t border-border-subtle">
                  <td className="py-2 text-primary">{m.displayName}</td>
                  <td className="py-2 text-tertiary">{m.domain ?? "—"}</td>
                  <td className="py-2 font-mono text-xs text-tertiary">{m.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Merge history">
        {!lineage && <p className="text-sm text-tertiary">Loading…</p>}
        {lineage && lineage.length === 0 && <p className="text-sm text-tertiary">No merges yet.</p>}
        {lineage && lineage.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-tertiary">
                <th className="pb-2 font-medium">When</th>
                <th className="pb-2 font-medium">Merged</th>
                <th className="pb-2 font-medium">Into</th>
                <th className="pb-2 font-medium">Purchases moved</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {lineage.map((entry) => (
                <tr key={entry.id} className="border-t border-border-subtle">
                  <td className="py-2 text-tertiary">{new Date(entry.mergedAt).toLocaleString()}</td>
                  <td className="py-2 text-primary">{entry.mergedMerchantSnapshot.displayName}</td>
                  <td className="py-2 text-primary">{merchantName(entry.survivingMerchantId)}</td>
                  <td className="py-2 text-tertiary">{entry.repointedPurchaseIds.length}</td>
                  <td className="py-2">
                    {entry.unmergedAt ? (
                      <span className="text-tertiary">undone</span>
                    ) : (
                      <span className="text-positive">active</span>
                    )}
                  </td>
                  <td className="py-2">
                    {!entry.unmergedAt && (
                      <button
                        disabled={busy}
                        onClick={() => runUnmerge(entry.id)}
                        className="rounded-lg border border-border-default px-2.5 py-1 text-xs font-medium text-secondary hover:bg-subtle disabled:opacity-50"
                      >
                        Undo
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
