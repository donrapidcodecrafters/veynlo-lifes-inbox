import { Module } from "@nestjs/common";
import { VOICE_TRANSCRIBER } from "./voice-transcription.interface";
import { WhisperVoiceTranscriptionService } from "./whisper-voice-transcription.service";

/**
 * §52.1 Capture "voice note" transcription — see voice-transcription.interface.ts's doc comment for the
 * real-vs-fake split. Not `@Global()` (unlike QueueModule): only `IngestionModule` needs this today, and
 * an explicit import keeps the dependency visible rather than implicit.
 */
@Module({
  providers: [WhisperVoiceTranscriptionService, { provide: VOICE_TRANSCRIBER, useExisting: WhisperVoiceTranscriptionService }],
  exports: [VOICE_TRANSCRIBER],
})
export class SpeechModule {}
