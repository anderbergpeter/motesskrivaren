/** Messages between the main thread and the local (in-browser) transcription worker. */

export type WhisperSize = 'tiny' | 'base' | 'small';

export interface LocalConfig {
  size: WhisperSize;
  language: string;
  /** Cosine similarity needed to treat two voice embeddings as the same speaker. */
  speakerThreshold: number;
}

export interface LocalSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export type WorkerRequest =
  | { type: 'load'; config: LocalConfig }
  | { type: 'transcribe'; id: number; sessionId: string; config: LocalConfig; pcm: Float32Array }
  | { type: 'endSession'; sessionId: string };

export type WorkerResponse =
  | { type: 'progress'; text: string; fraction?: number }
  | { type: 'ready'; device: string; asrModel: string }
  | { type: 'result'; id: number; segments: LocalSegment[]; ms: number }
  | { type: 'error'; id?: number; message: string };

export function asrModelId(size: WhisperSize, language: string): string {
  // KB-Whisper is fine-tuned on Swedish and degrades on other languages; use the
  // multilingual OpenAI weights for everything else.
  return language === 'sv' ? `KBLab/kb-whisper-${size}` : `onnx-community/whisper-${size}`;
}

export const SPEAKER_MODEL_ID = 'Xenova/wavlm-base-plus-sv';
