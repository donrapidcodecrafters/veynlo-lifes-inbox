import { useCallback, useState } from "react";
import { RefreshControl, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { TextField } from "@/components/text-field";

interface InboxItem {
  id: string;
  category: string;
  summary: string;
  confidenceBand: string;
  reviewState: string;
  linkedResourceType: string | null;
}

const CONFIDENCE_TONE: Record<string, "positive" | "warning" | "critical" | "neutral"> = {
  verified: "positive",
  high: "positive",
  needs_review: "warning",
  conflicting: "critical",
  approximate: "neutral",
};

interface CorrectionField {
  key: string;
  label: string;
  numeric?: boolean;
}

// One entry per linkedResourceType InboxService.correct() knows how to handle — keep in sync with
// services/api/src/modules/attention/dto.ts and the web Inbox page's identical table.
const CORRECTION_FIELDS: Record<string, CorrectionField[]> = {
  purchase: [
    { key: "orderNumber", label: "Order number" },
    { key: "totalMinorUnits", label: "Total (in cents)", numeric: true },
    { key: "totalCurrency", label: "Currency (e.g. USD)" },
    { key: "purchaseDateIso", label: "Purchase date (YYYY-MM-DD)" },
  ],
  bill: [
    { key: "billerLabel", label: "Biller name" },
    { key: "amountDueMinorUnits", label: "Amount due (in cents)", numeric: true },
    { key: "amountDueCurrency", label: "Currency (e.g. USD)" },
    { key: "dueDateIso", label: "Due date (YYYY-MM-DD)" },
  ],
  calendar_event: [
    { key: "title", label: "Title" },
    { key: "location", label: "Location" },
    { key: "startIso", label: "Start time (YYYY-MM-DDTHH:MM, UTC)" },
  ],
  shipment: [
    { key: "carrier", label: "Carrier" },
    { key: "trackingNumber", label: "Tracking number" },
    { key: "status", label: "Status" },
  ],
  warranty: [
    { key: "productLabel", label: "Product" },
    { key: "warrantyLengthMonths", label: "Warranty length (months)", numeric: true },
    { key: "expirationDateIso", label: "Expiration date (YYYY-MM-DD)" },
  ],
  subscription: [
    { key: "serviceLabel", label: "Service name" },
    { key: "typicalAmountMinorUnits", label: "Amount (in cents)", numeric: true },
    { key: "typicalAmountCurrency", label: "Currency (e.g. USD)" },
  ],
};

export default function InboxScreen() {
  const { theme } = useAppTheme();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<InboxItem[]>("/v1/inbox?reviewState=new");
    setItems(res);
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

  async function act(id: string, action: "confirm" | "archive" | "dismiss") {
    await api.post(`/v1/inbox/${id}/${action}`);
    load();
  }

  async function snooze(id: string) {
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await api.post(`/v1/inbox/${id}/snooze`, { until });
    load();
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>Inbox</Text>
          <Text style={{ fontSize: 14, color: theme.colors.textTertiary, marginTop: 2 }}>Newly discovered information to review.</Text>
        </View>
        <Button variant="secondary" onPress={() => setCapturing((v) => !v)}>
          {capturing ? "Cancel" : "Add manually"}
        </Button>
      </View>

      {capturing && (
        <Card style={{ gap: 12 }}>
          <CaptureForm
            onDone={() => {
              setCapturing(false);
              load();
            }}
          />
        </Card>
      )}

      {items?.length === 0 && (
        <EmptyState
          title="You're caught up."
          description="New receipts, bills, appointments, and other discoveries will show up here for a quick review."
        />
      )}

      {items && items.length > 0 && (
        <View style={{ gap: 12 }}>
          {items.map((item) => {
            const fields = item.linkedResourceType ? CORRECTION_FIELDS[item.linkedResourceType] : undefined;
            const isCorrecting = correctingId === item.id;
            return (
              <Card key={item.id} style={{ gap: 12 }}>
                <View style={{ gap: 6 }}>
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    <Badge>{item.category}</Badge>
                    <Badge tone={CONFIDENCE_TONE[item.confidenceBand] ?? "neutral"}>{item.confidenceBand.replace("_", " ")}</Badge>
                  </View>
                  <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{item.summary}</Text>
                </View>
                {!isCorrecting && (
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    <View style={{ flex: 1, minWidth: 90 }}>
                      <Button onPress={() => act(item.id, "confirm")}>Confirm</Button>
                    </View>
                    {fields && (
                      <View style={{ flex: 1, minWidth: 90 }}>
                        <Button variant="secondary" onPress={() => setCorrectingId(item.id)}>
                          Correct
                        </Button>
                      </View>
                    )}
                    <View style={{ flex: 1, minWidth: 90 }}>
                      <Button variant="secondary" onPress={() => snooze(item.id)}>
                        Snooze 1w
                      </Button>
                    </View>
                    <View style={{ flex: 1, minWidth: 90 }}>
                      <Button variant="secondary" onPress={() => act(item.id, "archive")}>
                        Archive
                      </Button>
                    </View>
                    <View style={{ flex: 1, minWidth: 90 }}>
                      <Button variant="ghost" onPress={() => act(item.id, "dismiss")}>
                        Dismiss
                      </Button>
                    </View>
                  </View>
                )}
                {isCorrecting && fields && (
                  <CorrectionForm
                    itemId={item.id}
                    fields={fields}
                    onDone={() => {
                      setCorrectingId(null);
                      load();
                    }}
                    onCancel={() => setCorrectingId(null)}
                  />
                )}
              </Card>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

/** Mirrors the web Inbox page's identical form — pastes a receipt/bill/confirmation email's text through the same pipeline a real connected inbox uses. */
function CaptureForm({ onDone }: { onDone: () => void }) {
  const { theme } = useAppTheme();
  const [subject, setSubject] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/ingestion/manual", { subject, bodyText, fromAddress: fromAddress || undefined });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <View style={{ gap: 10 }}>
        <Text style={{ fontSize: 15, color: theme.colors.textPrimary }}>
          Submitted. If Veynlo finds something worth reviewing in it, a card will appear here shortly.
        </Text>
        <Button onPress={onDone}>Done</Button>
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
        Paste the text of a receipt, bill, confirmation, or other email — or just describe what happened.
      </Text>
      <TextField label="Subject" value={subject} onChangeText={setSubject} />
      <TextField label="From (optional)" value={fromAddress} onChangeText={setFromAddress} autoCapitalize="none" keyboardType="email-address" />
      <TextField
        label="Content"
        value={bodyText}
        onChangeText={setBodyText}
        multiline
        numberOfLines={6}
        style={{ height: 140, paddingTop: 12, textAlignVertical: "top" }}
      />
      {error && <Text style={{ color: theme.colors.critical, fontSize: 13 }}>{error}</Text>}
      <Button onPress={onSubmit} loading={submitting} disabled={!subject || !bodyText}>
        Submit
      </Button>
    </View>
  );
}

function CorrectionForm({
  itemId,
  fields,
  onDone,
  onCancel,
}: {
  itemId: string;
  fields: CorrectionField[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { theme } = useAppTheme();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSave() {
    setSubmitting(true);
    setError(null);
    try {
      const patch: Record<string, string | number> = {};
      for (const field of fields) {
        const raw = values[field.key];
        if (!raw) continue; // blank means "leave unchanged" — only send fields the user actually filled in
        patch[field.key] = field.numeric ? Number(raw) : raw;
      }
      if (Object.keys(patch).length === 0) {
        setError("Enter at least one corrected value, or Cancel.");
        setSubmitting(false);
        return;
      }
      await api.post(`/v1/inbox/${itemId}/correct`, patch);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  }

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
        Only fill in the fields that are wrong — everything else stays as extracted.
      </Text>
      {fields.map((field) => (
        <TextField
          key={field.key}
          label={field.label}
          value={values[field.key] ?? ""}
          onChangeText={(text) => setValues((v) => ({ ...v, [field.key]: text }))}
          keyboardType={field.numeric ? "numeric" : "default"}
          autoCapitalize="none"
        />
      ))}
      {error && <Text style={{ color: theme.colors.critical, fontSize: 13 }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={onSave} loading={submitting}>
            Save correction
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
        </View>
      </View>
    </View>
  );
}
