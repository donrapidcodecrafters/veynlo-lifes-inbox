import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Injectable, Logger } from "@nestjs/common";
import ffmpegPath from "ffmpeg-static";
import type { VoiceTranscriber } from "./voice-transcription.interface";

const execFileAsync = promisify(execFile);

// A 15-minute mono 16kHz s16le clip — this app's own MAX_VOICE_NOTE_BYTES ceiling
// (ingestion.service.ts), fully decoded — is ~28.8MB; generous headroom over that so a full-length
// recording's decoded PCM is never silently truncated by execFile's own stdout buffer cap.
const MAX_DECODED_PCM_BYTES = 64 * 1024 * 1024;

// Giving ffmpeg's demuxer a real extension helps it pick the right container parser when the bytes alone
// are ambiguous; matches ALLOWED_VOICE_NOTE_MIME_TYPES in ingestion.service.ts.
const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "audio/m4a": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/aac": ".aac",
};

/**
 * §52.1 Capture "voice note" transcription — real, local speech-to-text via a quantized Whisper model
 * (`Xenova/whisper-tiny.en`, ~40MB) run entirely on-CPU through `@xenova/transformers` (a pure JS/WASM ONNX
 * runtime port of Hugging Face `transformers`). Deliberately NOT Anthropic's Messages API — it has no
 * audio-input content block, so there is no real Claude call this could be (see the git history of
 * `IngestionService.ingestVoiceNote`'s doc comment for the prior "deliberately deferred" reasoning). This
 * needs no paid API key or third-party account — only a one-time model-weight download from Hugging Face on
 * first use, cached under `resolveCacheDir()` afterward. A production deployment with no outbound network
 * access to huggingface.co needs that cache pre-seeded (e.g. baked into the deploy image, or
 * `VOICE_TRANSCRIPTION_MODEL_CACHE_DIR` pointed at a volume seeded ahead of time) before the first real
 * voice note arrives — see docs/ROADMAP.md's voice-transcription entry for the full operational note.
 *
 * Mobile records m4a/AAC (expo-audio's default); Whisper needs raw 16kHz mono PCM. `ffmpeg-static` (a
 * bundled, statically-linked ffmpeg binary — no system ffmpeg install required) does that decode.
 */
@Injectable()
export class WhisperVoiceTranscriptionService implements VoiceTranscriber {
  private readonly logger = new Logger(WhisperVoiceTranscriptionService.name);
  // Loading the model (weights download-or-read-from-cache + ONNX session init) takes real time — cached
  // as a single in-flight/completed promise so concurrent voice notes share one load rather than each
  // racing to load their own copy, and so a later call is instant once the first has resolved.
  private pipelinePromise: ReturnType<typeof WhisperVoiceTranscriptionService.loadPipeline> | null = null;

  private static async loadPipeline() {
    // Dynamic import — @xenova/transformers is a substantial dependency (ONNX runtime + model-loading
    // machinery) with zero reason to pay its module-init cost for every process that imports
    // IngestionService/SpeechModule, the overwhelming majority of which (every HTTP request handler, most
    // tests) never transcribes a single voice note.
    const { pipeline, env } = await import("@xenova/transformers");
    env.cacheDir = resolveCacheDir();
    env.allowLocalModels = false;
    return pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", { quantized: true });
  }

  private getPipeline() {
    if (!this.pipelinePromise) this.pipelinePromise = WhisperVoiceTranscriptionService.loadPipeline();
    return this.pipelinePromise;
  }

  async transcribe(buffer: Buffer, mimeType: string): Promise<string | null> {
    try {
      const pcm = await decodeToMonoPcm16k(buffer, mimeType);
      if (pcm.length === 0) return null;
      const transcriber = await this.getPipeline();
      const result = await transcriber(pcm);
      const text = (Array.isArray(result) ? result[0]?.text : result.text)?.trim();
      return text ? text : null;
    } catch (err) {
      // Covers both a genuinely untranscribable clip (corrupted audio ffmpeg can't decode, an empty/silent
      // recording) and an infra-level failure (model weights failed to download, ffmpeg binary missing) —
      // IngestionService.processVoiceTranscription treats a thrown error and a null return identically
      // (leaves the source event as a raw, playable recording rather than fabricating a transcript), so
      // there's no correctness reason to distinguish them further here; this log line is what an operator
      // would actually look at to tell the two apart.
      this.logger.warn(`Voice transcription failed: ${String((err as Error)?.message ?? err)}`);
      return null;
    }
  }
}

function resolveCacheDir(): string {
  return process.env.VOICE_TRANSCRIPTION_MODEL_CACHE_DIR || path.join(homedir(), ".cache", "veynlo", "transformers");
}

async function decodeToMonoPcm16k(buffer: Buffer, mimeType: string): Promise<Float32Array> {
  if (!ffmpegPath) throw new Error("ffmpeg binary not found (ffmpeg-static)");
  const dir = await mkdtemp(path.join(tmpdir(), "veynlo-voice-"));
  const inputPath = path.join(dir, `input${EXTENSION_BY_MIME_TYPE[mimeType] ?? ""}`);
  try {
    await writeFile(inputPath, buffer);
    const { stdout } = await execFileAsync(ffmpegPath, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"], {
      encoding: "buffer",
      maxBuffer: MAX_DECODED_PCM_BYTES,
    });
    const samples = new Float32Array(stdout.length / 2);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = stdout.readInt16LE(i * 2) / 32768;
    }
    return samples;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
