import type { VoiceTranscriber } from "./voice-transcription.interface";

/**
 * Deterministic `VoiceTranscriber` test double, mirroring `FakeModelProvider`'s identical queue-per-call
 * shape (intelligence/fake-model-provider.ts) — real Whisper inference is slow and would make every voice-
 * note test depend on a downloaded model, exactly the reason `FakeModelProvider` exists for Anthropic
 * extraction. Queue a canned transcript (or `null`, simulating an untranscribable clip) with `enqueue()`,
 * consumed FIFO one per call; an empty queue returns `null`, matching a real transcriber's "couldn't
 * transcribe" response — never throws.
 */
export class FakeVoiceTranscriber implements VoiceTranscriber {
  private readonly queue: (string | null)[] = [];
  readonly calls: { bufferLength: number; mimeType: string }[] = [];

  enqueue(text: string | null): void {
    this.queue.push(text);
  }

  async transcribe(buffer: Buffer, mimeType: string): Promise<string | null> {
    this.calls.push({ bufferLength: buffer.length, mimeType });
    if (this.queue.length === 0) return null;
    return this.queue.shift()!;
  }
}
