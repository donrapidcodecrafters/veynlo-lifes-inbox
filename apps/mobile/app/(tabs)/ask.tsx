import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
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

export default function AskScreen() {
  const { theme } = useAppTheme();
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);

  async function ask() {
    if (!question.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await api.post<AskResponse>("/v1/ask", { question });
      setResult(res);
    } finally {
      setLoading(false);
    }
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
          onSubmitEditing={ask}
          returnKeyType="send"
        />
        <Button onPress={ask} loading={loading}>
          Ask
        </Button>
      </View>

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
    </Screen>
  );
}
