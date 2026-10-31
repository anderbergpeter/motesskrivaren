import type { BatchProvider } from './types';

/** Fake provider for trying the UI without an API key. */
export const mockProvider: BatchProvider = {
  kind: 'batch',
  id: 'mock',
  label: 'Demo (ingen riktig transkribering)',
  speakerScope: 'session',
  async transcribe(_wav, ctx) {
    await new Promise((r) => setTimeout(r, 600));
    const half = ctx.durationSec / 2;
    return [
      { start: 0, end: half, speaker: '0', text: `Demotext för del ${ctx.chunkIndex + 1}, första talaren.` },
      { start: half, end: ctx.durationSec, speaker: '1', text: 'Och här svarar den andra talaren.' },
    ];
  },
};
