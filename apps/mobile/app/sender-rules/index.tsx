import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Card } from "@/components/card";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { EmptyState } from "@/components/empty-state";

type SenderRuleAction = "always_school" | "always_bills" | "ignore" | "attachments_only" | "household_shared";

interface SenderRule {
  id: string;
  senderDomain: string | null;
  senderEmail: string | null;
  action: SenderRuleAction;
  createdAt: string;
}

const ACTION_OPTIONS: SenderRuleAction[] = ["always_school", "always_bills", "ignore", "attachments_only", "household_shared"];
const ACTION_LABEL: Record<SenderRuleAction, string> = {
  always_school: "School",
  always_bills: "Bills",
  ignore: "Ignore",
  attachments_only: "Attachments only",
  household_shared: "Household shared",
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * MAIL-006 "User sender rules" — mirrors apps/web's /settings/sender-rules page. Standalone list/add/remove
 * view for `senderRules`, independent of any specific Inbox item (the item-level "Always treat mail from
 * this sender as..." action lives on the correction form itself in the Inbox tab — see
 * InboxService.addSenderRuleFromInboxItem).
 */
export default function SenderRulesScreen() {
  const { theme } = useAppTheme();
  const [rules, setRules] = useState<SenderRule[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sender, setSender] = useState("");
  const [action, setAction] = useState<SenderRuleAction>("always_bills");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .get<SenderRule[]>("/v1/inbox/sender-rules")
      .then(setRules)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Couldn't load your sender rules. Please try again."));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addRule() {
    setAdding(true);
    setAddError(null);
    try {
      const trimmed = sender.trim();
      const isEmail = trimmed.includes("@") && !trimmed.startsWith("@");
      await api.post("/v1/inbox/sender-rules", isEmail ? { senderEmail: trimmed, action } : { senderDomain: trimmed, action });
      setSender("");
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
      await api.delete(`/v1/inbox/sender-rules/${id}`);
      load();
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Screen>
      <ScreenHeader
        title="Sender rules"
        subtitle="Teach Veynlo once: always file a sender as School or Bills, ignore it, keep only attachments, or mark it household-shared."
      />

      <Card style={{ gap: 10 }}>
        <TextField label="Sender domain or email" placeholder="school.example.org" autoCapitalize="none" autoCorrect={false} value={sender} onChangeText={setSender} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {ACTION_OPTIONS.map((opt) => (
            <Pressable accessibilityRole="button"
              key={opt}
              onPress={() => setAction(opt)}
              style={{
                paddingVertical: 6,
                paddingHorizontal: 10,
                borderRadius: theme.radius.sm,
                borderWidth: 1,
                borderColor: action === opt ? theme.colors.brandDefault : theme.colors.borderDefault,
                backgroundColor: action === opt ? theme.colors.brandDefault : "transparent",
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: action === opt ? theme.colors.textOnBrand : theme.colors.textPrimary }}>{ACTION_LABEL[opt]}</Text>
            </Pressable>
          ))}
        </View>
        {addError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{addError}</Text>}
        <Button onPress={addRule} loading={adding} disabled={!sender.trim()}>
          Add
        </Button>
      </Card>

      {loadError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{loadError}</Text>}
      {!rules && !loadError && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Loading…</Text>}

      {rules && rules.length === 0 && (
        <EmptyState
          title="No sender rules yet"
          description="Add a rule above, or use 'Always treat mail from this sender as...' when correcting a misclassified item in your Inbox."
        />
      )}

      {rules && rules.length > 0 && (
        <View style={{ gap: 8 }}>
          {rules.map((rule) => (
            <Card key={rule.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{rule.senderDomain ?? rule.senderEmail}</Text>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary, marginTop: 2 }}>
                  {ACTION_LABEL[rule.action]} · added {formatWhen(rule.createdAt)}
                </Text>
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
