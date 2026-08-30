import { useCallback, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";
import { isVoiceCaptureSupported, useVoiceCapture } from "@/lib/voice";

interface AskResponse {
  answer: string;
  evidence: Array<{ resourceType: string; resourceId: string; text: string }>;
  insufficientEvidence: boolean;
}

interface SavedQuery {
  id: string;
  questionText: string;
}

/** ASK-002 "structured search" — same missing-UI fix as web's Ask page: GET /v1/search was real and
 * correct but nothing ever called it. */
interface SearchResponse {
  purchases: Array<{ id: string; orderNumber: string | null }>;
  bills: Array<{ id: string; billerLabel: string }>;
  documents: Array<{ id: string; title: string }>;
  events: Array<{ id: string; title: string }>;
}

const SUGGESTIONS = [
  "What purchases can I still return?",
  "What bills are due this week?",
  "How much am I paying for subscriptions?",
];

export default function AskScreen() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const [mode, setMode] = useState<"ask" | "search">("ask");
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [history, setHistory] = useState<Array<{ question: string; response: AskResponse }>>([]);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);

  const [searchTerm, setSearchTerm] = useState("");
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);

  const [voiceSupported] = useState(() => isVoiceCaptureSupported());
  const { listening, start: startVoice, stop: stopVoice } = useVoiceCapture((transcript) => {
    setQuestion(transcript);
    void ask(transcript);
  });

  const loadSavedQueries = useCallback(async () => {
    const rows = await api.get<SavedQuery[]>("/v1/saved-queries").catch(() => []);
    setSavedQueries(rows);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadSavedQueries();
    }, [loadSavedQueries]),
  );

  async function ask(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const recentHistory = history
        .slice(0, 5)
        .map((h) => ({ question: h.question, answer: h.response.answer }))
        .reverse();
      const res = await api.post<AskResponse>("/v1/ask", { question: q, history: recentHistory });
      setResult(res);
      setHistory((h) => [{ question: q, response: res }, ...h]);
    } finally {
      setLoading(false);
    }
  }

  async function saveCurrentQuestion() {
    if (!question.trim()) return;
    await api.post("/v1/saved-queries", { questionText: question });
    loadSavedQueries();
  }

  async function deleteSavedQuery(id: string) {
    await api.post(`/v1/saved-queries/${id}/delete`);
    loadSavedQueries();
  }

  async function runSearch() {
    if (!searchTerm.trim()) return;
    setSearching(true);
    try {
      const res = await api.get<SearchResponse>(`/v1/search?q=${encodeURIComponent(searchTerm)}`);
      setSearchResult(res);
    } finally {
      setSearching(false);
    }
  }

  async function openDocument(id: string) {
    const { url } = await api.get<{ url: string }>(`/v1/documents/${id}/download-url`);
    await Linking.openURL(url);
  }

  return (
    <Screen>
      <View>
        <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>Ask Veynlo</Text>
        <Text style={{ fontSize: 14, color: theme.colors.textTertiary, marginTop: 2 }}>
          Ask about anything Veynlo knows — grounded in your own data.
        </Text>
      </View>

      <View style={{ flexDirection: "row", gap: 6, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg, padding: 4 }}>
        {(["ask", "search"] as const).map((m) => {
          const active = mode === m;
          return (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              accessibilityRole="button"
              accessibilityLabel={m === "ask" ? "Ask" : "Search"}
              style={{ flex: 1, paddingVertical: 8, borderRadius: theme.radius.md, backgroundColor: active ? theme.colors.bgSurface : "transparent", alignItems: "center" }}
            >
              <Text style={{ fontSize: 14, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary }}>
                {m === "ask" ? "Ask" : "Search"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {mode === "search" ? (
        <View style={{ gap: 12 }}>
          <TextField
            label="Search"
            value={searchTerm}
            onChangeText={setSearchTerm}
            placeholder="Search purchases, bills, documents, events…"
            onSubmitEditing={runSearch}
            returnKeyType="search"
          />
          <Button onPress={runSearch} loading={searching}>
            Search
          </Button>

          {searchResult && (
            <View style={{ gap: 16 }}>
              {searchResult.purchases.length === 0 &&
                searchResult.bills.length === 0 &&
                searchResult.documents.length === 0 &&
                searchResult.events.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No matches.</Text>}

              {searchResult.purchases.length > 0 && (
                <View style={{ gap: 6 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Purchases</Text>
                  {searchResult.purchases.map((p) => (
                    <Pressable
                      key={p.id}
                      onPress={() => router.push(`/purchase/${p.id}`)}
                      accessibilityRole="button"
                      accessibilityLabel={`Order ${p.orderNumber ?? p.id}`}
                    >
                      <Text style={{ fontSize: 14, color: theme.colors.brandDefault }}>Order {p.orderNumber ?? p.id}</Text>
                    </Pressable>
                  ))}
                </View>
              )}

              {searchResult.bills.length > 0 && (
                <View style={{ gap: 6 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Bills</Text>
                  {searchResult.bills.map((b) => (
                    <Pressable
                      key={b.id}
                      onPress={() => router.push(`/bill/${b.id}`)}
                      accessibilityRole="button"
                      accessibilityLabel={b.billerLabel}
                    >
                      <Text style={{ fontSize: 14, color: theme.colors.brandDefault }}>{b.billerLabel}</Text>
                    </Pressable>
                  ))}
                </View>
              )}

              {searchResult.documents.length > 0 && (
                <View style={{ gap: 6 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Documents</Text>
                  {searchResult.documents.map((d) => (
                    <Pressable
                      key={d.id}
                      onPress={() => openDocument(d.id)}
                      accessibilityRole="button"
                      accessibilityLabel={d.title}
                    >
                      <Text style={{ fontSize: 14, color: theme.colors.brandDefault }}>{d.title}</Text>
                    </Pressable>
                  ))}
                </View>
              )}

              {searchResult.events.length > 0 && (
                <View style={{ gap: 6 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Events</Text>
                  {searchResult.events.map((e) => (
                    <Pressable
                      key={e.id}
                      onPress={() => router.push(`/event/${e.id}`)}
                      accessibilityRole="button"
                      accessibilityLabel={e.title}
                    >
                      <Text style={{ fontSize: 14, color: theme.colors.brandDefault }}>{e.title}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          )}
        </View>
      ) : (
        <>
      <View style={{ gap: 12 }}>
        <TextField
          label="Question"
          value={question}
          onChangeText={setQuestion}
          placeholder="When does my warranty expire?"
          onSubmitEditing={() => ask(question)}
          returnKeyType="send"
        />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Button onPress={() => ask(question)} loading={loading}>
              Ask
            </Button>
          </View>
          <View style={{ flex: 1 }}>
            <Button variant="secondary" onPress={saveCurrentQuestion} disabled={!question.trim()}>
              Save
            </Button>
          </View>
          {voiceSupported && (
            <View style={{ flex: 1 }}>
              <Button variant={listening ? "primary" : "secondary"} onPress={listening ? stopVoice : startVoice}>
                {listening ? "Listening…" : "🎙 Ask by voice"}
              </Button>
            </View>
          )}
        </View>
      </View>

      {savedQueries.length > 0 && !result && !loading && history.length === 0 && (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
            Saved questions
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {savedQueries.map((sq) => (
              <View
                key={sq.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  borderRadius: theme.radius.lg,
                  borderWidth: 1,
                  borderColor: theme.colors.borderDefault,
                  paddingLeft: 12,
                  paddingRight: 6,
                  paddingVertical: 6,
                  gap: 4,
                }}
              >
                <Pressable
                  onPress={() => {
                    setQuestion(sq.questionText);
                    ask(sq.questionText);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={sq.questionText}
                >
                  <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>{sq.questionText}</Text>
                </Pressable>
                <Pressable
                  onPress={() => deleteSavedQuery(sq.id)}
                  style={{ paddingHorizontal: 4 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete saved question: ${sq.questionText}`}
                >
                  <Text style={{ fontSize: 15, color: theme.colors.textTertiary }}>×</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </View>
      )}

      {!result && !loading && history.length === 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {SUGGESTIONS.map((s) => (
            <Pressable
              key={s}
              onPress={() => {
                setQuestion(s);
                ask(s);
              }}
              accessibilityRole="button"
              accessibilityLabel={s}
              style={{ borderRadius: theme.radius.lg, borderWidth: 1, borderColor: theme.colors.borderDefault, paddingHorizontal: 12, paddingVertical: 6 }}
            >
              <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>{s}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {loading && <ActivityIndicator color={theme.colors.brandDefault} />}

      {result && (
        <Card style={{ gap: 12 }}>
          <Text style={{ fontSize: 15, color: theme.colors.textPrimary }}>{result.answer}</Text>
          {result.evidence.length > 0 && (
            <View style={{ gap: 4, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 12 }}>
              <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
                Sources
              </Text>
              {result.evidence.map((e) => (
                <Text key={e.resourceId} style={{ fontSize: 13, color: theme.colors.textSecondary }}>
                  {e.text}
                </Text>
              ))}
            </View>
          )}
        </Card>
      )}

      {history.length > 1 && (
        <View style={{ gap: 12 }}>
          <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Earlier</Text>
          {history.slice(1).map((h, i) => (
            <Card key={i} style={{ gap: 4 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{h.question}</Text>
              <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>{h.response.answer}</Text>
            </Card>
          ))}
        </View>
      )}
        </>
      )}
    </Screen>
  );
}
