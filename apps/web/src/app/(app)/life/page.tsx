"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { api, swrFetcher } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

interface Task {
  id: string;
  title: string;
  dueCondition: TemporalValueLike | null;
  priority: string;
  state: string;
  recurrenceRule: string | null;
  externalSyncProvider: string | null;
}

interface ScheduleConflict {
  id: string;
  involvedEventIds: string[];
  resolvedAt: string | null;
}

interface Purchase {
  id: string;
  orderNumber: string | null;
  purchaseDate: TemporalValueLike;
  totalMinorUnits: number | null;
  totalCurrency: string | null;
  state: string;
  merchantName: string | null;
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

interface EventRow {
  id: string;
  title: string;
  start: TemporalValueLike;
  isAllDay: boolean;
  location: string | null;
}

interface Warranty {
  id: string;
  productLabel: string;
  expirationDate: TemporalValueLike;
  registrationConfirmed: boolean | null;
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
  const { data: events, isLoading: loadingEvents } = useSWR<EventRow[]>("/v1/events", swrFetcher);
  const { data: purchases, isLoading: loadingPurchases } = useSWR<Purchase[]>("/v1/purchases", swrFetcher);
  const { data: returns, isLoading: loadingReturns } = useSWR<ReturnRow[]>("/v1/returns", swrFetcher);
  const { data: subscriptions, isLoading: loadingSubs } = useSWR<SubscriptionRow[]>("/v1/subscriptions", swrFetcher);
  const { data: bills, isLoading: loadingBills } = useSWR<BillRow[]>("/v1/bills", swrFetcher);
  const { data: warranties, isLoading: loadingWarranties } = useSWR<Warranty[]>("/v1/warranties", swrFetcher);
  const { data: tasks, isLoading: loadingTasks, mutate: mutateTasks } = useSWR<Task[]>("/v1/tasks", swrFetcher);
  const { data: conflicts } = useSWR<ScheduleConflict[]>("/v1/schedule/conflicts", swrFetcher);
  const openConflicts = conflicts?.filter((c) => !c.resolvedAt) ?? [];

  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [creatingTask, setCreatingTask] = useState(false);

  async function createTask() {
    if (!newTaskTitle.trim()) return;
    setCreatingTask(true);
    try {
      await api.post("/v1/tasks", { title: newTaskTitle });
      setNewTaskTitle("");
      mutateTasks();
    } finally {
      setCreatingTask(false);
    }
  }

  async function completeTask(id: string) {
    await api.post(`/v1/tasks/${id}/complete`);
    mutateTasks();
  }

  async function deleteTask(id: string) {
    await api.delete(`/v1/tasks/${id}`);
    mutateTasks();
  }

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
          <Link
            href="/people"
            className="rounded-full border border-border-default px-3 py-1.5 text-sm font-medium text-secondary hover:bg-subtle"
          >
            People →
          </Link>
          <Link
            href="/saved"
            className="rounded-full border border-border-default px-3 py-1.5 text-sm font-medium text-secondary hover:bg-subtle"
          >
            Saved →
          </Link>
        </div>
      </header>

      {openConflicts.length > 0 && (
        <Card className="border-warning/40 bg-warning-subtle">
          <CardBody>
            <p className="text-sm text-warning-subtle-text">
              {openConflicts.length} scheduling conflict{openConflicts.length > 1 ? "s" : ""} — two of your events overlap in time.
            </p>
          </CardBody>
        </Card>
      )}

