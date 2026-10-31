/**
 * Accumulates 16 kHz float32 PCM and emits fixed-length chunks.
 * Pure logic, no Web Audio dependency, so it is unit-testable.
 */
export interface PcmChunk {
  /** Zero-based chunk index within the session. */
  index: number;
  /** Offset of the chunk start from session start, in seconds. */
  startSec: number;
  /** Duration in seconds. */
  durationSec: number;
  samples: Float32Array;
}

export class PcmChunker {
  private buffers: Float32Array[] = [];
  private buffered = 0;
  private emitted = 0;
  private totalSamples = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly chunkSeconds: number,
    private readonly onChunk: (chunk: PcmChunk) => void,
  ) {}

  get chunkSamples(): number {
    return Math.round(this.sampleRate * this.chunkSeconds);
  }

  push(samples: Float32Array): void {
    this.buffers.push(samples);
    this.buffered += samples.length;
    this.totalSamples += samples.length;
    while (this.buffered >= this.chunkSamples) this.emit(this.chunkSamples);
  }

  /** Emit whatever is left (end of session). Returns false if nothing was pending. */
  flush(): boolean {
    if (this.buffered === 0) return false;
    this.emit(this.buffered);
    return true;
  }

  get elapsedSeconds(): number {
    return this.totalSamples / this.sampleRate;
  }

  private emit(count: number): void {
    const out = new Float32Array(count);
    let filled = 0;
    while (filled < count) {
      const head = this.buffers[0];
      const take = Math.min(head.length, count - filled);
      out.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) this.buffers.shift();
      else this.buffers[0] = head.subarray(take);
    }
    this.buffered -= count;
    const startSamples = this.emitted * this.chunkSamples;
    this.onChunk({
      index: this.emitted,
      startSec: startSamples / this.sampleRate,
      durationSec: count / this.sampleRate,
      samples: out,
    });
    this.emitted += 1;
  }
}
