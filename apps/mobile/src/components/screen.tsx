import { FlatList, ScrollView, View, useWindowDimensions, type FlatListProps, type ScrollViewProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAppTheme } from "@/lib/theme-context";

/**
 * Above this width the app is on a tablet rather than a large phone, and content should stop stretching.
 *
 * The app previously had NO width-awareness anywhere — no useWindowDimensions, no breakpoints, no
 * Platform.isPad — so every screen rendered as a full-width column with 16px of padding regardless of the
 * display. Verified on an 800dp tablet: a one-sentence savings card spanned the entire 1200px width and
 * the content filled roughly the top fifth of the screen with the rest empty. That is a phone layout
 * enlarged, not a tablet layout.
 *
 * 600dp is Android's own large-screen boundary (the sw600dp resource bucket) and is also where iPadOS
 * begins offering regular-width size classes, so it is the conventional place to change behaviour rather
 * than a number picked to fit one device.
 */
const TABLET_MIN_WIDTH = 600;

/**
 * Caps the line length rather than just widening the padding, because long lines are genuinely harder to
 * read: the eye loses its place travelling back to the start of the next line. Typographic guidance puts
 * a comfortable measure at roughly 60-75 characters, which at this app's body size lands near 720px. The
 * web app already constrains its panel width for the same reason instead of filling the viewport.
 */
const MAX_CONTENT_WIDTH = 720;

/**
 * Scrollable screen container.
 *
 * On phones this is unchanged: a full-width column with 16px padding. On tablets the content is capped at
 * a readable width, centred, and given more generous padding — so the extra space becomes margin rather
 * than stretched text.
 *
 * Deliberately NOT a multi-column or master/detail layout. That is a genuine tablet redesign and a much
 * larger piece of work; this stops every screen looking like a blown-up phone, which is the immediate
 * defect, without pretending to be that redesign.
 */
export function Screen({ children, contentContainerStyle, ...props }: ScrollViewProps) {
  const { theme } = useAppTheme();
  const { width } = useWindowDimensions();
  const isTablet = width >= TABLET_MIN_WIDTH;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bgCanvas }} edges={["top"]}>
      <ScrollView
        contentContainerStyle={[
          { padding: 16, gap: 16 },
          // alignSelf/width rather than marginHorizontal:"auto", which React Native does not support the
          // way CSS does. maxWidth alone would left-align the column and leave all the empty space on one
          // side, which looks like a rendering fault rather than a layout choice.
          isTablet && { padding: 24, width: "100%", maxWidth: MAX_CONTENT_WIDTH, alignSelf: "center" },
          contentContainerStyle,
        ]}
        keyboardShouldPersistTaps="handled"
        {...props}
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Centred, non-scrolling screen (sign-in, lock screens, and similar).
 *
 * Already centred vertically; the tablet case adds the same horizontal cap so a short form does not
 * stretch a text field across the full width of a tablet.
 */
export function CenteredScreen({ children }: { children: React.ReactNode }) {
  const { theme } = useAppTheme();
  const { width } = useWindowDimensions();
  const isTablet = width >= TABLET_MIN_WIDTH;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bgCanvas }}>
      <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
        <View style={isTablet ? { width: "100%", maxWidth: MAX_CONTENT_WIDTH, alignSelf: "center" } : undefined}>
          {children}
        </View>
      </View>
    </SafeAreaView>
  );
}

/**
 * The same screen container, but virtualised — for lists whose length is decided by the user's data.
 *
 * Zero of this app's 61 screens virtualised anything: the shared container above is a `ScrollView`, so
 * every screen mounted every row of every list at once. That is fine for a vehicle's tyres or a
 * household's members, which are bounded by what they are, and wrong for the Inbox, whose length is
 * however many things the account has ever discovered — the seed's own idea of an ordinary connection is
 * 214 items from a single year of one mailbox.
 *
 * Deliberately a SEPARATE component rather than a flag on `Screen`. A `FlatList` nested inside a
 * `ScrollView` is not merely discouraged, it silently defeats the virtualisation it was added for (React
 * Native warns about exactly this), so the two cannot be the same component with a prop. Screens that do
 * not need this keep using `Screen` and are unaffected.
 *
 * Page furniture — headings, filters, a select-all row — goes in `ListHeaderComponent`, so it scrolls
 * with the list as it did before rather than being pinned above it.
 */
export function ScreenList<ItemT>({ contentContainerStyle, ...props }: FlatListProps<ItemT>) {
  const { theme } = useAppTheme();
  const { width } = useWindowDimensions();
  const isTablet = width >= TABLET_MIN_WIDTH;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bgCanvas }} edges={["top"]}>
      <FlatList
        contentContainerStyle={[
          { padding: 16, gap: 16 },
          isTablet && { padding: 24, width: "100%", maxWidth: MAX_CONTENT_WIDTH, alignSelf: "center" },
          contentContainerStyle,
        ]}
        keyboardShouldPersistTaps="handled"
        {...props}
      />
    </SafeAreaView>
  );
}
