import { useState } from "react";
import { Text, View } from "react-native";
import { Link } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { CenteredScreen } from "@/components/screen";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";

export default function ForgotPasswordScreen() {
  const { theme } = useAppTheme();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit() {
    setLoading(true);
    setError(null);
    try {
      await api.post("/v1/auth/forgot-password", { email });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <CenteredScreen>
        <View style={{ gap: 12 }}>
          <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>Check your email</Text>
          <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>
            If an account exists for {email}, a password reset link is on its way. It expires in 1 hour.
          </Text>
          <Link href="/sign-in" style={{ color: theme.colors.brandDefault, fontWeight: "600" }}>
            Back to sign in
          </Link>
        </View>
      </CenteredScreen>
    );
  }

  return (
    <CenteredScreen>
      <View style={{ gap: 20 }}>
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>Reset your password</Text>
          <Text style={{ fontSize: 14, color: theme.colors.textTertiary }}>Enter your email and we&apos;ll send you a reset link.</Text>
        </View>
        <TextField label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
        {error && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{error}</Text>}
        <Button onPress={onSubmit} loading={loading}>
          Send reset link
        </Button>
        <Link href="/sign-in" style={{ color: theme.colors.brandDefault, fontWeight: "600", alignSelf: "center" }}>
          Back to sign in
        </Link>
      </View>
    </CenteredScreen>
  );
}
