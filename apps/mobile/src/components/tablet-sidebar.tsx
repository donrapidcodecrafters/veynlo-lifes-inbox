import { Pressable, Text, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "@/lib/theme-context";

interface SidebarItem {
  href: "/" | "/inbox" | "/ask" | "/life" | "/settings";
  icon: keyof typeof Ionicons.glyphMap;
  labelKey: "home" | "inbox" | "ask" | "life" | "settings";
}

const ITEMS: SidebarItem[] = [
  { href: "/", icon: "home", labelKey: "home" },
  { href: "/inbox", icon: "file-tray", labelKey: "inbox" },
  { href: "/ask", icon: "chatbubble", labelKey: "ask" },
  { href: "/life", icon: "albums", labelKey: "life" },
  { href: "/settings", icon: "settings", labelKey: "settings" },
];

/**
 * The tablet-only left rail that replaces the bottom tab bar above TABLET_MIN_WIDTH (see
 * (tabs)/_layout.tsx — this component only ever mounts once that check is true, so there is no
 * width check duplicated in here).
 *
 * A phone-style horizontal bar stretched full width on a tablet is the same class of defect
 * screen.tsx's TABLET_MIN_WIDTH split already fixed for content — af0a191's own commit message
 * names it directly. (tabs)/_layout.tsx's screenOptions comment documents two earlier, reverted
 * attempts to fix this by restyling the *existing* bottom bar (capping tabBarItemStyle.maxWidth,
 * then tabBarStyle justifyContent): both failed because react-navigation lays its internal item
 * row out from the left and neither style reaches that inner row. This sidesteps that entirely by
 * hiding the built-in bar outright (`tabBarStyle: { display: "none" }`, the standard supported way
 * to hide it — not a restyle) and rendering a genuinely separate component instead, so the phone
 * bar's own internals are never touched and carry zero regression risk.
 */
export function TabletSidebar() {
  const { theme } = useAppTheme();
  const { t } = useTranslation("translation", { keyPrefix: "nav" });
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        width: 220,
        paddingTop: insets.top + 12,
        paddingBottom: insets.bottom + 12,
        paddingHorizontal: 12,
        gap: 4,
        backgroundColor: theme.colors.bgSurface,
        borderRightWidth: 1,
        borderRightColor: theme.colors.borderSubtle,
      }}
    >
      {ITEMS.map((item) => {
        // "/" only matches the Home tab itself, never as a prefix of every other route (which all
        // start with "/" too) — every other tab's own route is matched by prefix so a pushed detail
        // screen under it (e.g. "/life" while viewing "/vehicle/abc") still highlights correctly.
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const color = active ? theme.colors.brandDefault : theme.colors.textTertiary;
        return (
          <Pressable
            key={item.href}
            accessibilityRole="button"
            accessibilityLabel={t(item.labelKey)}
            accessibilityState={{ selected: active }}
            onPress={() => router.push(item.href)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingVertical: 12,
              paddingHorizontal: 12,
              borderRadius: theme.radius.md,
              backgroundColor: active ? theme.colors.bgSubtle : "transparent",
            }}
          >
            <Ionicons name={active ? item.icon : (`${item.icon}-outline` as keyof typeof Ionicons.glyphMap)} size={22} color={color} importantForAccessibility="no" />
            <Text style={{ fontSize: 15, fontWeight: active ? "600" : "400", color }}>{t(item.labelKey)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
