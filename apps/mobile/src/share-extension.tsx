import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, useColorScheme } from "react-native";
import { close, openHostApp, Text, TextInput, View, type InitialProps } from "expo-share-extension";
import { lightSemanticColors, darkSemanticColors, brand } from "@veynlo/design-tokens";

// Long shared content gets truncated before being encoded into the deep-link URL that hands off to the
// main app — openHostApp's native side does a naive "&"/"="-split with no percent-decoding of its own, so
// a very long body would risk exceeding practical URL-scheme length limits well before that split ever runs.
const MAX_BODY_LENGTH = 1500;

/**
 * §CAP-001/CAP-002 iOS Share Extension — deliberately does NOT make its own authenticated API call. This
 * process has no access to the main app's Keychain-stored session token (no shared access-group wired up
 * for it, and expo-share-extension's built-in shared-auth hook is Firebase-specific, not usable for our
 * own bearer token), so instead it hands the captured text/URL to the main app via a `veynlo://capture`
 * deep link (see app/capture.tsx) — the main app is already authenticated and does the real submit.
 */
export default function ShareExtension(props: InitialProps) {
  const [subject, setSubject] = useState(props.url ? "Shared link" : "Shared text");
  const [saving, setSaving] = useState(false);
  // This extension runs as its own separate native process — it has no access to the main app's
  // ThemeProvider/useAppTheme() context, so it reads the OS appearance directly instead.
  const scheme = useColorScheme();
  const colors = scheme === "dark" ? darkSemanticColors : lightSemanticColors;
  const styles = createStyles(colors);

  const body = (props.text ?? props.url ?? "").slice(0, MAX_BODY_LENGTH);

  function save() {
    setSaving(true);
    const path = `capture?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    openHostApp(path);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Save to Veynlo</Text>
      <TextInput
        style={styles.input}
        value={subject}
        onChangeText={setSubject}
        placeholder="Subject"
        allowFontScaling={false}
        accessibilityLabel="Subject"
      />
      <Text style={styles.preview} numberOfLines={4}>
        {body || "Nothing to save."}
      </Text>
      <View style={styles.row}>
        <Pressable
          style={[styles.button, styles.cancelButton]}
          onPress={() => close()}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.saveButton]}
          onPress={save}
          disabled={saving || !body}
          accessibilityRole="button"
          accessibilityLabel="Save"
        >
          {saving ? <ActivityIndicator color={colors.textOnBrand} /> : <Text style={styles.saveText}>Save</Text>}
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(colors: Record<keyof typeof lightSemanticColors, string>) {
  return StyleSheet.create({
    container: { padding: 20, gap: 12, backgroundColor: colors.bgSurface },
    title: { fontSize: 17, fontWeight: "700", color: colors.textPrimary },
    input: { borderWidth: 1, borderColor: colors.borderDefault, borderRadius: 10, padding: 12, fontSize: 15, color: colors.textPrimary },
    preview: { fontSize: 13, color: colors.textSecondary, maxHeight: 80 },
    row: { flexDirection: "row", gap: 10, marginTop: 4 },
    button: { flex: 1, height: 44, borderRadius: 10, alignItems: "center", justifyContent: "center" },
    cancelButton: { backgroundColor: colors.bgSubtle },
    cancelText: { color: colors.textPrimary, fontWeight: "600" },
    saveButton: { backgroundColor: brand[500] },
    saveText: { color: colors.textOnBrand, fontWeight: "600" },
  });
}
