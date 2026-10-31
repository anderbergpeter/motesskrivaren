import type { Segment } from '../transcript/model';

export interface ProviderSettings {
  apiKey: string;
  /** Base URL for the self-hosted server provider. */
  baseUrl?: string;
  /** Provider-specific model id override. */
  model?: string;
  language: string; // 'sv'
}

export interface ChunkContext {
  sessionId: string;
  chunkIndex: number;
  /** Seconds from session start where this chunk begins. */
  startSec: number;
  durationSec: number;
}

/** Segments returned by a provider use chunk-relative times; the pipeline shifts them. */
export type RawSegment = Omit<Segment, 'chunkIndex' | 'speakerScope'>;

export interface BatchProvider {
  kind: 'batch';
  id: string;
  label: string;
  /** Whether speaker labels are consistent across separate chunk calls. */
  speakerScope: 'session' | 'chunk';
  transcribe(wav: Blob, ctx: ChunkContext, settings: ProviderSettings): Promise<RawSegment[]>;
  /** Max duration (seconds) this provider accepts in one call for a full-file pass. */
  maxFullFileSeconds?: number;
}

export interface StreamSession {
  /** 16 kHz mono PCM. */
  sendPcm(samples: Int16Array<ArrayBuffer>): void;
  /** Flush and close; resolves when the server has sent its final results. */
  close(): Promise<void>;
}

export interface StreamProvider {
  kind: 'stream';
  id: string;
  label: string;
  speakerScope: 'session';
  connect(
    settings: ProviderSettings,
    handlers: { onSegments: (segments: RawSegment[]) => void; onError: (err: Error) => void },
  ): Promise<StreamSession>;
}

export type Provider = BatchProvider | StreamProvider;

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = true,
  ) {
    super(message);
  }
}

export async function readError(res: Response): Promise<ProviderError> {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  const retryable = res.status === 429 || res.status >= 500;
  return new ProviderError(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status, retryable);
}
