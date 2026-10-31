import { PcmChunker, type PcmChunk } from './chunker';
import { resample, rms } from './wav';

export const TARGET_RATE = 16000;

/** Inline AudioWorklet processor: forwards mono float32 frames to the main thread. */
const PROCESSOR_SOURCE = `
class PcmForwarder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // Copy, the underlying buffer is reused by the audio thread.
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('pcm-forwarder', PcmForwarder);
`;

export interface RecorderEvents {
  onChunk: (chunk: PcmChunk) => void;
  onLevel?: (level: number) => void;
  /** Called with raw 16 kHz PCM as it arrives (used by streaming providers). */
  onPcm?: (samples: Float32Array) => void;
  onError?: (err: Error) => void;
}

/**
 * Microphone recorder that produces independently decodable chunks.
 * Uses an AudioWorklet so the PCM stream is continuous; chunk boundaries are
 * cut in software, so there are no gaps between chunks (unlike restarting
 * MediaRecorder).
 */
export class Recorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private chunker: PcmChunker | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private visibilityHandler: (() => void) | null = null;

  constructor(private readonly events: RecorderEvents) {}

  get running(): boolean {
    return this.context !== null;
  }

  get elapsedSeconds(): number {
    return this.chunker?.elapsedSeconds ?? 0;
  }

  async start(chunkSeconds: number): Promise<void> {
    if (this.context) throw new Error('Inspelningen är redan igång');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      },
    });
    const context = new AudioContext();
    this.context = context;
    const blobUrl = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'application/javascript' }));
    try {
      await context.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    this.chunker = new PcmChunker(TARGET_RATE, chunkSeconds, this.events.onChunk);
    const source = context.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(context, 'pcm-forwarder', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const frame = e.data;
      this.events.onLevel?.(rms(frame));
      const down = resample(frame, context.sampleRate, TARGET_RATE);
      this.events.onPcm?.(down);
      this.chunker?.push(down);
    };
    source.connect(node);
    this.node = node;
    await context.resume();
    await this.acquireWakeLock();
  }

  /** Stop recording and flush the final partial chunk. */
  async stop(): Promise<void> {
    this.chunker?.flush();
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.context?.close().catch(() => undefined);
    this.releaseWakeLock();
    this.node = null;
    this.stream = null;
    this.context = null;
    this.chunker = null;
  }

  private async acquireWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator)) return;
    const request = async () => {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
      } catch {
        /* Wake lock is best effort (denied on low battery etc.). */
      }
    };
    await request();
    // Wake locks are released when the tab is hidden; re-acquire when visible.
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible' && this.context) void request();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private releaseWakeLock(): void {
    if (this.visibilityHandler) document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler = null;
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }
}
