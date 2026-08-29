import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { ActionMenu } from "@/components/action-menu";
import { EmptyState } from "@/components/empty-state";
import { TextField } from "@/components/text-field";

interface InboxItem {
  id: string;
  category: string;
  summary: string;
  confidenceBand: string;
  reviewState: string;
  autoFiled: boolean;
  linkedResourceType: string | null;
}

interface SourceInspection {
  kind: string;
  subjectLine: string | null;
  snippet: string | null;
  fromAddress: string | null;
  occurredAt: string;
}

type FilterTab = "needs_review" | "auto_filed" | "low_confidence" | "duplicates" | "all";

const FILTER_TABS: Array<{ value: FilterTab; label: string }> = [
  { value: "needs_review", label: "Needs Review" },
  { value: "auto_filed", label: "Auto-filed" },
  { value: "low_confidence", label: "Low Confidence" },
  { value: "duplicates", label: "Duplicates" },
  { value: "all", label: "All" },
];

const CATEGORIES = ["purchase", "shipment", "bill", "subscription", "appointment", "warranty", "task"];

function queryFor(filter: FilterTab, category: string): string {
  const params = new URLSearchParams();
  if (filter === "needs_review") params.set("reviewState", "new");
  if (filter === "auto_filed") params.set("autoFiled", "true");
  // "approximate" is the actual lowest confidence band — see the identical fix/comment on web's Inbox page.
  if (filter === "low_confidence") params.set("confidenceBand", "approximate");
  if (filter === "duplicates") params.set("isDuplicate", "true");
  if (category) params.set("category", category);
  const qs = params.toString();
  return qs ? `/v1/inbox?${qs}` : "/v1/inbox";
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
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [rulePickerId, setRulePickerId] = useState<string | null>(null);
  const [ruleCategory, setRuleCategory] = useState(CATEGORIES[0]);
  const [capturing, setCapturing] = useState(false);
  const [filter, setFilter] = useState<FilterTab>("needs_review");
  const [category, setCategory] = useState("");
  const [pasting, setPasting] = useState(false);
  const [pasteMessage, setPasteMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.get<InboxItem[]>(queryFor(filter, category));
    setItems(res);
  }, [filter, category]);

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

  async function blockSender(id: string) {
    await api.post(`/v1/inbox/${id}/block-sender`);
    load();
  }

  /** MAIL-006 "always treat messages from this sender as X" — same missing-UI fix as web's Inbox page. */
  async function createSenderRule(id: string) {
    await api.post(`/v1/inbox/${id}/sender-rule`, { category: ruleCategory });
    setRulePickerId(null);
    load();
  }

  /** §CAP-008 "Clipboard Quick Capture" — same one-tap paste-and-file flow as the web Inbox page. */
  async function quickPasteCapture() {
    setPasting(true);
    setPasteMessage(null);
    try {
      const text = await Clipboard.getStringAsync();
      if (!text.trim()) {
        setPasteMessage("Your clipboard is empty.");
        return;
      }
      const isUrl = /^https?:\/\/\S+$/i.test(text.trim());
      if (isUrl) {
        await api.post("/v1/ingestion/url", { url: text.trim() });
      } else {
        const firstLine = text.trim().split("\n")[0]?.slice(0, 500) || "Pasted note";
        await api.post("/v1/ingestion/manual", { subject: firstLine, bodyText: text });
      }
      setPasteMessage("Captured from clipboard.");
      load();
    } catch {
      setPasteMessage("Couldn't read your clipboard. Please try again.");
    } finally {
      setPasting(false);
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>Inbox</Text>
          <Text style={{ fontSize: 14, color: theme.colors.textTertiary, marginTop: 2 }}>Newly discovered information to review.</Text>
        </View>
        <View style={{ gap: 6, alignItems: "flex-end" }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button variant="ghost" onPress={quickPasteCapture} loading={pasting}>
              Paste
            </Button>
            <Button variant="secondary" onPress={() => setCapturing((v) => !v)}>
              {capturing ? "Cancel" : "Add manually"}
            </Button>
          </View>
        </View>
      </View>

      {pasteMessage && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{pasteMessage}</Text>}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {FILTER_TABS.map((f) => {
          const active = filter === f.value;
          return (
            <Pressable
              key={f.value}
              onPress={() => setFilter(f.value)}
              style={{
                paddingVertical: 6,
                paddingHorizontal: 12,
                borderRadius: theme.radius.sm,
                backgroundColor: active ? theme.colors.bgSurface : theme.colors.bgSubtle,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary }}>{f.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        <Pressable
          onPress={() => setCategory("")}
          style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: theme.radius.sm, backgroundColor: category === "" ? theme.colors.bgSurface : "transparent", borderWidth: 1, borderColor: theme.colors.borderSubtle }}
        >
          <Text style={{ fontSize: 12, color: category === "" ? theme.colors.textPrimary : theme.colors.textTertiary }}>All categories</Text>
        </Pressable>
        {CATEGORIES.map((c) => (
          <Pressable
            key={c}
            onPress={() => setCategory(c)}
            style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: theme.radius.sm, backgroundColor: category === c ? theme.colors.bgSurface : "transparent", borderWidth: 1, borderColor: theme.colors.borderSubtle }}
          >
            <Text style={{ fontSize: 12, color: category === c ? theme.colors.textPrimary : theme.colors.textTertiary }}>{c.replace("_", " ")}</Text>
          </Pressable>
        ))}
      </ScrollView>

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
                    {item.autoFiled && <Badge tone="neutral">auto-filed</Badge>}
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
                    <ActionMenu
                      items={[
                        { label: "Snooze 1 week", onSelect: () => snooze(item.id) },
                        { label: "Archive", onSelect: () => act(item.id, "archive") },
                        { label: "Dismiss", onSelect: () => act(item.id, "dismiss") },
                        { label: "Inspect source", onSelect: () => setInspectingId(inspectingId === item.id ? null : item.id) },
                        { label: "Block sender", onSelect: () => blockSender(item.id), tone: "critical" },
                        { label: "Create rule", onSelect: () => setRulePickerId(rulePickerId === item.id ? null : item.id) },
                      ]}
                    />
                  </View>
                )}
                {rulePickerId === item.id && (
                  <View style={{ gap: 8, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md, padding: 10 }}>
                    <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>Always file messages from this sender as:</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                      {CATEGORIES.map((c) => {
                        const active = ruleCategory === c;
                        return (
                          <Pressable
                            key={c}
                            onPress={() => setRuleCategory(c)}
                            style={{
                              paddingVertical: 6,
                              paddingHorizontal: 10,
                              borderRadius: theme.radius.full,
                              backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSurface,
                            }}
                          >
                            <Text style={{ fontSize: 12, fontWeight: "600", color: active ? theme.colors.textOnBrand : theme.colors.textSecondary }}>
                              {c.replace("_", " ")}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <View style={{ flex: 1 }}>
                        <Button onPress={() => createSenderRule(item.id)}>Save rule</Button>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Button variant="ghost" onPress={() => setRulePickerId(null)}>
                          Cancel
                        </Button>
                      </View>
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
                {inspectingId === item.id && <SourceInspectionPanel itemId={item.id} />}
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
  const [mode, setMode] = useState<"text" | "url">("text");
  const [subject, setSubject] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "url") {
        await api.post("/v1/ingestion/url", { url });
      } else {
        await api.post("/v1/ingestion/manual", { subject, bodyText, fromAddress: fromAddress || undefined });
      }
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
      <View style={{ flexDirection: "row", gap: 6, padding: 4, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md }}>
        {(["text", "url"] as const).map((m) => {
          const active = mode === m;
          return (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              style={{
                flex: 1,
                paddingVertical: 8,
                borderRadius: theme.radius.sm,
                backgroundColor: active ? theme.colors.bgSurface : "transparent",
                alignItems: "center",
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary }}>
                {m === "text" ? "Paste text" : "From a URL"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {mode === "text" ? (
        <>
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
        </>
      ) : (
        <>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            Paste a link to a confirmation page, event listing, or anything else worth remembering.
          </Text>
          <TextField
            label="URL"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            keyboardType="url"
            placeholder="https://example.com/order/12345"
          />
        </>
      )}

      {error && <Text style={{ color: theme.colors.critical, fontSize: 13 }}>{error}</Text>}
      <Button onPress={onSubmit} loading={submitting} disabled={mode === "text" ? !subject || !bodyText : !url}>
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

/** INB-001 "inspect source" — mirrors the web Inbox page's identical panel. */
function SourceInspectionPanel({ itemId }: { itemId: string }) {
  const { theme } = useAppTheme();
  const [source, setSource] = useState<SourceInspection | "loading" | "error">("loading");

  useEffect(() => {
    api
      .get<SourceInspection>(`/v1/inbox/${itemId}/source`)
      .then(setSource)
      .catch(() => setSource("error"));
  }, [itemId]);

  return (
    <View style={{ gap: 4, borderRadius: theme.radius.md, backgroundColor: theme.colors.bgSubtle, padding: 12 }}>
      {source === "loading" && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Loading…</Text>}
      {source === "error" && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>The original source is no longer available.</Text>}
      {source !== "loading" && source !== "error" && (
        <>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            <Text style={{ fontWeight: "600", color: theme.colors.textPrimary }}>From: </Text>
            {source.fromAddress ?? "Unknown"}
          </Text>
          {source.subjectLine && (
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
              <Text style={{ fontWeight: "600", color: theme.colors.textPrimary }}>Subject: </Text>
              {source.subjectLine}
            </Text>
          )}
          {source.snippet && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{source.snippet}</Text>}
          <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>Received {new Date(source.occurredAt).toLocaleString()}</Text>
        </>
      )}
    </View>
  );
}
