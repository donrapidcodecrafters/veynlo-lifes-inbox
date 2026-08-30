import { useCallback, useState } from "react";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";

/** §CAP-006 "voice note" / Ask's voice input — the mobile half of what web already has via the browser's
 * Web Speech API. Wraps iOS `SFSpeechRecognizer`/Android `SpeechRecognizer` through expo-speech-recognition
 * — a real OS-provided capability, not a new paid transcription vendor. */
export function isVoiceCaptureSupported(): boolean {
  return ExpoSpeechRecognitionModule.isRecognitionAvailable();
}

/**
 * One real utterance per start()/stop() cycle. Deliberately doesn't lean on this library's own
 * `continuous` option for a longer multi-utterance session — iOS/Android's underlying recognizers
 * finalize very differently under it (unlike a browser's `SpeechRecognition`, which keeps producing new
 * cumulative results in one session). A caller that wants a longer voice note just calls `start()` again
 * after each result and appends the new transcript to whatever text it already has — see Inbox's
 * voice-note capture mode.
 */
export function useVoiceCapture(onFinalResult: (transcript: string) => void) {
  const [listening, setListening] = useState(false);

  useSpeechRecognitionEvent("start", () => setListening(true));
  useSpeechRecognitionEvent("end", () => setListening(false));
  useSpeechRecognitionEvent("error", () => setListening(false));
  useSpeechRecognitionEvent("result", (event) => {
    if (!event.isFinal) return;
    const transcript = event.results[0]?.transcript?.trim();
    if (transcript) onFinalResult(transcript);
  });

  const start = useCallback(async () => {
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) return;
    ExpoSpeechRecognitionModule.start({ lang: "en-US", interimResults: false, continuous: false });
  }, []);

  const stop = useCallback(() => {
    ExpoSpeechRecognitionModule.stop();
  }, []);

  return { listening, start, stop };
}
