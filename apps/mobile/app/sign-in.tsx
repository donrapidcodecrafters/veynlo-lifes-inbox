import { useState } from "react";
import { Text, View } from "react-native";
import { Link, Redirect, router } from "expo-router";
import { useAuth, ApiError } from "@/lib/auth-context";
import { useAppTheme } from "@/lib/theme-context";
import { CenteredScreen } from "@/components/screen";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";

export default function SignInScreen() {
  const { user, isLoading, signIn } = useAuth();
  const { theme } = useAppTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
          {error && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{error}</Text>}
          <Button onPress={onSubmit} loading={submitting}>
            Sign in
          </Button>
        </View>
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
