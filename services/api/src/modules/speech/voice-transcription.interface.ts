/**
 * §52.1 Capture "voice note" transcription — the seam between `IngestionService` and whatever
 * speech-to-text engine actually runs. `WhisperVoiceTranscriptionService` (a fully local, on-device/
 * on-server Whisper model via `@xenova/transformers` — no third-party API key, no per-call network call)
 * is the only real implementation; `FakeVoiceTranscriber` is its deterministic test double, mirroring
 * `ModelProvider`/`FakeModelProvider`'s identical shape (see intelligence/model-provider.interface.ts).
 */
export interface VoiceTranscriber {
  /**
   * Transcribes a raw audio buffer (any container/codec ffmpeg can decode — m4a/AAC, mp4, mp3, wav, webm)
   * into text, or returns null when nothing could be reliably transcribed (silence, corrupted audio, no
   * speech detected, or an infra-level failure such as the model failing to load). Never fabricates a
   * transcript — a null result must be treated as "couldn't transcribe this," never as "transcribed to
   * nothing."
   */
  transcribe(buffer: Buffer, mimeType: string): Promise<string | null>;
}

/** See queue-producer.interface.ts's identical doc comment for why an explicit DI token is needed. */
export const VOICE_TRANSCRIBER = Symbol("VOICE_TRANSCRIBER");
