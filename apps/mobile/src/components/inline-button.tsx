import { Pressable, Text } from "react-native";
import { useAppTheme } from "@/lib/theme-context";

type Tone = "brand" | "critical" | "neutral";

interface InlineButtonProps {
  children: string;
  onPress: () => void;
  tone?: Tone;
  disabled?: boolean;
  /** Overrides the spoken label — the visible text is used otherwise. Needed when several controls share
   * the same word ("Remove", "Edit") and only their surrounding row says what they act on. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

/**
 * A small action rendered inside a row — "Edit", "Remove", "Rotate", "Mark done".
 *
 * These existed all over the app as a bare `Pressable` wrapping coloured `Text`, which meant a button
 * that looked exactly like a label. Nothing but colour said it could be pressed, and colour alone is not
 * an affordance (it is also the one cue a colour-blind user does not get). Every one of them now draws a
 * border.
 *
 * Deliberately NOT the full `Button`: that one is 48px tall with 16px text, which is right for a primary
 * action at the bottom of a form and far too heavy sitting beside a tyre in a list. This keeps the small
 * visual weight those rows need while still being unmistakably a control.
 *
 * The touch target stays a comfortable size regardless: the box is 32px tall, and `hitSlop` extends the
 * pressable area past the border to clear the 44px minimum without the border growing to match.
 */
export function InlineButton({
  children,
  onPress,
  tone = "brand",
  disabled,
  accessibilityLabel,
  accessibilityHint,
}: InlineButtonProps) {
  const { theme } = useAppTheme();
  const color =
    tone === "critical" ? theme.colors.critical : tone === "neutral" ? theme.colors.textSecondary : theme.colors.brandDefault;
  // The border is the action's own colour, softened, so a destructive action still reads as destructive
  // without a heavy red box shouting in the middle of a list.
  const borderColor = tone === "neutral" ? theme.colors.borderDefault : color;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? children}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        paddingVertical: 6,
        paddingHorizontal: 12,
        minHeight: 32,
        justifyContent: "center",
        borderRadius: 999,
        borderWidth: 1,
        borderColor,
        backgroundColor: "transparent",
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontSize: 13, fontWeight: "600", color }} maxFontSizeMultiplier={1.6}>
        {children}
      </Text>
    </Pressable>
  );
}
