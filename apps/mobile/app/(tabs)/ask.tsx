import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";

interface AskResponse {
  answer: string;
  evidence: Array<{ resourceType: string; resourceId: string; text: string }>;
  insufficientEvidence: boolean;
}

interface SavedQuery {
  id: string;
  questionText: string;
}

const SUGGESTIONS = [
  "What purchases can I still return?",
  "What bills are due this week?",
  "How much am I paying for subscriptions?",
];

// Real-time speech-to-text on native needs a native module and a custom dev-client rebuild (not
// Expo-Go-compatible) — a separate, larger effort matching this app's other native-feature work (see
// ROADMAP). Deliberately deferred rather than half-built; web's Ask page has a real Web Speech API mic
// button since that needs no native module at all.
export default function AskScreen() {
  const { theme } = useAppTheme();
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [history, setHistory] = useState<Array<{ question: string; response: AskResponse }>>([]);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);

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

  return (
    <Screen>
      <View>
        <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>Ask Veynlo</Text>
        <Text style={{ fontSize: 14, color: theme.colors.textTertiary, marginTop: 2 }}>
          Ask about anything Veynlo knows — grounded in your own data.
        </Text>
      </View>

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
                >
                  <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>{sq.questionText}</Text>
                </Pressable>
                <Pressable onPress={() => deleteSavedQuery(sq.id)} style={{ paddingHorizontal: 4 }}>
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
    </Screen>
  );
}
