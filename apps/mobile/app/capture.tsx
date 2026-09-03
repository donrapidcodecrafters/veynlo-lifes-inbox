import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Button } from "@/components/button";

/** Mirrors documents.controller.ts's own VALID_DOCUMENT_TYPES set of accepted upload mimeTypes — a
 * shared image/file the extension can't confidently map falls through to `null`, surfaced as a clear
 * "unsupported file type" error rather than a guessed-wrong mimeType silently failing magic-byte
 * validation server-side. */
function guessMimeType(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "heic":
      return "image/heic";
    case "txt":
      return "text/plain";
    default:
      return null;
  }
}

/**
 * Landing spot for the `veynlo://capture` deep link the iOS Share Extension opens
 * (src/share-extension.tsx) — the extension itself has no access to this app's Keychain-stored session,
 * so it hands the captured text off here instead, where the user is already signed in.
 */
export default function CaptureScreen() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ subject?: string; body?: string; filePath?: string; mimeType?: string; fileName?: string }>();
  const [state, setState] = useState<"submitting" | "done" | "error">("submitting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // §MSG-001 — a shared screenshot now lands in the Inbox (classified into a real task/event/note/etc.),
  // not the Documents vault; a shared PDF/other file still goes to Documents. Determines the "done" copy
  // and the "go to ___" button target below.
  const [destination, setDestination] = useState<"documents" | "inbox">("inbox");
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;
    const subject = params.subject?.trim();
    const filePath = params.filePath?.trim();

    if (filePath) {
      // A mimeType handed to us directly (Android's share intent module reports it from the actual
      // content resolver, not a filename guess) is trusted over the filename-extension fallback iOS's
      // deep-link handoff has to use instead, since App-Group file paths there carry no query-string
      // metadata of their own beyond the path.
      const mimeType = params.mimeType?.trim() || guessMimeType(filePath);
      if (!mimeType) {
        setState("error");
        setErrorMessage("That file type isn't supported yet. Try a PDF, JPG, PNG, or HEIC.");
        return;
      }
      const fileName = params.fileName?.trim() || filePath.split("/").pop() || "shared-file";
      // §MSG-001 "Share-message extraction" — a shared IMAGE goes through the classification pipeline
      // (OCR'd text is classified into date/task/event/address/purchase/recommendation/person/note and
      // routed into the matching real domain object — see IngestionService.ingestShareScreenshot), not
      // plain generic document storage; a shared PDF/other file (not a screenshot) still goes to the
      // Documents vault unchanged, since MSG-001 is specifically about a shared conversation fragment.
      const isImageShare = mimeType.startsWith("image/");
      setDestination(isImageShare ? "inbox" : "documents");
      (isImageShare
        ? api.upload("/v1/ingestion/share-screenshot", {}, { uri: filePath, name: fileName, type: mimeType })
        : api.upload("/v1/documents/upload", { title: subject || "Shared file", documentType: "other" }, { uri: filePath, name: fileName, type: mimeType })
      )
        .then(() => setState("done"))
        .catch((err) => {
          setState("error");
          setErrorMessage(err instanceof ApiError ? err.message : "Couldn't save that file. Please try again.");
        });
      return;
    }

    const bodyText = params.body?.trim();
    if (!subject || !bodyText) {
      setState("error");
      setErrorMessage("Nothing was shared.");
      return;
    }
    api
      // §MSG-001 — marks this as a deliberate OS share-sheet capture (SourceEventKindSchema's
      // "share_capture") rather than the indistinguishable default "manual_entry" kind a typed-in-app
      // entry gets, since this screen only ever runs at the end of the iOS Share Extension / Android
      // share-intent handoff.
      .post("/v1/ingestion/manual", { subject, bodyText, kind: "share_capture" })
      .then(() => setState("done"))
      .catch((err) => {
        setState("error");
        setErrorMessage(err instanceof ApiError ? err.message : "Couldn't save that. Please try again.");
      });
  }, [params.subject, params.body, params.filePath, params.mimeType, params.fileName]);

  return (
    <Screen>
      <ScreenHeader title="Save to Veynlo" />
      <View style={{ alignItems: "center", gap: 12, paddingVertical: 24 }}>
        {state === "submitting" && <Text style={{ color: theme.colors.textTertiary }}>Saving what you shared…</Text>}
        {state === "done" && (
          <Text style={{ color: theme.colors.textPrimary, fontWeight: "600" }}>
            {destination === "documents" ? "Saved — it'll show up in your Documents." : "Saved — it'll show up in your Inbox."}
          </Text>
        )}
        {state === "error" && <Text style={{ color: theme.colors.critical }}>{errorMessage}</Text>}
        <Button variant="secondary" onPress={() => router.replace(destination === "documents" ? "/documents" : "/(tabs)/inbox")}>
          {destination === "documents" ? "Go to Documents" : "Go to Inbox"}
        </Button>
      </View>
    </Screen>
  );
}
