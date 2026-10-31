import type { BatchProvider, RawSegment } from '../providers/types';
import type { LocalConfig, WhisperSize, WorkerRequest, WorkerResponse } from './protocol';

export interface LocalStatus {
  text: string;
  fraction?: number;
  ready: boolean;
  device?: string;
}

type StatusListener = (s: LocalStatus) => void;
const listeners = new Set<StatusListener>();
let lastStatus: LocalStatus = { text: '', ready: false };

export function onLocalStatus(l: StatusListener): () => void {
  listeners.add(l);
  l(lastStatus);
  return () => listeners.delete(l);
}

function setStatus(s: LocalStatus): void {
  lastStatus = s;
  for (const l of listeners) l(s);
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (segs: RawSegment[]) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const m = ev.data;
    if (m.type === 'progress') setStatus({ text: m.text, fraction: m.fraction, ready: false });
    else if (m.type === 'ready') setStatus({ text: `Lokal motor redo (${m.device === 'webgpu' ? 'GPU' : 'CPU'}, ${m.asrModel.split('/')[1]})`, ready: true, device: m.device });
    else if (m.type === 'result') {
      console.info(`[lokal] del klar på ${m.ms} ms`);
      pending.get(m.id)?.resolve(m.segments);
      pending.delete(m.id);
    } else if (m.type === 'error') {
      if (m.id !== undefined) {
        pending.get(m.id)?.reject(new Error(m.message));
        pending.delete(m.id);
      } else setStatus({ text: `Lokal motor: ${m.message}`, ready: false });
    }
  };
  worker.onerror = (e) => setStatus({ text: `Lokal motor kraschade: ${e.message}`, ready: false });
  return worker;
}

function send(msg: WorkerRequest, transfer: Transferable[] = []): void {
  getWorker().postMessage(msg, transfer);
}

export function localConfig(settings: { language: string; model?: string; speakerThreshold?: number }): LocalConfig {
  const size = (['tiny', 'base', 'small'] as WhisperSize[]).includes(settings.model as WhisperSize) ? (settings.model as WhisperSize) : 'base';
  return { size, language: settings.language, speakerThreshold: settings.speakerThreshold ?? 0.75 };
}

/** Start downloading / initialising models so the first chunk is not delayed. */
export function preloadLocal(cfg: LocalConfig): void {
  send({ type: 'load', config: cfg });
}

export function endLocalSession(sessionId: string): void {
  if (worker) send({ type: 'endSession', sessionId });
}

/** Everything on the device, free, works offline once the models are cached. */
export const localProvider: BatchProvider = {
  kind: 'batch',
  id: 'local',
  label: 'I webbläsaren (gratis, KB-Whisper + lokal talarindelning)',
  speakerScope: 'session',
  maxFullFileSeconds: 0,
  async transcribe(wav, ctx, settings) {
    const buf = await wav.arrayBuffer();
    const pcm16 = new Int16Array(buf, 44, (buf.byteLength - 44) >> 1);
    const pcm = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) pcm[i] = pcm16[i] / 32768;
    const id = nextId++;
    return new Promise<RawSegment[]>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: 'transcribe', id, sessionId: ctx.sessionId, config: localConfig(settings), pcm }, [pcm.buffer]);
    });
  },
};
