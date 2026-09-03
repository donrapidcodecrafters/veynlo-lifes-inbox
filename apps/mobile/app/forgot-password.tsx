import { useState } from "react";
import { Text, View } from "react-native";
import { Link } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { CenteredScreen } from "@/components/screen";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";

/**
 * §AUTH-001 "recover account" — was entirely missing on mobile: sign-in.tsx had no "Forgot password?"
 * link at all, and the backend's `/v1/auth/forgot-password` was only ever reachable from the web app.
 * Mirrors web's /forgot-password page. The reset link itself still lands on the web app (see
 * IdentityService.forgotPassword's `resetUrl`, always built from `WEB_APP_URL`) — that's an existing,
 * deliberate architectural choice (one reset-completion surface, not two to keep in sync), not something
 * this screen needs to duplicate. This screen only needs to let a mobile user *request* that email.
 */
export default function ForgotPasswordScreen() {
  const { theme } = useAppTheme();
  const [email, setEmail] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit() {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      // Same "always show success" reasoning as web's forgot-password page — the API never reveals
      // whether the email matched a real account, so neither should this screen.
      await api.post("/v1/auth/forgot-password", { email });
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors ?? {});
        if (!err.fieldErrors || Object.keys(err.fieldErrors).length === 0) setError(err.message);
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <CenteredScreen>
        <View style={{ gap: 16 }}>
          <Text style={{ fontSize: 22, fontWeight: "700", color: theme.colors.textPrimary }}>Check your email</Text>
          <Text style={{ fontSize: 15, color: theme.colors.textSecondary }}>
            If <Text style={{ fontWeight: "600" }}>{email}</Text> is a Veynlo account, we&apos;ve sent a link to reset your password. It
            expires in 1 hour.
          </Text>
          <Link href="/sign-in" style={{ color: theme.colors.brandDefault, fontWeight: "600", fontSize: 15 }}>
            Back to sign in
          </Link>
        </View>
      </CenteredScreen>
    );
  }

  return (
    <CenteredScreen>
      <View style={{ gap: 24 }}>
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: 22, fontWeight: "700", color: theme.colors.textPrimary }}>Reset your password</Text>
          <Text style={{ fontSize: 15, color: theme.colors.textTertiary }}>
            Enter your account&apos;s email and we&apos;ll send you a link to reset your password.
          </Text>
        </View>
        <View style={{ gap: 16 }}>
          <TextField
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            error={fieldErrors.email?.[0]}
          />
          {error && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{error}</Text>}
          <Button onPress={onSubmit} loading={submitting}>
            Send reset link
          </Button>
        </View>
        <Link href="/sign-in" style={{ color: theme.colors.brandDefault, fontWeight: "600", fontSize: 15, textAlign: "center" }}>
          Back to sign in
        </Link>
      </View>
    </CenteredScreen>
  );
}
