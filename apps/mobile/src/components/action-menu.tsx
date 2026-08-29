import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useAppTheme } from "@/lib/theme-context";
import { Button } from "./button";

export interface ActionMenuItem {
  label: string;
  onSelect: () => void;
  tone?: "default" | "critical";
}

/**
 * A small set of secondary actions collapsed behind one "More" trigger — the primary action(s) around it
 * stay real buttons; everything else lives in this bottom sheet. Mirrors the web DropdownMenu component;
 * no action-sheet library is installed here, so this is a minimal RN Modal-based sheet rather than the
 * platform-native UIActionSheet (which also isn't available cross-platform without one).
 */
export function ActionMenu({ items }: { items: ActionMenuItem[] }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);

  if (items.length === 0) return null;

  return (
    <>
      <View style={{ flex: 1, minWidth: 90 }}>
        <Button variant="ghost" onPress={() => setOpen(true)}>
          More
        </Button>
      </View>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" }} onPress={() => setOpen(false)}>
          <Pressable
            style={{
              backgroundColor: theme.colors.bgSurface,
              borderTopLeftRadius: theme.radius.xl,
              borderTopRightRadius: theme.radius.xl,
              paddingBottom: 24,
              paddingTop: 8,
            }}
          >
            {items.map((item) => (
              <Pressable
                key={item.label}
                onPress={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                style={{ paddingHorizontal: 20, paddingVertical: 14 }}
              >
                <Text style={{ fontSize: 16, fontWeight: "500", color: item.tone === "critical" ? theme.colors.critical : theme.colors.textPrimary }}>
                  {item.label}
                </Text>
              </Pressable>
            ))}
            <Pressable onPress={() => setOpen(false)} style={{ paddingHorizontal: 20, paddingVertical: 14, marginTop: 4 }}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textSecondary }}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
