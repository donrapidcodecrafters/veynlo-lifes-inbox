import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";

// Mirrors apps/web/src/app/(app)/ask/page.tsx's identical SUGGESTIONS — spec §6.1 lists "suggested
// questions" as one of Ask's persistent elements, and this was missing here entirely (mobile had no way
// to discover what Ask could do besides an empty placeholder) even though web already had it.
const SUGGESTIONS = [
  "What purchases can I still return?",
  "What bills are due this week?",
  "How much am I paying for subscriptions?",
];

interface AskResponse {
  answer: string;
  evidence: Array<{ resourceType: string; resourceId: string; text: string }>;
  insufficientEvidence: boolean;
}

interface SearchPurchase {
  id: string;
  merchantName: string | null;
  orderNumber: string | null;
  totalMinorUnits: number | null;
  totalCurrency: string | null;
  state: string;
}
interface SearchBill {
  id: string;
  billerLabel: string;
  amountDueMinorUnits: number | null;
  amountDueCurrency: string | null;
}
interface SearchDocument {
  id: string;
  title: string;
  documentType: string;
}
interface SearchEvent {
  id: string;
  title: string;
  location: string | null;
}
interface SearchWarranty {
  id: string;
  productLabel: string;
  expirationDate: { date: string | null } | null;
}
interface SearchSubscription {
  id: string;
  serviceLabel: string;
  cadence: string;
  typicalAmountMinorUnits: number | null;
  typicalAmountCurrency: string | null;
}
interface SearchShipment {
  id: string;
  carrier: string;
  trackingNumber: string;
  status: string;
}
interface SearchReturnCase {
  id: string;
  state: string;
  orderNumber: string | null;
  merchantName: string | null;
}
interface SearchTrip {
  id: string;
  label: string | null;
  destinationLabel: string | null;
  status: string;
}
interface SearchSavedMemory {
  id: string;
  title: string | null;
  category: string | null;
  sourceKind: string;
}
interface SearchPet {
  id: string;
  label: string;
  species: string | null;
  breed: string | null;
}
interface SearchHealthAppointment {
  id: string;
  providerName: string | null;
  appointmentType: string | null;
}
interface SearchResponse {
  purchases: SearchPurchase[];
  bills: SearchBill[];
  documents: SearchDocument[];
  events: SearchEvent[];
  warranties: SearchWarranty[];
  subscriptions: SearchSubscription[];
  shipments: SearchShipment[];
  returnCases: SearchReturnCase[];
  trips: SearchTrip[];
  savedMemories: SearchSavedMemory[];
  pets: SearchPet[];
  healthAppointments: SearchHealthAppointment[];
}

function money(minorUnits: number | null, currency: string | null): string {
  if (minorUnits == null) return "amount unknown";
  return `${(minorUnits / 100).toFixed(2)} ${currency ?? ""}`.trim();
}

// §ASK-001 "open source" — mirrors apps/web/src/app/(app)/ask/page.tsx's identical EVIDENCE_HREF (see its
// comment for the full story: evidence carried a resourceType/resourceId on every item, but the Sources
// list rendered as plain unlinked text on both platforms). Matches app/timeline.tsx's own KIND_ROUTE map.
const EVIDENCE_ROUTE: Record<string, (id: string) => string> = {
  purchase: (id) => `/purchase/${id}`,
  bill: (id) => `/bill/${id}`,
  calendar_event: (id) => `/event/${id}`,
  warranty: (id) => `/warranty/${id}`,
  subscription: (id) => `/subscription/${id}`,
  shipment: (id) => `/shipment/${id}`,
  return_case: (id) => `/return-case/${id}`,
  document: () => `/documents`,
  // §ASK-002 domain coverage — mirrors web's identical fix; see apps/web/src/app/(app)/ask/page.tsx's
  // EVIDENCE_HREF comment for the full story.
  trip: (id) => `/trip/${id}`,
  saved_memory: (id) => `/saved-item/${id}`,
  pet: (id) => `/pet/${id}`,
  health_appointment: () => `/life`,
};

