import { useState } from "react";
import { Text, View } from "react-native";
import { Link, Redirect, router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useAuth, ApiError } from "@/lib/auth-context";
import { useAppTheme } from "@/lib/theme-context";
import { passkeyAvailable, isPasskeySupported } from "@/lib/passkey";
import { CenteredScreen } from "@/components/screen";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";
import { OAuthSignInButtons } from "@/components/oauth-sign-in-buttons";

export default function SignInScreen() {
  const { user, isLoading, signIn, signInWithPasskey } = useAuth();
  const { theme } = useAppTheme();
  const { t } = useTranslation("translation", { keyPrefix: "auth.signIn" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [passkeySubmitting, setPasskeySubmitting] = useState(false);

  if (!isLoading && user) return <Redirect href="/(tabs)" />;

  /** AUTH-001 "Sign in with a passkey" — UNVERIFIED ON A REAL DEVICE, see docs/PHASE2_PENDING_CREDENTIALS.md. */
  async function onPasskeySignIn() {
    setPasskeySubmitting(true);
    setError(null);
    try {
      const outcome = await signInWithPasskey();
      if (outcome === "success") router.replace("/(tabs)");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : t("passkeyError"));
    } finally {
      setPasskeySubmitting(false);
    }
  }

  async function onSubmit() {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await signIn(email, password);
      router.replace("/(tabs)");
    } catch (err) {
      // Same reasoning as apps/mobile/app/sign-up.tsx: a request-body validation failure (e.g. empty
      // email/password on submit) needs to point at the actual field, not just show the generic
      // "Request body failed validation." text — wrong-credentials errors have no fieldErrors, so those
      // still fall through to the plain message exactly as before.
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors ?? {});
        if (!err.fieldErrors || Object.keys(err.fieldErrors).length === 0) setError(err.message);
      } else {
        setError(t("genericError"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CenteredScreen>
      <View style={{ gap: 24 }}>
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>Veynlo</Text>
          <Text style={{ fontSize: 15, color: theme.colors.textTertiary }}>{t("tagline")}</Text>
        </View>
        <View style={{ gap: 16 }}>
          <TextField
            label={t("emailLabel")}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            error={fieldErrors.email?.[0]}
          />
          <TextField
            label={t("passwordLabel")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
            error={fieldErrors.password?.[0]}
          />
          <Link href="/forgot-password" style={{ color: theme.colors.brandDefault, fontWeight: "600", fontSize: 13, alignSelf: "flex-end" }}>
            {t("forgotPassword")}
          </Link>
          {error && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{error}</Text>}
          <Button onPress={onSubmit} loading={submitting}>
            {t("submit")}
          </Button>
        </View>
        {passkeyAvailable && isPasskeySupported() && (
          <Button variant="secondary" onPress={onPasskeySignIn} loading={passkeySubmitting}>
            {t("passkey")}
          </Button>
        )}
        <OAuthSignInButtons />
        <View style={{ flexDirection: "row", justifyContent: "center", gap: 4 }}>
          <Text style={{ color: theme.colors.textSecondary }}>{t("noAccount")}</Text>
          <Link href="/sign-up" style={{ color: theme.colors.brandDefault, fontWeight: "600" }}>
            {t("createAccount")}
          </Link>
        </View>
      </View>
    </CenteredScreen>
  );
}