      <Section title="Tasks">
        <div className="mb-3 flex gap-2">
          <Input
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            placeholder="Add a task…"
            className="flex-1"
            onKeyDown={(e) => e.key === "Enter" && createTask()}
          />
          <Button size="sm" loading={creatingTask} onClick={createTask} disabled={!newTaskTitle.trim()}>
            Add
          </Button>
        </div>
        {loadingTasks && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingTasks && (!tasks || tasks.filter((t) => t.state !== "completed").length === 0) && (
          <EmptyState title="No open tasks" description="Tasks you add or sync from Apple Reminders show up here." />
        )}
        {tasks && tasks.filter((t) => t.state !== "completed").length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {tasks
              .filter((t) => t.state !== "completed")
              .map((t) => {
                const due = formatTemporal(t.dueCondition);
                return (
                  <div key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-primary">{t.title}</p>
                      <div className="flex items-center gap-2 text-xs text-tertiary">
                        {due && <span>Due {due}</span>}
                        {t.recurrenceRule && <Badge tone="neutral">repeats</Badge>}
                        {t.externalSyncProvider && <Badge tone="neutral">Reminders</Badge>}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => completeTask(t.id)}>
                        Done
                      </Button>
                      {!t.externalSyncProvider && (
                        <Button size="sm" variant="ghost" onClick={() => deleteTask(t.id)}>
                          Delete
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </Section>

      <Section title="Appointments">
        {loadingEvents && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingEvents && (!events || events.length === 0) && (
          <EmptyState title="No upcoming appointments" description="Appointments and events discovered from email or a connected calendar will show up here." />
        )}
        {events && events.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {events.map((e) => {
              const when = formatTemporal(e.start);
              return (
                <Link key={e.id} href={`/life/events/${e.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-subtle">
                  <div>
                    <p className="text-sm font-medium text-primary">{e.title}</p>
                    {e.location && <p className="text-xs text-tertiary">{e.location}</p>}
                  </div>
                  {when && <p className="text-sm text-tertiary">{when}</p>}
                </Link>
              );
            })}
          </div>
        )}
      </Section>

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
                <Link key={r.returnCase.id} href={`/life/returns/${r.returnCase.id}`}>
                  <Card className="transition-colors hover:bg-subtle">
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
                </Link>
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
                <Link
                  key={s.subscription.id}
                  href={`/life/subscriptions/${s.subscription.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-subtle"
                >
                  <div>
                    <p className="text-sm font-medium text-primary">{s.stream.serviceLabel}</p>
                    <p className="text-xs text-tertiary capitalize">{s.stream.cadence}</p>
                  </div>
                  <div className="text-right">
                    {amount && <p className="text-sm font-medium text-primary">{amount}</p>}
                    {s.subscription.state === "price_changed" && <Badge tone="warning">Price changed</Badge>}
                  </div>
                </Link>
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
                <Link key={b.bill.id} href={`/life/bills/${b.bill.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-subtle">
                  <div>
                    <p className="text-sm font-medium text-primary">{b.bill.billerLabel}</p>
                    {due && <p className="text-xs text-tertiary">Due {due}</p>}
                  </div>
                  {amount && <p className="text-sm font-medium text-primary">{amount}</p>}
                </Link>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Warranties">
        {loadingWarranties && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingWarranties && (!warranties || warranties.length === 0) && (
          <EmptyState title="No warranties tracked yet" description="Warranties found in email will show up here with their expiration date." />
        )}
        {warranties && warranties.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {warranties.map((w) => {
              const days = daysUntil(w.expirationDate);
              const expires = formatTemporal(w.expirationDate);
              return (
                <Link key={w.id} href={`/life/warranties/${w.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-subtle">
                  <div>
                    <p className="text-sm font-medium text-primary">{w.productLabel}</p>
                    {expires && <p className="text-xs text-tertiary">Expires {expires}</p>}
                  </div>
                  {days != null && (
                    <Badge tone={days <= 30 ? "warning" : "neutral"}>{days > 0 ? `${days}d left` : "Expired"}</Badge>
                  )}
                </Link>
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
                <Link key={p.id} href={`/life/purchases/${p.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-subtle">
                  <div>
                    <p className="text-sm font-medium text-primary">
                      {p.merchantName ?? `Order ${p.orderNumber ?? "—"}`}
                    </p>
                    <p className="text-xs text-tertiary">
                      {p.merchantName && p.orderNumber ? `Order ${p.orderNumber}` : null}
                      {p.merchantName && p.orderNumber && date ? " · " : null}
                      {date}
                    </p>
                  </div>
                  {total && <p className="text-sm font-medium text-primary">{total}</p>}
                </Link>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
