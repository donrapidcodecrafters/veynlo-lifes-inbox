import { useCallback, useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { TextField } from "@/components/text-field";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

interface EventRow {
  id: string;
  title: string;
  start: TemporalValueLike;
  isAllDay: boolean;
  location: string | null;
}

interface Purchase {
  id: string;
  orderNumber: string | null;
  purchaseDate: TemporalValueLike;
  totalMinorUnits: number | null;
  totalCurrency: string | null;
  merchantName: string | null;
}

interface ReturnRow {
  returnCase: {
    id: string;
    deadline: TemporalValueLike;
    valueAtStakeMinorUnits: number | null;
    valueAtStakeCurrency: string | null;
  };
  purchase: { orderNumber: string | null };
}

interface SubscriptionRow {
  subscription: { id: string; state: string };
  stream: { serviceLabel: string; typicalAmountMinorUnits: number | null; typicalAmountCurrency: string | null; cadence: string };
}

interface BillRow {
  bill: { id: string; billerLabel: string; amountDueMinorUnits: number | null; amountDueCurrency: string | null; dueDate: TemporalValueLike };
}

interface Warranty {
  id: string;
  productLabel: string;
  expirationDate: TemporalValueLike;
  registrationConfirmed: boolean | null;
}

interface Shipment {
  id: string;
  carrier: string;
  trackingNumber: string;
  status: string;
  estimatedDelivery: TemporalValueLike | null;
  merchantName: string | null;
}

const SHIPMENT_STATUS_TONE: Record<string, "neutral" | "warning" | "positive"> = {
  label_created: "neutral",
  in_transit: "warning",
  out_for_delivery: "warning",
  delivered: "positive",
  exception: "warning",
};

interface TaskRow {
  id: string;
  title: string;
  dueCondition: TemporalValueLike | null;
  state: string;
  recurrenceRule: string | null;
  externalSyncProvider: string | null;
}

interface ScheduleConflict {
  id: string;
  involvedEventIds: string[];
  resolvedAt: string | null;
}

function SectionHeading({ title }: { title: string }) {
  const { theme } = useAppTheme();
  return (
    <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase", letterSpacing: 0.4 }}>
      {title}
    </Text>
  );
}

export default function LifeScreen() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [returns, setReturns] = useState<ReturnRow[] | null>(null);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[] | null>(null);
  const [bills, setBills] = useState<BillRow[] | null>(null);
  const [warranties, setWarranties] = useState<Warranty[] | null>(null);
  const [shipments, setShipments] = useState<Shipment[] | null>(null);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [conflicts, setConflicts] = useState<ScheduleConflict[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [creatingTask, setCreatingTask] = useState(false);

  const load = useCallback(async () => {
    const [ev, p, r, s, b, w, sh, t, c] = await Promise.all([
      api.get<EventRow[]>("/v1/events"),
      api.get<Purchase[]>("/v1/purchases"),
      api.get<ReturnRow[]>("/v1/returns"),
      api.get<SubscriptionRow[]>("/v1/subscriptions"),
      api.get<BillRow[]>("/v1/bills"),
      api.get<Warranty[]>("/v1/warranties"),
      api.get<Shipment[]>("/v1/shipments"),
      api.get<TaskRow[]>("/v1/tasks"),
      api.get<ScheduleConflict[]>("/v1/schedule/conflicts").catch(() => []),
    ]);
    setEvents(ev);
    setPurchases(p);
    setReturns(r);
    setSubscriptions(s);
    setBills(b);
    setWarranties(w);
    setShipments(sh);
    setTasks(t.filter((task) => task.state !== "completed" && task.state !== "dismissed"));
    setConflicts(c);
  }, []);

  async function completeTask(id: string) {
    setCompletingTaskId(id);
    try {
      await api.post(`/v1/tasks/${id}/complete`);
      setTasks((prev) => prev?.filter((t) => t.id !== id) ?? null);
    } finally {
      setCompletingTaskId(null);
    }
  }

  async function createTask() {
    if (!newTaskTitle.trim()) return;
    setCreatingTask(true);
    try {
      await api.post("/v1/tasks", { title: newTaskTitle });
      setNewTaskTitle("");
      await load();
    } finally {
      setCreatingTask(false);
    }
  }

  async function deleteTask(id: string) {
    await api.delete(`/v1/tasks/${id}`);
    setTasks((prev) => prev?.filter((t) => t.id !== id) ?? null);
  }

  const openConflicts = conflicts.filter((c) => !c.resolvedAt);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <ScreenHeader title="Life" subtitle="Everything Veynlo knows you own, owe, and are due back." />

      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => router.push("/timeline")}>
            Timeline
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => router.push("/documents")}>
            Documents
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => router.push("/people")}>
            People
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => router.push("/saved")}>
            Saved
          </Button>
        </View>
      </View>

      {openConflicts.length > 0 && (
        <Card style={{ backgroundColor: theme.colors.warningSubtleBg }}>
          <Text style={{ fontSize: 13, color: theme.colors.warningSubtleText }}>
            {openConflicts.length} scheduling conflict{openConflicts.length > 1 ? "s" : ""} — two of your events overlap in time.
          </Text>
        </Card>
      )}

      <View style={{ gap: 8 }}>
        <SectionHeading title="Appointments" />
        {!events && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}
        {events?.length === 0 && (
          <EmptyState title="No upcoming appointments" description="Appointments and events discovered from email or a connected calendar will show up here." />
        )}
        {events && events.length > 0 && (
          <Card style={{ padding: 0 }}>
            {events.map((e, i) => {
              const when = formatTemporal(e.start);
              return (
                <Pressable
                  key={e.id}
                  onPress={() => router.push(`/event/${e.id}`)}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: theme.colors.borderSubtle,
                  }}
                >
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{e.title}</Text>
                    {e.location && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{e.location}</Text>}
                  </View>
                  {when && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{when}</Text>}
                </Pressable>
              );
            })}
          </Card>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <SectionHeading title="Reminders" />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <TextField label="New task" placeholder="Add a task…" value={newTaskTitle} onChangeText={setNewTaskTitle} onSubmitEditing={createTask} returnKeyType="done" />
          </View>
          <Button onPress={createTask} loading={creatingTask} disabled={!newTaskTitle.trim()}>
            Add
          </Button>
        </View>
        {!tasks && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}
        {tasks?.length === 0 && (
          <EmptyState title="No open reminders" description="Sync your Reminders app from Connections, or tasks discovered elsewhere will show up here." />
        )}
        {tasks && tasks.length > 0 && (
          <Card style={{ padding: 0 }}>
            {tasks.map((t, i) => {
              const when = t.dueCondition ? formatTemporal(t.dueCondition) : null;
              return (
                <View
                  key={t.id}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: theme.colors.borderSubtle,
                    gap: 12,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{t.title}</Text>
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      {when && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{when}</Text>}
                      {t.recurrenceRule && <Badge tone="neutral">repeats</Badge>}
                      {t.externalSyncProvider && <Badge tone="neutral">Reminders</Badge>}
                    </View>
                  </View>
                  <Button variant="secondary" onPress={() => completeTask(t.id)} loading={completingTaskId === t.id}>
                    Done
                  </Button>
                  {!t.externalSyncProvider && (
                    <Button variant="ghost" onPress={() => deleteTask(t.id)}>
                      Delete
                    </Button>
                  )}
                </View>
              );
            })}
          </Card>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <SectionHeading title="Returns" />
        {!returns && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}
        {returns?.length === 0 && (
          <EmptyState title="No open returns" description="When a return window is closing, it'll show up here with the deadline and value at stake." />
        )}
        {returns && returns.length > 0 && (
          <View style={{ gap: 8 }}>
            {returns.map((r) => {
              const days = daysUntil(r.returnCase.deadline);
              const value = formatMoneyMinorUnits(r.returnCase.valueAtStakeMinorUnits, r.returnCase.valueAtStakeCurrency);
              return (
                <Pressable key={r.returnCase.id} onPress={() => router.push(`/return-case/${r.returnCase.id}`)}>
                  <Card style={{ gap: 6 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
                        Order {r.purchase.orderNumber ?? "—"}
                      </Text>
                      {days != null && <Badge tone={days <= 3 ? "critical" : "warning"}>{days > 0 ? `${days}d left` : "Due today"}</Badge>}
                    </View>
                    {value && <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>{value}</Text>}
                  </Card>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <SectionHeading title="Subscriptions" />
        {!subscriptions && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}
        {subscriptions?.length === 0 && (
          <EmptyState title="No subscriptions detected yet" description="Connect email and Veynlo will find recurring charges automatically." />
        )}
        {subscriptions && subscriptions.length > 0 && (
          <Card style={{ padding: 0 }}>
            {subscriptions.map((s, i) => {
              const amount = formatMoneyMinorUnits(s.stream.typicalAmountMinorUnits, s.stream.typicalAmountCurrency);
              return (
                <Pressable
                  key={s.subscription.id}
                  onPress={() => router.push(`/subscription/${s.subscription.id}`)}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: theme.colors.borderSubtle,
                  }}
                >
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{s.stream.serviceLabel}</Text>
                    <Text style={{ fontSize: 12, color: theme.colors.textTertiary, textTransform: "capitalize" }}>{s.stream.cadence}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    {amount && <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{amount}</Text>}
                    {s.subscription.state === "price_changed" && <Badge tone="warning">Price changed</Badge>}
                  </View>
                </Pressable>
              );
            })}
          </Card>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <SectionHeading title="Bills" />
        {!bills && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}
        {bills?.length === 0 && (
          <EmptyState title="No bills detected yet" description="Bills discovered from email or connected accounts will appear here with due dates." />
        )}
        {bills && bills.length > 0 && (
          <Card style={{ padding: 0 }}>
            {bills.map((b, i) => {
              const due = formatTemporal(b.bill.dueDate);
              const amount = formatMoneyMinorUnits(b.bill.amountDueMinorUnits, b.bill.amountDueCurrency);
              return (
                <Pressable
                  key={b.bill.id}
                  onPress={() => router.push(`/bill/${b.bill.id}`)}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: theme.colors.borderSubtle,
                  }}
                >
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{b.bill.billerLabel}</Text>
                    {due && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Due {due}</Text>}
                  </View>
                  {amount && <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{amount}</Text>}
                </Pressable>
              );
            })}
          </Card>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <SectionHeading title="Warranties" />
        {!warranties && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}
        {warranties?.length === 0 && (
          <EmptyState title="No warranties tracked yet" description="Warranties found in email will show up here with their expiration date." />
        )}
        {warranties && warranties.length > 0 && (
          <Card style={{ padding: 0 }}>
            {warranties.map((w, i) => {
              const days = daysUntil(w.expirationDate);
              const expires = formatTemporal(w.expirationDate);
              return (
                <Pressable
                  key={w.id}
                  onPress={() => router.push(`/warranty/${w.id}`)}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: theme.colors.borderSubtle,
                  }}
                >
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{w.productLabel}</Text>
                    {expires && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Expires {expires}</Text>}
                  </View>
                  {days != null && <Badge tone={days <= 30 ? "warning" : "neutral"}>{days > 0 ? `${days}d left` : "Expired"}</Badge>}
                </Pressable>
              );
            })}
          </Card>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <SectionHeading title="Shipments" />
        {!shipments && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}
        {shipments?.length === 0 && (
          <EmptyState title="No shipments tracked yet" description="Shipping confirmations found in email will show up here with carrier and status." />
        )}
        {shipments && shipments.length > 0 && (
          <Card style={{ padding: 0 }}>
            {shipments.map((s, i) => {
              const estimated = formatTemporal(s.estimatedDelivery);
              return (
                <Pressable
                  key={s.id}
                  onPress={() => router.push(`/shipment/${s.id}`)}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: theme.colors.borderSubtle,
                  }}
                >
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{s.merchantName ?? s.carrier}</Text>
                    <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                      {s.carrier} · {s.trackingNumber}
                      {estimated ? ` · Est. ${estimated}` : ""}
                    </Text>
                  </View>
                  <Badge tone={SHIPMENT_STATUS_TONE[s.status] ?? "neutral"}>{s.status.replace(/_/g, " ")}</Badge>
                </Pressable>
              );
            })}
          </Card>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <SectionHeading title="Purchases" />
        {!purchases && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}
        {purchases?.length === 0 && (
          <EmptyState title="No purchases yet" description="Connect email or scan a receipt and Veynlo will organize your purchases automatically." />
        )}
        {purchases && purchases.length > 0 && (
          <Card style={{ padding: 0 }}>
            {purchases.map((p, i) => {
              const date = formatTemporal(p.purchaseDate);
              const total = formatMoneyMinorUnits(p.totalMinorUnits, p.totalCurrency);
              return (
                <Pressable
                  key={p.id}
                  onPress={() => router.push(`/purchase/${p.id}`)}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: theme.colors.borderSubtle,
                  }}
                >
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
                      {p.merchantName ?? `Order ${p.orderNumber ?? "—"}`}
                    </Text>
                    <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                      {p.merchantName && p.orderNumber ? `Order ${p.orderNumber}` : ""}
                      {p.merchantName && p.orderNumber && date ? " · " : ""}
                      {date}
                    </Text>
                  </View>
                  {total && <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{total}</Text>}
                </Pressable>
              );
            })}
          </Card>
        )}
      </View>
    </Screen>
  );
}
