import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useAppTheme } from "@/lib/theme-context";

/**
 * A collapsed group of same-kind things, with optional nesting. Mobile counterpart to
 * apps/web/src/components/collapsible-group.tsx — see that file for why this exists at all.
 *
 * The nesting is Don's shape: a group opens to reveal SUBGROUPS, each collapsed, which open to reveal the
 * records inline on the same screen. Nothing navigates until the user taps an actual record.
 *
 * Two things that are easy to get wrong here and are done deliberately:
 *
 *   The children are rendered ONLY when open, never hidden with a style. A group exists precisely because
 *   its contents are too many to show at once (DEF-105 — this app has no list virtualisation anywhere, so
 *   every mounted row is a real cost), and mounting 55 rows behind `display: none` would pay that cost in
 *   full while showing nothing.
 *
 *   The count is part of the accessible NAME rather than a separate Text the screen reader reaches
 *   afterwards. "Vehicle recalls, 55 items" is what the card is FOR; a name of "Vehicle recalls" with the
 *   55 arriving later as a stray number is a worse description of the same control.
 */
export function CollapsibleGroup({
  label,
  count,
  defaultOpen = false,
  tone = "default",
  meta,
  badge,
  children,
}: {
  label: string;
  count: number;
  /**
   * The urgency of what is INSIDE. Without it a collapsed group of 55 "important" items rendered with no
   * badge directly above single "useful" items that each had one, so the summary ranked below what it
   * summarised.
   */
  badge?: ReactNode;
  defaultOpen?: boolean;
  tone?: "default" | "critical" | "warning";
  meta?: string | null;
  children: ReactNode;
}) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(defaultOpen);

  const labelColor =
    tone === "critical" ? theme.colors.criticalSubtleText : tone === "warning" ? theme.colors.warningSubtleText : theme.colors.textPrimary;

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.bgSurface,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${label}, ${count} ${count === 1 ? "item" : "items"}`}
        accessibilityHint={open ? "Collapses this group" : "Expands this group"}
        onPress={() => setOpen((v) => !v)}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 12, paddingVertical: 11 }}
      >
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}>
          {badge}
          <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: "600", color: labelColor }} maxFontSizeMultiplier={1.6}>
            {label}
          </Text>
          {meta ? (
            <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 12, color: theme.colors.textTertiary }} maxFontSizeMultiplier={1.6}>
              {meta}
            </Text>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ backgroundColor: theme.colors.bgSubtle, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textSecondary }} maxFontSizeMultiplier={1.4}>
              {count}
            </Text>
          </View>
          {/* Decorative: the state is already announced by accessibilityState.expanded, so a screen reader
              hearing "collapsed, chevron" would be hearing the same fact twice. */}
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{ fontSize: 12, color: theme.colors.textTertiary }}
          >
            {open ? "▲" : "▼"}
          </Text>
        </View>
      </Pressable>
      {open ? (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
          {children}
        </View>
      ) : null}
    </View>
  );
}
