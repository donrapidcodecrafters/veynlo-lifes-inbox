import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { ScreenHeader } from "@/components/screen-header";
import { EmptyState } from "@/components/empty-state";

interface TrustedRescheduleRule {
  id: string;
  senderDomain: string;
  createdAt: string;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * CAL-004 "Offer update or auto-update only when user has an explicit trusted rule" — mirrors apps/web's
 * /settings/calendar-trust page. The standalone management view for `calendarRescheduleTrustedRules`,
 * independent of any specific offered inbox item (the item-level "Always trust reschedule emails like this
 * one" checkbox lives on the offered-change card itself in the Inbox tab — see
 * InboxService.applyRescheduleChange's `trustSender` option).
 */
export default function CalendarTrustScreen() {
  const { theme } = useAppTheme();
  const [rules, setRules] = useState<TrustedRescheduleRule[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [senderDomain, setSenderDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .get<TrustedRescheduleRule[]>("/v1/inbox/reschedule-trust-rules")
      .then(setRules)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Couldn't load your trusted senders. Please try again."));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addRule() {
    setAdding(true);
    setAddError(null);
    try {
      await api.post("/v1/inbox/reschedule-trust-rules", { senderDomain });
      setSenderDomain("");
      load();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Couldn't add that rule. Please try again.");
    } finally {
      setAdding(false);
    }
  }

  async function removeRule(id: string) {
    setRemovingId(id);
    try {
      await api.delete(`/v1/inbox/reschedule-trust-rules/${id}`);
      load();
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Screen>
      <ScreenHeader
        title="Trusted reschedule senders"
        subtitle="By default, a reschedule email offers the change for you to review instead of applying it automatically. Add a sender here to let future reschedule emails from them apply automatically."
      />

      <Card style={{ gap: 10 }}>
        <TextField label="Sender domain or email" placeholder="united.com" autoCapitalize="none" autoCorrect={false} value={senderDomain} onChangeText={setSenderDomain} />
        {addError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{addError}</Text>}
        <Button onPress={addRule} loading={adding} disabled={!senderDomain.trim()}>
          Add
        </Button>
      </Card>

      {loadError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{loadError}</Text>}
      {!rules && !loadError && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Loading…</Text>}

      {rules && rules.length === 0 && (
        <EmptyState
          title="No trusted senders yet"
          description="Every reschedule email is offered for your review until you trust a sender here, or check 'Always trust reschedule emails like this one' on an offered change in your Inbox."
        />
      )}

      {rules && rules.length > 0 && (
        <View style={{ gap: 8 }}>
          {rules.map((rule) => (
            <Card key={rule.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{rule.senderDomain}</Text>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary, marginTop: 2 }}>Trusted since {formatWhen(rule.createdAt)}</Text>
              </View>
              <View style={{ minWidth: 90 }}>
                <Button variant="secondary" loading={removingId === rule.id} onPress={() => removeRule(rule.id)}>
                  Remove
                </Button>
              </View>
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}
