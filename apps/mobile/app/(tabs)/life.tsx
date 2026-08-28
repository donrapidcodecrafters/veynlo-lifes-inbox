import { useCallback, useState } from "react";
import { RefreshControl, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

interface Purchase {
  id: string;
  orderNumber: string | null;
  purchaseDate: TemporalValueLike;
  totalMinorUnits: number | null;
  totalCurrency: string | null;
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
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [returns, setReturns] = useState<ReturnRow[] | null>(null);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[] | null>(null);
  const [bills, setBills] = useState<BillRow[] | null>(null);
  const [warranties, setWarranties] = useState<Warranty[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [p, r, s, b, w] = await Promise.all([
      api.get<Purchase[]>("/v1/purchases"),
      api.get<ReturnRow[]>("/v1/returns"),
      api.get<SubscriptionRow[]>("/v1/subscriptions"),
      api.get<BillRow[]>("/v1/bills"),
      api.get<Warranty[]>("/v1/warranties"),
    ]);
    setPurchases(p);
    setReturns(r);
    setSubscriptions(s);
    setBills(b);
    setWarranties(w);
  }, []);

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
                <Card key={r.returnCase.id} style={{ gap: 6 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
                      Order {r.purchase.orderNumber ?? "—"}
                    </Text>
                    {days != null && <Badge tone={days <= 3 ? "critical" : "warning"}>{days > 0 ? `${days}d left` : "Due today"}</Badge>}
                  </View>
                  {value && <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>{value}</Text>}
                </Card>
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
                <View
                  key={s.subscription.id}
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
                </View>
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
                <View
                  key={b.bill.id}
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
                </View>
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
                <View
                  key={w.id}
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
                </View>
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
                <View
                  key={p.id}
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
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Order {p.orderNumber ?? "—"}</Text>
                    {date && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{date}</Text>}
                  </View>
                  {total && <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{total}</Text>}
                </View>
              );
            })}
          </Card>
        )}
      </View>
    </Screen>
  );
}
