import { Children, isValidElement, type ReactNode } from "react";
import { View } from "react-native";
import { useAppTheme } from "@/lib/theme-context";

/**
 * A list whose rows are visibly separate.
 *
 * Home's three modules each rendered their contents as bare `<Text>` inside a `<Card style={{ gap: 10 }}>`
 * — tasks, events and recall notices all identical, ten points of whitespace between them and nothing
 * else. On a real account that produced the screenshot Don sent: fourteen lines of continuous prose where
 * a task, an appointment and nine recall notices are indistinguishable from one another, several of them
 * wrapping to three lines so even the whitespace stops reading as a boundary.
 *
 * Whitespace alone is not a separator once rows wrap. The row height varies, the gap does not, and at that
 * point the only thing telling the reader where one item ends is the sentence itself.
 *
 * One component rather than a fix in each module, because there were three modules with the same defect and
 * fixing them separately is how they drift back apart.
 *
 * Deliberately a hairline and not a card-per-row: these are compact summary rows, and giving each its own
 * border and background would turn a glanceable list into a stack of boxes — the opposite complaint.
 */
export function DividedList({ children }: { children: ReactNode }) {
  const { theme } = useAppTheme();
  const rows = Children.toArray(children).filter((c) => isValidElement(c) || typeof c === "string");

  return (
    <View>
      {rows.map((child, i) => (
        <View
          key={i}
          style={{
            paddingVertical: 10,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: theme.colors.borderSubtle,
          }}
        >
          {child}
        </View>
      ))}
    </View>
  );
}