export default function AskScreen() {
  const { theme } = useAppTheme();
  const [mode, setMode] = useState<"ask" | "search">("ask");
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  async function ask(q: string = question) {
    if (!q.trim()) return;
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await api.post<AskResponse>("/v1/ask", { question: q });
      setResult(res);
    } catch (err) {
      // Previously uncaught — an API failure (e.g. a 500) left `loading` cleared but no visible feedback
      // at all, silently stranding the user with a spinner that vanished and nothing to show for it. Every
      // other form in this app (sign-in, sign-up, inbox capture/correction, delete-account) already shows
      // an inline message on ApiError; this brings Ask in line with that.
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function runSearch() {
    if (!searchQuery.trim()) {
      setSearchResult(null);
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await api.get<SearchResponse>(`/v1/search?q=${encodeURIComponent(searchQuery)}`);
      setSearchResult(res);
    } catch (err) {
      setSearchError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSearchLoading(false);
    }
  }

  const searchTotal = searchResult
    ? searchResult.purchases.length +
      searchResult.bills.length +
      searchResult.documents.length +
      searchResult.events.length +
      searchResult.warranties.length +
      searchResult.subscriptions.length +
      searchResult.shipments.length +
      searchResult.returnCases.length +
      searchResult.trips.length +
      searchResult.savedMemories.length +
      searchResult.pets.length +
      searchResult.healthAppointments.length
    : 0;

  return (
    <Screen>
      <View>
        <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>Ask Veynlo</Text>
        <Text style={{ fontSize: 14, color: theme.colors.textTertiary, marginTop: 2 }}>
          {mode === "ask" ? "Ask about anything Veynlo knows — grounded in your own data." : "Search across your purchases, bills, documents, trips, pets, and more."}
        </Text>
      </View>

      <View style={{ flexDirection: "row", gap: 6, padding: 4, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md, alignSelf: "flex-start" }}>
        {(["ask", "search"] as const).map((m) => {
          const active = mode === m;
          return (
            <Pressable accessibilityRole="button"
              key={m}
              onPress={() => setMode(m)}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 16,
                borderRadius: theme.radius.sm,
                backgroundColor: active ? theme.colors.bgSurface : "transparent",
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary }}>
                {m === "ask" ? "Ask" : "Search"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {mode === "ask" ? (
        <>
          <View style={{ gap: 12 }}>
            <TextField label="Question" value={question} onChangeText={setQuestion} placeholder="When does my warranty expire?" onSubmitEditing={() => ask()} returnKeyType="send" />
            <Button onPress={() => ask()} loading={loading}>
              Ask
            </Button>
          </View>

          {!result && !loading && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {SUGGESTIONS.map((s) => (
                <Pressable accessibilityRole="button"
                  key={s}
                  onPress={() => {
                    setQuestion(s);
                    ask(s);
                  }}
                  style={{
                    borderWidth: 1,
                    borderColor: theme.colors.borderDefault,
                    borderRadius: theme.radius.full,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                  }}
                >
                  <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>{s}</Text>
                </Pressable>
              ))}
            </View>
          )}

          {loading && <ActivityIndicator color={theme.colors.brandDefault} />}

          {error && <Text style={{ color: theme.colors.critical, fontSize: 13 }}>{error}</Text>}

          {result && (
            <Card style={{ gap: 12 }}>
              {/* §ASK-001 "uncertainty if any" — mirrors apps/web's identical fix (see its comment):
                  insufficientEvidence came back from the API on every response but mobile never rendered
                  it at all (not even the plain-text answer distinguished a confident answer from an
                  unconfident one), so a low-confidence answer looked exactly as authoritative as a fully-
                  grounded one — found live via a real audit, same gap class as web had before its fix. */}
              {result.insufficientEvidence && <Badge tone="warning">Not confident</Badge>}
              <Text style={{ fontSize: 15, color: theme.colors.textPrimary }}>{result.answer}</Text>
              {result.evidence.length > 0 && (
                <View style={{ gap: 4, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 12 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Sources</Text>
                  {result.evidence.map((e) => {
                    const route = EVIDENCE_ROUTE[e.resourceType]?.(e.resourceId);
                    const content = (
                      <Text style={{ fontSize: 13, color: route ? theme.colors.brandDefault : theme.colors.textSecondary }}>{e.text}</Text>
                    );
                    return route ? (
                      <Pressable accessibilityRole="button" key={e.resourceId} onPress={() => router.push(route)}>
                        {content}
                      </Pressable>
                    ) : (
                      <View key={e.resourceId}>{content}</View>
                    );
                  })}
                </View>
              )}
            </Card>
          )}
        </>
      ) : (
        <>
          <View style={{ gap: 12 }}>
            <TextField
              label="Search"
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search by merchant, order number, biller, title…"
              onSubmitEditing={runSearch}
              returnKeyType="search"
            />
            <Button onPress={runSearch} loading={searchLoading}>
              Search
            </Button>
          </View>

          {searchLoading && <ActivityIndicator color={theme.colors.brandDefault} />}

          {searchError && <Text style={{ color: theme.colors.critical, fontSize: 13 }}>{searchError}</Text>}

          {!searchLoading && searchResult && searchTotal === 0 && (
            <Text style={{ fontSize: 14, color: theme.colors.textTertiary }}>No matches for &ldquo;{searchQuery}&rdquo;.</Text>
          )}

          {!searchLoading && searchResult && searchTotal > 0 && (
            <View style={{ gap: 16 }}>
              {searchResult.purchases.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Purchases</Text>
                  {searchResult.purchases.map((p) => (
                    <Pressable accessibilityRole="button" key={p.id} onPress={() => router.push(`/purchase/${p.id}`)}>
                      <Card style={{ gap: 2 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{p.merchantName ?? "Unknown merchant"}</Text>
                        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                          {p.orderNumber ? `Order ${p.orderNumber} — ` : ""}
                          {money(p.totalMinorUnits, p.totalCurrency)} — {p.state}
                        </Text>
                      </Card>
                    </Pressable>
                  ))}
                </View>
              )}

              {searchResult.bills.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Bills</Text>
                  {searchResult.bills.map((b) => (
                    <Pressable accessibilityRole="button" key={b.id} onPress={() => router.push(`/bill/${b.id}`)}>
                      <Card style={{ gap: 2 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{b.billerLabel}</Text>
                        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{money(b.amountDueMinorUnits, b.amountDueCurrency)} due</Text>
                      </Card>
                    </Pressable>
                  ))}
                </View>
              )}

              {searchResult.events.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Events</Text>
                  {searchResult.events.map((e) => (
                    <Pressable accessibilityRole="button" key={e.id} onPress={() => router.push(`/event/${e.id}`)}>
                      <Card style={{ gap: 2 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{e.title}</Text>
                        {e.location && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{e.location}</Text>}
                      </Card>
                    </Pressable>
                  ))}
                </View>
              )}

              {searchResult.documents.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Documents</Text>
                  {searchResult.documents.map((d) => (
                    <Pressable accessibilityRole="button" key={d.id} onPress={() => router.push("/documents")}>
                      <Card style={{ gap: 2 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{d.title}</Text>
                        <Text style={{ fontSize: 12, color: theme.colors.textTertiary, textTransform: "capitalize" }}>{d.documentType.replace(/_/g, " ")}</Text>
                      </Card>
                    </Pressable>
                  ))}
                </View>
              )}

              {/* §ASK-002 domain coverage — mirrors web's identical fix; these domains previously had no
                  search coverage at all, so there was nothing here to render for them either. */}
              {searchResult.warranties.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Warranties</Text>
                  {searchResult.warranties.map((w) => (
                    <Pressable accessibilityRole="button" key={w.id} onPress={() => router.push(`/warranty/${w.id}`)}>
                      <Card style={{ gap: 2 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{w.productLabel}</Text>
                        {w.expirationDate?.date && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Expires {w.expirationDate.date}</Text>}
                      </Card>
                    </Pressable>
                  ))}
                </View>
              )}

              {searchResult.subscriptions.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Subscriptions</Text>
                  {searchResult.subscriptions.map((s) => (
                    <Pressable accessibilityRole="button" key={s.id} onPress={() => router.push(`/subscription/${s.id}`)}>
                      <Card style={{ gap: 2 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{s.serviceLabel}</Text>
                        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                          {money(s.typicalAmountMinorUnits, s.typicalAmountCurrency)} / {s.cadence}
                        </Text>
                      </Card>
                    </Pressable>
                  ))}
                </View>
              )}

              {searchResult.shipments.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Shipments</Text>
                  {searchResult.shipments.map((s) => (
                    <Pressable accessibilityRole="button" key={s.id} onPress={() => router.push(`/shipment/${s.id}`)}>
                      <Card style={{ gap: 2 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{s.carrier}</Text>
                        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{s.trackingNumber} — {s.status}</Text>
                      </Card>
                    </Pressable>
                  ))}
                </View>
              )}

              {searchResult.returnCases.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Returns</Text>
                  {searchResult.returnCases.map((r) => (
                    <Pressable accessibilityRole="button" key={r.id} onPress={() => router.push(`/return-case/${r.id}`)}>
                      <Card style={{ gap: 2 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{r.merchantName ?? "Unknown merchant"}</Text>
                        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                          {r.orderNumber ? `Order ${r.orderNumber} — ` : ""}
                          {r.state}
                        </Text>
                      </Card>
                    </Pressable>
                  ))}
                </View>
              )}

              {searchResult.trips.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Trips</Text>
                  {searchResult.trips.map((t) => (
                    <Pressable accessibilityRole="button" key={t.id} onPress={() => router.push(`/trip/${t.id}`)}>
                      <Card style={{ gap: 2 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{t.label ?? t.destinationLabel ?? "Trip"}</Text>
                        <Text style={{ fontSize: 12, color: theme.colors.textTertiary, textTransform: "capitalize" }}>{t.status}</Text>
                      </Card>
                    </Pressable>
                  ))}
                </View>
              )}

              {searchResult.savedMemories.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Saved</Text>
                  {searchResult.savedMemories.map((m) => (
                    <Pressable accessibilityRole="button" key={m.id} onPress={() => router.push(`/saved-item/${m.id}`)}>
                      <Card style={{ gap: 2 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{m.title ?? "Untitled"}</Text>
                        <Text style={{ fontSize: 12, color: theme.colors.textTertiary, textTransform: "capitalize" }}>{(m.category ?? m.sourceKind).replace(/_/g, " ")}</Text>
                      </Card>
                    </Pressable>
                  ))}
                </View>
              )}

              {searchResult.pets.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Pets</Text>
                  {searchResult.pets.map((p) => (
                    <Pressable accessibilityRole="button" key={p.id} onPress={() => router.push(`/pet/${p.id}`)}>
                      <Card style={{ gap: 2 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{p.label}</Text>
                        {(p.species || p.breed) && (
                          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{[p.species, p.breed].filter(Boolean).join(" — ")}</Text>
                        )}
                      </Card>
                    </Pressable>
                  ))}
                </View>
              )}

              {searchResult.healthAppointments.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Health appointments</Text>
                  {searchResult.healthAppointments.map((a) => (
                    <Pressable accessibilityRole="button" key={a.id} onPress={() => router.push("/life")}>
                      <Card style={{ gap: 2 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{a.providerName ?? a.appointmentType ?? "Appointment"}</Text>
                        {a.appointmentType && a.providerName && (
                          <Text style={{ fontSize: 12, color: theme.colors.textTertiary, textTransform: "capitalize" }}>{a.appointmentType}</Text>
                        )}
                      </Card>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          )}
        </>
      )}
    </Screen>
  );
}
