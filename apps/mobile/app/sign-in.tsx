import { useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import { Link, Redirect, router } from "expo-router";
import { useAuth, ApiError } from "@/lib/auth-context";
import { useAppTheme } from "@/lib/theme-context";
import { CenteredScreen } from "@/components/screen";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";

export default function SignInScreen() {
  const { user, isLoading, signIn, signInWithApple } = useAuth();
  const { theme } = useAppTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  if (!isLoading && user) return <Redirect href="/(tabs)" />;

  async function onSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email, password);
      router.replace("/(tabs)");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onAppleSignIn() {
    setError(null);
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      });
      if (!credential.identityToken) throw new Error("Apple didn't return an identity token.");
      await signInWithApple(credential.identityToken);
      router.replace("/(tabs)");
    } catch (err) {
      // ERR_REQUEST_CANCELED fires when the person dismisses the Apple sheet themselves — not an error worth surfacing.
      if (err && typeof err === "object" && "code" in err && err.code === "ERR_REQUEST_CANCELED") return;
      setError(err instanceof ApiError ? err.message : "Couldn't sign in with Apple. Please try again.");
    }
  }

  return (
    <CenteredScreen>
      <View style={{ gap: 24 }}>
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>Veynlo</Text>
          <Text style={{ fontSize: 15, color: theme.colors.textTertiary }}>Your life, remembered.</Text>
        </View>
        <View style={{ gap: 16 }}>
          <TextField
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
          />
          <TextField label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" />
          <Link href="/forgot-password" style={{ color: theme.colors.brandDefault, fontSize: 13, fontWeight: "600", alignSelf: "flex-end" }}>
            Forgot password?
          </Link>
          {error && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{error}</Text>}
          <Button onPress={onSubmit} loading={submitting}>
            Sign in
          </Button>
        </View>
        {appleAvailable && (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
            buttonStyle={theme.mode === "dark" ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={theme.radius.md}
            style={{ height: 44, width: "100%" }}
            onPress={onAppleSignIn}
          />
        )}
        <View style={{ flexDirection: "row", justifyContent: "center", gap: 4 }}>
          <Text style={{ color: theme.colors.textSecondary }}>New to Veynlo?</Text>
          <Link href="/sign-up" style={{ color: theme.colors.brandDefault, fontWeight: "600" }}>
            Create an account
          </Link>
        </View>
      </View>
    </CenteredScreen>
  );
}
