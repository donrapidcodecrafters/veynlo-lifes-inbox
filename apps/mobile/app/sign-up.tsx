import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Link, Redirect, router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useAuth, ApiError } from "@/lib/auth-context";
import { useAppTheme } from "@/lib/theme-context";
import { CenteredScreen } from "@/components/screen";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";
import { OAuthSignInButtons } from "@/components/oauth-sign-in-buttons";
import { api } from "@/lib/api-client";

export default function SignUpScreen() {
  const { user, isLoading, signUp } = useAuth();
  const { theme } = useAppTheme();
  const { t } = useTranslation("translation", { keyPrefix: "auth.signUp" });
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  // "Pre-launch private testing distribution" (docs/ROADMAP.md) — same GET /v1/auth/config check as
  // apps/web/src/app/(auth)/sign-up/page.tsx, so this screen only shows the invite-code field when the
  // deployment actually requires one.
  const [inviteRequired, setInviteRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get<{ signUpRequiresInvite: boolean }>("/v1/auth/config")
      .then((config) => setInviteRequired(config.signUpRequiresInvite))
      .catch(() => {
        // Leave the field hidden on failure — the backend still enforces the real requirement either way.
      });
  }, []);

  if (!isLoading && user) return <Redirect href="/(tabs)" />;

  async function onSubmit() {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await signUp(email, password, displayName, inviteCode.trim() || undefined);
      // ONB-001 — a brand-new sign-up goes to onboarding first; (tabs)/_layout.tsx would bounce it there
      // anyway on next load, but starting here avoids that extra hop (mirrors apps/web's sign-up page).
      router.replace("/onboarding");
    } catch (err) {
      // Mirrors apps/web/src/app/(auth)/sign-up/page.tsx: a Zod validation failure (e.g. password under
      // 10 chars) comes back with `err.message` set to the generic "Request body failed validation." —
      // showing only that told the user nothing about WHICH field was wrong or why. `fieldErrors` carries
      // the actual per-field reasons; surface those next to their inputs the same way web does, falling
      // back to the generic message only when the server didn't send field-level detail (e.g. duplicate
      // email, a plain network failure).
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
          <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>{t("title")}</Text>
        </View>
        <View style={{ gap: 16 }}>
          <TextField
            label={t("nameLabel")}
            value={displayName}
            onChangeText={setDisplayName}
            autoComplete="name"
            error={fieldErrors.displayName?.[0]}
          />
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
            autoComplete="password-new"
            error={fieldErrors.password?.[0]}
          />
          {inviteRequired && (
            <TextField
              label={t("inviteCodeLabel")}
              value={inviteCode}
              onChangeText={setInviteCode}
              autoCapitalize="characters"
              autoComplete="off"
              error={fieldErrors.inviteCode?.[0]}
            />
          )}
          {error && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{error}</Text>}
          <Button onPress={onSubmit} loading={submitting}>
            {t("submit")}
          </Button>
        </View>
        <OAuthSignInButtons />
        <View style={{ flexDirection: "row", justifyContent: "center", gap: 4 }}>
          <Text style={{ color: theme.colors.textSecondary }}>{t("haveAccount")}</Text>
          <Link href="/sign-in" style={{ color: theme.colors.brandDefault, fontWeight: "600" }}>
            {t("signIn")}
          </Link>
        </View>
      </View>
    </CenteredScreen>
  );
}
