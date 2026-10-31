import { describe, expect, it } from 'vitest';
import { PcmChunker, type PcmChunk } from './chunker';
import { encodeWav, floatToInt16, resample } from './wav';

describe('PcmChunker', () => {
  it('emits fixed-size chunks with correct offsets and no lost samples', () => {
    const chunks: PcmChunk[] = [];
    const chunker = new PcmChunker(100, 1, (c) => chunks.push(c));
    // 350 samples pushed in uneven frames
    const frames = [30, 90, 100, 60, 70];
    let value = 0;
    for (const n of frames) {
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = value++;
      chunker.push(f);
    }
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.startSec)).toEqual([0, 1, 2]);
    expect(chunks.every((c) => c.durationSec === 1)).toBe(true);
    // Sample continuity across chunk boundaries
    expect(chunks[1].samples[0]).toBe(100);
    expect(chunks[2].samples[99]).toBe(299);
    expect(chunker.flush()).toBe(true);
    expect(chunks[3].durationSec).toBeCloseTo(0.5);
    expect(chunks[3].startSec).toBe(3);
    expect(chunks[3].samples[0]).toBe(300);
    expect(chunker.flush()).toBe(false);
  });
});

describe('wav helpers', () => {
  it('resamples 48k to 16k with the expected length', () => {
    const out = resample(new Float32Array(4800), 48000, 16000);
    expect(out.length).toBe(1600);
  });

  it('writes a valid 44-byte WAV header', async () => {
    const blob = encodeWav(floatToInt16(new Float32Array([0, 0.5, -0.5, 1, -1])), 16000);
    expect(blob.size).toBe(44 + 10);
    const buf = new DataView(await blob.arrayBuffer());
    expect(String.fromCharCode(buf.getUint8(0), buf.getUint8(1), buf.getUint8(2), buf.getUint8(3))).toBe('RIFF');
    expect(buf.getUint32(24, true)).toBe(16000);
    expect(buf.getInt16(44 + 6, true)).toBe(32767);
    expect(buf.getInt16(44 + 8, true)).toBe(-32768);
  });
});
