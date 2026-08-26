"use client";

import Link from "next/link";
import useSWR from "swr";
import { swrFetcher } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

interface Purchase {
  id: string;
  orderNumber: string | null;
  purchaseDate: TemporalValueLike;
  totalMinorUnits: number | null;
  totalCurrency: string | null;
  state: string;
}

interface ReturnRow {
  returnCase: {
    id: string;
    deadline: TemporalValueLike;
    valueAtStakeMinorUnits: number | null;
    valueAtStakeCurrency: string | null;
    state: string;
  };
  purchase: { id: string; orderNumber: string | null };
}

interface SubscriptionRow {
  subscription: { id: string; state: string };
  stream: { serviceLabel: string; typicalAmountMinorUnits: number | null; typicalAmountCurrency: string | null; cadence: string };
}

interface BillRow {
  bill: {
    id: string;
    billerLabel: string;
    amountDueMinorUnits: number | null;
    amountDueCurrency: string | null;
    dueDate: TemporalValueLike;
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

export default function LifePage() {
  const { data: purchases, isLoading: loadingPurchases } = useSWR<Purchase[]>("/v1/purchases", swrFetcher);
  const { data: returns, isLoading: loadingReturns } = useSWR<ReturnRow[]>("/v1/returns", swrFetcher);
  const { data: subscriptions, isLoading: loadingSubs } = useSWR<SubscriptionRow[]>("/v1/subscriptions", swrFetcher);
  const { data: bills, isLoading: loadingBills } = useSWR<BillRow[]>("/v1/bills", swrFetcher);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Life</h1>
          <p className="mt-1 text-sm text-tertiary">Everything Veynlo knows you own, owe, and are due back.</p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/timeline"
            className="rounded-full border border-border-default px-3 py-1.5 text-sm font-medium text-secondary hover:bg-subtle"
          >
            Timeline →
          </Link>
          <Link
            href="/documents"
            className="rounded-full border border-border-default px-3 py-1.5 text-sm font-medium text-secondary hover:bg-subtle"
          >
            Documents →
          </Link>
        </div>
      </header>

      <Section title="Returns">
        {loadingReturns && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingReturns && (!returns || returns.length === 0) && (
          <EmptyState title="No open returns" description="When a return window is closing, it'll show up here with the deadline and value at stake." />
        )}
        {returns && returns.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {returns.map((r) => {
              const days = daysUntil(r.returnCase.deadline);
              const value = formatMoneyMinorUnits(r.returnCase.valueAtStakeMinorUnits, r.returnCase.valueAtStakeCurrency);
              return (
                <Card key={r.returnCase.id}>
                  <CardBody className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-primary">Order {r.purchase.orderNumber ?? "—"}</p>
                      {days != null && (
                        <Badge tone={days <= 3 ? "critical" : "warning"}>{days > 0 ? `${days}d left` : "Due today"}</Badge>
                      )}
                    </div>
                    {value && <p className="text-lg font-semibold text-primary">{value}</p>}
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Subscriptions">
        {loadingSubs && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingSubs && (!subscriptions || subscriptions.length === 0) && (
          <EmptyState title="No subscriptions detected yet" description="Connect email or a financial account and Veynlo will find recurring charges automatically." />
        )}
        {subscriptions && subscriptions.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {subscriptions.map((s) => {
              const amount = formatMoneyMinorUnits(s.stream.typicalAmountMinorUnits, s.stream.typicalAmountCurrency);
              return (
                <div key={s.subscription.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-primary">{s.stream.serviceLabel}</p>
                    <p className="text-xs text-tertiary capitalize">{s.stream.cadence}</p>
                  </div>
                  <div className="text-right">
                    {amount && <p className="text-sm font-medium text-primary">{amount}</p>}
                    {s.subscription.state === "price_changed" && <Badge tone="warning">Price changed</Badge>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Bills">
        {loadingBills && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingBills && (!bills || bills.length === 0) && (
          <EmptyState title="No bills detected yet" description="Bills discovered from email or connected accounts will appear here with due dates." />
        )}
        {bills && bills.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {bills.map((b) => {
              const due = formatTemporal(b.bill.dueDate);
              const amount = formatMoneyMinorUnits(b.bill.amountDueMinorUnits, b.bill.amountDueCurrency);
              return (
                <div key={b.bill.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-primary">{b.bill.billerLabel}</p>
                    {due && <p className="text-xs text-tertiary">Due {due}</p>}
                  </div>
                  {amount && <p className="text-sm font-medium text-primary">{amount}</p>}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Purchases">
        {loadingPurchases && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingPurchases && (!purchases || purchases.length === 0) && (
          <EmptyState title="No purchases yet" description="Connect email or scan a receipt and Veynlo will organize your purchases automatically." />
        )}
        {purchases && purchases.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {purchases.map((p) => {
              const date = formatTemporal(p.purchaseDate);
              const total = formatMoneyMinorUnits(p.totalMinorUnits, p.totalCurrency);
              return (
                <div key={p.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-primary">Order {p.orderNumber ?? "—"}</p>
                    {date && <p className="text-xs text-tertiary">{date}</p>}
                  </div>
                  {total && <p className="text-sm font-medium text-primary">{total}</p>}
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
