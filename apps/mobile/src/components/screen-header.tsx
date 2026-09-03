import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useAppTheme } from "@/lib/theme-context";

/** A simple back-button + title header for stack screens pushed on top of the tab bar (root Stack has headerShown: false globally). */
export function ScreenHeader({ title, subtitle, showBack = true }: { title: string; subtitle?: string; showBack?: boolean }) {
  const { theme } = useAppTheme();
  const router = useRouter();

  return (
    <View style={{ gap: 4 }}>
      {/* `router.canGoBack()` alone isn't enough to decide this: React Navigation's bottom tabs default to
          `backBehavior: "history"`, so canGoBack() turns true the moment the user has switched tabs even
          once — nothing to do with this screen having been pushed. On (tabs)/life.tsx (a tab ROOT, not a
          pushed screen) that made a "‹ Back" chevron appear after any tab switch, which then navigated to
          whichever tab was previously active instead of behaving like a real back-pop — confirmed live by
          tapping Home → Life in the tab bar. Every other ScreenHeader caller is a genuinely pushed
          stack screen outside the tabs group, so `showBack` defaults to true and only the tab-root caller
          opts out. */}
      {showBack && router.canGoBack() && (
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          style={{ alignSelf: "flex-start", paddingVertical: 4 }}
          accessibilityRole="button"
          // "‹ Back" read literally ("chevron, Back") is noise a sighted user never has to parse — the
          // chevron is purely decorative here, so the spoken label skips straight to the action.
          accessibilityLabel="Go back"
        >
          <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.brandDefault }} maxFontSizeMultiplier={1.6}>
            ‹ Back
          </Text>
        </Pressable>
      )}
      {/* `accessibilityRole="header"` lets VoiceOver/TalkBack users jump screen-to-screen by heading
          instead of swiping through every row — every pushed screen's title becomes a navigable landmark. */}
      <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }} accessibilityRole="header" maxFontSizeMultiplier={2}>
        {title}
      </Text>
      {/* `subtitle && <Text>` renders the empty string itself (not `false`) whenever a caller passes "" —
          e.g. vehicle/[id].tsx's `[subtitle, vin ? ... : null].filter(Boolean).join(" — ")` yields "" for a
          vehicle with no make/model/year/vin. React Native Web then logs "Unexpected text node: . A text
          node cannot be a child of a <View>" and shows a red error toast (confirmed live). A ternary against
          `null` avoids ever rendering a bare "" text node. */}
      {subtitle ? (
        <Text style={{ fontSize: 14, color: theme.colors.textTertiary }} maxFontSizeMultiplier={1.8}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}
